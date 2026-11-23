import { describe, it, expect } from 'vitest';
import {
  sanitizeFileName,
  sanitizeFolderName,
  validateFileSizeAndBasics,
  validateImageMagicBytes,
  parseAndValidateGeminiResponse,
  MAX_IMAGE_FILE_SIZE_BYTES
} from '../utils/securityUtils';
import {
  copyAndProcessJpegExif,
  sanitizeExifApp1Segment
} from '../utils/exifUtils';
import {
  classifyScene,
  calculateSceneScore,
  pairImportedFiles
} from '../utils/imageAnalyzer';
import {
  groupPhotosBySimilarity,
  recalculateGroupWithScene
} from '../utils/groupingEngine';
import { PhotoItem, RawImageMetrics } from '../types';

describe('1. Security: Path Traversal (Zip Slip) & Filename Sanitization', () => {
  it('blocks Unix and Windows directory traversal sequences', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\..\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFileName('/var/www/html/shell.jpg')).toBe('shell.jpg');
    expect(sanitizeFileName('....//....//secret.JPG')).toBe('secret.JPG');
  });

  it('strips NULL bytes and control characters', () => {
    expect(sanitizeFileName('photo\x00.jpg.exe')).toBe('photo.jpg.exe');
    expect(sanitizeFileName('DSC\r\n001\t.JPG')).toBe('DSC001.JPG');
  });

  it('neutralizes Windows reserved device filenames', () => {
    expect(sanitizeFileName('CON.jpg')).toBe('_CON.jpg');
    expect(sanitizeFileName('nul.ARW')).toBe('_nul.ARW');
    expect(sanitizeFileName('COM1.png')).toBe('_COM1.png');
    expect(sanitizeFileName('LPT9')).toBe('_LPT9');
  });

  it('truncates excessively long filenames while preserving extension', () => {
    const longName = 'A'.repeat(250) + '.JPG';
    const safe = sanitizeFileName(longName);
    expect(safe.length).toBe(200);
    expect(safe.endsWith('.JPG')).toBe(true);
  });

  it('sanitizes folder names against traversal and reserved names', () => {
    expect(sanitizeFolderName('../../evil_folder')).toBe('evil_folder');
    expect(sanitizeFolderName('2026/11/23:イベント*?"<>|')).toBe('2026_11_23_イベント');
    expect(sanitizeFolderName('CON')).toBe('_CON');
    expect(sanitizeFolderName('...')).toBe('BestBout_Export');
  });
});

describe('2. Security: File Magic Bytes & DoS Size Validation', () => {
  it('accepts valid JPEG, PNG, WebP, and HEIC signatures', async () => {
    const jpegFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10])], 'a.jpg');
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'b.png');
    const webpFile = new File(
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
      'c.webp'
    );
    const heicFile = new File(
      [new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
      'd.heic'
    );

    expect(await validateImageMagicBytes(jpegFile)).toBe(true);
    expect(await validateImageMagicBytes(pngFile)).toBe(true);
    expect(await validateImageMagicBytes(webpFile)).toBe(true);
    expect(await validateImageMagicBytes(heicFile)).toBe(true);
  });

  it('rejects disguised HTML/XSS script or executable files renamed to .jpg', async () => {
    const htmlInJpg = new File(['<script>alert("xss")</script>'], 'exploit.jpg', {
      type: 'image/jpeg'
    });
    const exeInJpg = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])], 'malware.jpg');
    const tinyFile = new File([new Uint8Array([0xff, 0xd8])], 'truncated.jpg');

    expect(await validateImageMagicBytes(htmlInJpg)).toBe(false);
    expect(await validateImageMagicBytes(exeInJpg)).toBe(false);
    expect(await validateImageMagicBytes(tinyFile)).toBe(false);
  });

  it('blocks 0-byte files and files exceeding DoS size limits', () => {
    const emptyFile = new File([], 'empty.jpg');
    expect(validateFileSizeAndBasics(emptyFile).valid).toBe(false);

    const fakeGiantFile = { name: 'giant.jpg', size: MAX_IMAGE_FILE_SIZE_BYTES + 1024 } as File;
    expect(validateFileSizeAndBasics(fakeGiantFile, false).valid).toBe(false);
  });
});

describe('3. Security: Binary Exif GPS Stripper & Malformed JPEG Fuzzing', () => {
  /**
   * テスト用のAPP1 Exifセグメント（Little Endian "II"）を構築するヘルパー
   * - Entry 0: Orientation (0x0112) = 6
   * - Entry 1: GPSInfoIFDPointer (0x8825) -> offset 38 (GPSサブIFD)
   */
  function buildTestExifApp1Segment(): Uint8Array {
    const buf = new ArrayBuffer(96);
    const view = new DataView(buf);
    // APP1 Marker FF E1 + length 94
    view.setUint16(0, 0xffe1, false);
    view.setUint16(2, 94, false);
    // "Exif\0\0"
    view.setUint32(4, 0x45786966, false);
    view.setUint16(8, 0x0000, false);

    const tiff = 10;
    view.setUint16(tiff, 0x4949, false); // "II" Little Endian
    view.setUint16(tiff + 2, 0x002a, true);
    view.setUint32(tiff + 4, 8, true); // IFD0 starts at tiff + 8 = 18

    const ifd0 = tiff + 8; // index 18
    view.setUint16(ifd0, 2, true); // 2 entries

    // Entry 0 (index 20..31): Orientation (0x0112), SHORT(3), count 1, value 6
    view.setUint16(20, 0x0112, true);
    view.setUint16(22, 3, true);
    view.setUint32(24, 1, true);
    view.setUint16(28, 6, true);

    // Entry 1 (index 32..43): GPSInfoIFDPointer (0x8825), LONG(4), count 1, offset 40 (tiff + 40 = 50)
    view.setUint16(32, 0x8825, true);
    view.setUint16(34, 4, true);
    view.setUint32(36, 1, true);
    view.setUint32(40, 40, true);

    // GPS Sub-IFD at index 50 (tiff + 40)
    view.setUint16(50, 1, true); // 1 GPS entry
    // GPSLatitude (0x0002), RATIONAL(5), count 3 (24 bytes) -> external offset 60 (tiff + 60 = 70)
    view.setUint16(52, 0x0002, true);
    view.setUint16(54, 5, true);
    view.setUint32(56, 3, true);
    view.setUint32(60, 60, true);

    // Coordinate secret payload at index 70..93
    for (let i = 70; i < 94; i++) {
      view.setUint8(i, 0xaa);
    }

    return new Uint8Array(buf);
  }

  it('completely scrubs GPS pointer, GPS IFD, and external GPS coordinates while resetting Orientation', () => {
    const rawSeg = buildTestExifApp1Segment();
    const sanitized = sanitizeExifApp1Segment(rawSeg, {
      stripGps: true,
      resetOrientation: true
    });
    const view = new DataView(sanitized.buffer, sanitized.byteOffset, sanitized.byteLength);

    // Orientation (index 28) should be reset from 6 to 1
    expect(view.getUint16(28, true)).toBe(1);

    // GPS tag (index 32) should be zeroed to 0x0000 and pointer (index 40) zeroed
    expect(view.getUint16(32, true)).toBe(0x0000);
    expect(view.getUint32(40, true)).toBe(0);

    // External GPS coordinates at index 70..93 should all be wiped to 0x00
    for (let i = 70; i < 94; i++) {
      expect(view.getUint8(i)).toBe(0);
    }
  });

  it('survives malformed JPEG with 0-length segment without infinite loop', async () => {
    // FF D8 (SOI), FF E1 00 00 (Malformed 0-length APP1), FF D9 (EOI)
    const malformedJpeg = new Blob([
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xd9])
    ]);
    const targetJpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);

    const res = await copyAndProcessJpegExif(malformedJpeg, targetJpeg, {
      stripGps: true,
      resetOrientation: true
    });
    expect(res.size).toBe(4);
  });

  it('survives malicious TIFF header with out-of-bounds IFD offset and huge entryCount (0xFFFF)', () => {
    const seg = buildTestExifApp1Segment();
    const view = new DataView(seg.buffer);
    // Set entryCount to 65535 (0xFFFF) and GPS offset pointing backwards into IFD0
    view.setUint16(18, 0xffff, true);
    view.setUint32(40, 8, true); // points directly to IFD0 start!

    expect(() =>
      sanitizeExifApp1Segment(seg, { stripGps: true, resetOrientation: true })
    ).not.toThrow();
  });
});

describe('4. Security: Gemini API JSON Validation', () => {
  it('parses markdown-fenced JSON, clamps out-of-bounds bestIndex, and strips control chars', () => {
    const raw = '```json\n{"scene":"人物\\u0000","bestIndex":99,"reason":"瞳にピント\\u0007","runnerUpNote":"2枚目は半目"}\n```';
    const res = parseAndValidateGeminiResponse(raw, 3);
    expect(res.bestIndex).toBe(0); // 99 is out of range for 3 candidates -> clamped to 0
    expect(res.scene).toBe('人物');
    expect(res.reason).toBe('瞳にピント');
  });

  it('rejects non-object JSON payloads', () => {
    expect(() => parseAndValidateGeminiResponse('[1,2,3]', 3)).toThrow();
  });
});

describe('5. Core Accuracy: Portrait Detection, Blink Penalty, & Grouping', () => {
  const baseMetrics: RawImageMetrics = {
    globalSharpness: 75,
    centerSharpness: 78,
    faceRegionSharpness: 84,
    eyeRegionSharpness: 88,
    faceCount: 1,
    faceAreaRatio: 0.008, // 全身ポートレート等の小顔でもMediaPipeが検出した場合
    eyeOpenScore: 86,
    isBlinking: false,
    smileOrFrontalScore: 84,
    faceExposureScore: 85,
    skinToneRatio: 0.02,
    whiteBgRatio: 0.1,
    textEdgeDensity: 10,
    warmColorRatio: 0.15,
    saturationMean: 30,
    brightnessMean: 52,
    overExposedRatio: 0.01,
    underExposedRatio: 0.01,
    contrastScore: 76,
    horizonStraightness: 85
  };

  it('classifies full-body or close-up shots with detected face as portrait, and never misclassifies warm food without face as portrait', () => {
    expect(classifyScene(baseMetrics)).toBe('portrait');

    const warmFoodNoFace: RawImageMetrics = {
      ...baseMetrics,
      faceCount: 0,
      faceAreaRatio: 0,
      skinToneRatio: 0.35, // 木目や暖色料理で肌色比率が高くても顔未検出ならportraitにしない
      warmColorRatio: 0.35,
      centerSharpness: 85,
      globalSharpness: 70
    };
    expect(classifyScene(warmFoodNoFace)).toBe('food');
  });

  it('penalizes blinking shots in a portrait burst and selects the sharp open-eye shot as #1', () => {
    const makePhoto = (id: string, tsOffset: number, overrides: Partial<RawImageMetrics>): PhotoItem => {
      const m = { ...baseMetrics, ...overrides };
      const scene = classifyScene(m);
      return {
        id,
        file: new File([''], `${id}.JPG`),
        fileName: `${id}.JPG`,
        baseName: id,
        thumbnailUrl: '',
        thumbnailWidth: 1024,
        thumbnailHeight: 683,
        exif: { timestamp: 1700000000000 + tsOffset, width: 8640, height: 5760, hasGps: false },
        dHash: '10101010'.repeat(8),
        colorHist: new Array(48).fill(1 / 16),
        metrics: m,
        scene,
        score: calculateSceneScore(scene, m)
      };
    };

    const blinkShot = makePhoto('DSC001', 0, {
      eyeOpenScore: 36,
      isBlinking: true,
      eyeRegionSharpness: 85
    });
    const bestOpenShot = makePhoto('DSC002', 300, {
      eyeOpenScore: 88,
      isBlinking: false,
      eyeRegionSharpness: 89
    });
    const softShot = makePhoto('DSC003', 600, {
      eyeOpenScore: 84,
      isBlinking: false,
      eyeRegionSharpness: 68,
      faceRegionSharpness: 65
    });

    const groups = groupPhotosBySimilarity([blinkShot, bestOpenShot, softShot], 50, 5.0);
    expect(groups.length).toBe(1);
    expect(groups[0].scene).toBe('portrait');
    // DSC002 (open eyes & sharp pupils) must be ranked #1
    expect(groups[0].photos[0].id).toBe('DSC002');
    expect(groups[0].selectedIds).toEqual(['DSC002']);
    // Blink shot must have lower score than best shot by > 10 points
    const blinkInGroup = groups[0].photos.find((p) => p.id === 'DSC001')!;
    expect(groups[0].photos[0].score.total - blinkInGroup.score.total).toBeGreaterThan(10);

    // Manual scene recalculation test
    const reScoredAsLandscape = recalculateGroupWithScene(groups[0], 'landscape', 5.0);
    expect(reScoredAsLandscape.scene).toBe('landscape');
  });

  it('pairs RAW (.ARW) and JPEG files while sanitizing filenames', () => {
    const jpg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'DSC01234.JPG');
    const arw = new File([new Uint8Array([0x49, 0x49, 0x2a, 0x00])], 'DSC01234.ARW');
    const paired = pairImportedFiles([jpg, arw], true);
    expect(paired.length).toBe(1);
    expect(paired[0].baseName).toBe('DSC01234');
    expect(paired[0].rawFile).toBeDefined();
  });
});
