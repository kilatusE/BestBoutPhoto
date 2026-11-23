import { PhotoItem, RawImageMetrics, SceneType, ScoreBreakdown } from '../types';
import { extractExif } from './exifUtils';
import { analyzeFacesOnCanvas, PortraitAnalysisResult } from './faceDetector';
import {
  sanitizeFileName,
  validateFileSizeAndBasics,
  validateImageMagicBytes
} from './securityUtils';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif']);
const RAW_EXTENSIONS = new Set(['arw', 'cr2', 'cr3', 'nef', 'nrw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw']);

export interface PairedFileEntry {
  baseName: string;
  imageFile: File;
  rawFile?: File;
}

export function pairImportedFiles(files: File[], enableRawPairing: boolean): PairedFileEntry[] {
  const imageMap = new Map<string, File>();
  const rawMap = new Map<string, File>();
  const standaloneImages: PairedFileEntry[] = [];

  for (const file of files) {
    if (!file || !file.name || file.name.startsWith('.')) continue;
    const safeName = sanitizeFileName(file.name, '');
    if (!safeName) continue;
    const dotIdx = safeName.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const baseName = safeName.slice(0, dotIdx);
    const ext = safeName.slice(dotIdx + 1).toLowerCase();
    const key = baseName.toLowerCase();

    if (IMAGE_EXTENSIONS.has(ext)) {
      if (validateFileSizeAndBasics(file, false).valid) {
        imageMap.set(key, file);
      }
    } else if (RAW_EXTENSIONS.has(ext)) {
      if (validateFileSizeAndBasics(file, true).valid) {
        rawMap.set(key, file);
      }
    }
  }

  for (const [key, imageFile] of imageMap.entries()) {
    const safeImgName = sanitizeFileName(imageFile.name);
    const dotIdx = safeImgName.lastIndexOf('.');
    const baseName = dotIdx > 0 ? safeImgName.slice(0, dotIdx) : safeImgName;
    const rawFile = enableRawPairing ? rawMap.get(key) : undefined;
    standaloneImages.push({
      baseName,
      imageFile,
      rawFile
    });
  }

  return standaloneImages;
}

export async function analyzePhotoEntry(
  entry: PairedFileEntry,
  index: number
): Promise<PhotoItem> {
  const { imageFile, rawFile, baseName } = entry;

  // マジックバイト検証（拡張子偽装ファイルや破損ヘッダーを事前排除）
  const isValidMagic = await validateImageMagicBytes(imageFile);
  if (!isValidMagic) {
    throw new Error(`非対応または破損した画像ファイルです: ${ sanitizeFileName(imageFile.name) }`);
  }

  const [exifFromHeader, thumbResult] = await Promise.all([
    extractExif(imageFile),
    createThumbnailAndAnalysisData(imageFile, 1024)
  ]);

  const exif = {
    ...exifFromHeader,
    width: exifFromHeader.width || thumbResult.originalWidth,
    height: exifFromHeader.height || thumbResult.originalHeight
  };

  const scene = classifyScene(thumbResult.metrics);
  const score = calculateSceneScore(scene, thumbResult.metrics);
  const safeFileName = sanitizeFileName(imageFile.name);
  const safeRawName = rawFile ? sanitizeFileName(rawFile.name, `${baseName}.ARW`) : undefined;

  return {
    id: `photo_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    file: imageFile,
    fileName: safeFileName,
    baseName,
    rawFile,
    rawFileName: safeRawName,
    thumbnailUrl: thumbResult.thumbnailUrl,
    thumbnailWidth: thumbResult.thumbWidth,
    thumbnailHeight: thumbResult.thumbHeight,
    exif,
    dHash: thumbResult.dHash,
    colorHist: thumbResult.colorHist,
    metrics: thumbResult.metrics,
    scene,
    score
  };
}

interface ThumbnailAnalysisResult {
  thumbnailUrl: string;
  thumbWidth: number;
  thumbHeight: number;
  originalWidth: number;
  originalHeight: number;
  dHash: string;
  colorHist: number[];
  metrics: RawImageMetrics;
}

async function createThumbnailAndAnalysisData(
  file: File,
  maxThumbDim = 1024
): Promise<ThumbnailAnalysisResult> {
  let originalWidth = 0;
  let originalHeight = 0;
  let thumbWidth = 0;
  let thumbHeight = 0;

  const thumbCanvas = document.createElement('canvas');
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;
  let portraitResult: PortraitAnalysisResult;

  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file);
    originalWidth = bitmap.width;
    originalHeight = bitmap.height;
    const scale = Math.min(1, maxThumbDim / Math.max(originalWidth, originalHeight));
    thumbWidth = Math.max(1, Math.round(originalWidth * scale));
    thumbHeight = Math.max(1, Math.round(originalHeight * scale));
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    thumbCtx.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);

    // フル解像度bitmapを破棄する直前に、検出された瞳・顔領域のみフル解像度(1:1等倍)でピント計測
    portraitResult = await analyzeFacesOnCanvas(
      thumbCanvas,
      bitmap,
      originalWidth,
      originalHeight
    );
    bitmap.close();
  } else {
    const img = await loadImageElement(file);
    originalWidth = img.naturalWidth || img.width;
    originalHeight = img.naturalHeight || img.height;
    const scale = Math.min(1, maxThumbDim / Math.max(originalWidth, originalHeight));
    thumbWidth = Math.max(1, Math.round(originalWidth * scale));
    thumbHeight = Math.max(1, Math.round(originalHeight * scale));
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    thumbCtx.drawImage(img, 0, 0, thumbWidth, thumbHeight);

    portraitResult = await analyzeFacesOnCanvas(
      thumbCanvas,
      img,
      originalWidth,
      originalHeight
    );
  }

  // 1. サムネイルBlob URL生成
  const thumbBlob = await new Promise<Blob>((resolve) => {
    thumbCanvas.toBlob((b) => resolve(b || new Blob()), 'image/jpeg', 0.85);
  });

  const thumbnailUrl = URL.createObjectURL(thumbBlob);

  // 2. dHash (64bit)
  const dHash = computeDHash(thumbCanvas);

  // 3. 全体統計・色ヒストグラム解析（長辺256px）
  const analysisScale = Math.min(1, 256 / Math.max(thumbWidth, thumbHeight));
  const aW = Math.max(32, Math.round(thumbWidth * analysisScale));
  const aH = Math.max(32, Math.round(thumbHeight * analysisScale));
  const aCanvas = document.createElement('canvas');
  aCanvas.width = aW;
  aCanvas.height = aH;
  const aCtx = aCanvas.getContext('2d', { willReadFrequently: true })!;
  aCtx.drawImage(thumbCanvas, 0, 0, aW, aH);
  const imgData = aCtx.getImageData(0, 0, aW, aH);

  const colorHist = computeColorHistogram(imgData.data);
  const metrics = analyzePixelsWithPortrait(imgData.data, aW, aH, portraitResult);

  thumbCanvas.width = 0;
  thumbCanvas.height = 0;
  aCanvas.width = 0;
  aCanvas.height = 0;

  return {
    thumbnailUrl,
    thumbWidth,
    thumbHeight,
    originalWidth,
    originalHeight,
    dHash,
    colorHist,
    metrics
  };
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function computeDHash(sourceCanvas: HTMLCanvasElement): string {
  const c = document.createElement('canvas');
  c.width = 9;
  c.height = 8;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(sourceCanvas, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;

  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i1 = (y * 9 + x) * 4;
      const i2 = (y * 9 + x + 1) * 4;
      const lum1 = data[i1] * 0.299 + data[i1 + 1] * 0.587 + data[i1 + 2] * 0.114;
      const lum2 = data[i2] * 0.299 + data[i2 + 1] * 0.587 + data[i2 + 2] * 0.114;
      bits += lum1 > lum2 ? '1' : '0';
    }
  }
  return bits;
}

function computeColorHistogram(data: Uint8ClampedArray): number[] {
  const bins = new Array<number>(48).fill(0);
  const totalPixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    bins[data[i] >> 4]++;
    bins[16 + (data[i + 1] >> 4)]++;
    bins[32 + (data[i + 2] >> 4)]++;
  }
  for (let i = 0; i < 48; i++) {
    bins[i] = bins[i] / totalPixels;
  }
  return bins;
}

/**
 * 全体画像統計と MediaPipe Face Landmarker の1024px顔・瞳解析結果を統合
 */
function analyzePixelsWithPortrait(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  portrait: PortraitAnalysisResult
): RawImageMetrics {
  const total = w * h;
  const gray = new Float32Array(total);

  let sumLum = 0;
  let sumLumSq = 0;
  let sumSat = 0;
  let overExposed = 0;
  let underExposed = 0;
  let whiteBgPixels = 0;
  let warmPixels = 0;
  let skinPixels = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const p = idx * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[idx] = lum;
      sumLum += lum;
      sumLumSq += lum * lum;

      if (lum > 246) overExposed++;
      if (lum < 12) underExposed++;

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const delta = maxC - minC;
      const sat = maxC === 0 ? 0 : (delta / maxC) * 100;
      sumSat += sat;

      if (lum > 185 && sat < 18) {
        whiteBgPixels++;
      }

      if (r > g && g >= b * 0.85 && sat > 22 && lum > 35 && lum < 235) {
        warmPixels++;
      }

      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (lum > 45 && lum < 235 && cr >= 135 && cr <= 173 && cb >= 88 && cb <= 125) {
        skinPixels++;
      }
    }
  }

  let globalLapSum = 0;
  let globalCount = 0;
  let centerLapSum = 0;
  let centerCount = 0;
  let sharpTextEdges = 0;
  let alignedEdges = 0;
  let tiltedEdges = 0;

  const cX0 = Math.floor(w * 0.25);
  const cX1 = Math.ceil(w * 0.75);
  const cY0 = Math.floor(h * 0.25);
  const cY1 = Math.ceil(h * 0.75);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const c = gray[idx];
      const lap = Math.abs(4 * c - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w]);

      globalLapSum += lap;
      globalCount++;

      if (x >= cX0 && x <= cX1 && y >= cY0 && y <= cY1) {
        centerLapSum += lap;
        centerCount++;
      }

      if (lap > 38) {
        sharpTextEdges++;
      }

      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + w] - gray[idx - w];
      const mag = Math.hypot(gx, gy);
      if (mag > 28) {
        const angle = Math.abs(Math.atan2(gy, gx) * (180 / Math.PI));
        const distFromAxis = Math.min(angle, Math.abs(90 - angle), Math.abs(180 - angle));
        if (distFromAxis <= 4) {
          alignedEdges++;
        } else if (distFromAxis <= 15) {
          tiltedEdges++;
        }
      }
    }
  }

  const rawGlobalLap = globalCount > 0 ? globalLapSum / globalCount : 0;
  const rawCenterLap = centerCount > 0 ? centerLapSum / centerCount : 0;

  const normalizeSharpness = (val: number) =>
    Math.min(100, Math.max(15, Math.round((1 - Math.exp(-val / 11)) * 102)));

  const globalSharpness = normalizeSharpness(rawGlobalLap);
  const centerSharpness = normalizeSharpness(rawCenterLap);

  const meanLum = sumLum / total;
  const varianceLum = Math.max(0, sumLumSq / total - meanLum * meanLum);
  const stdLum = Math.sqrt(varianceLum);

  const brightnessMean = Math.round((meanLum / 255) * 100);
  const saturationMean = Math.round(sumSat / total);
  const contrastScore = Math.min(100, Math.max(20, Math.round((stdLum / 72) * 85)));
  const textEdgeDensity = Math.min(100, Math.round((sharpTextEdges / total) * 450));

  const axisTotal = alignedEdges + tiltedEdges;
  const horizonStraightness =
    axisTotal > 20
      ? Math.min(100, Math.max(40, Math.round(55 + (alignedEdges / axisTotal) * 45)))
      : 82;

  return {
    globalSharpness,
    centerSharpness,
    faceRegionSharpness: portrait.detected ? portrait.aggregatedFaceSharpness : centerSharpness,
    eyeRegionSharpness: portrait.detected ? portrait.aggregatedEyeSharpness : centerSharpness,
    faceCount: portrait.faceCount,
    faceAreaRatio: portrait.totalFaceAreaRatio,
    eyeOpenScore: portrait.detected ? portrait.aggregatedEyeOpenScore : 75,
    isBlinking: portrait.detected ? portrait.anyFaceBlinking : false,
    smileOrFrontalScore: portrait.detected ? portrait.aggregatedExpressionScore : 75,
    faceExposureScore: portrait.detected ? portrait.aggregatedFaceExposure : 78,
    skinToneRatio: skinPixels / total,
    whiteBgRatio: whiteBgPixels / total,
    textEdgeDensity,
    warmColorRatio: warmPixels / total,
    saturationMean,
    brightnessMean,
    overExposedRatio: overExposed / total,
    underExposedRatio: underExposed / total,
    contrastScore,
    horizonStraightness
  };
}

/**
 * MediaPipe Face Landmarker の検出結果を最優先してシーンを分類する
 */
export function classifyScene(m: RawImageMetrics): SceneType {
  // 1. MediaPipe Face Landmarker で顔が1人以上検出された場合は、全身・アップ問わず確実に「人物」と判定
  if (m.faceCount > 0 && m.faceAreaRatio >= 0.0012 && m.whiteBgRatio < 0.72) {
    return 'portrait';
  }

  // 2. 資料・メモ: 白地/単色背景比が高く、文字エッジ密度が高く、彩度が低い
  if (m.whiteBgRatio >= 0.36 && m.saturationMean <= 26 && m.textEdgeDensity >= 18) {
    return 'document';
  }

  // 3. 料理・モノ: 中央被写体フォーカスが強く、暖色または高彩度傾向
  const centerFocusRatio = m.centerSharpness / Math.max(1, m.globalSharpness);
  if (
    (centerFocusRatio >= 1.08 && (m.warmColorRatio >= 0.16 || m.saturationMean >= 32)) ||
    (m.warmColorRatio >= 0.28 && m.centerSharpness >= 60)
  ) {
    return 'food';
  }

  // 4. 風景・建物
  return 'landscape';
}

/**
 * シーン別の重み付けスコア算出。
 * 人物シーンでは 1024px での「瞳ピント」「目開き(EAR+Blendshape)」「笑顔・正面度」「顔露出」で高精度に採点する。
 */
export function calculateSceneScore(scene: SceneType, m: RawImageMetrics): ScoreBreakdown {
  const overPenalty = Math.min(45, m.overExposedRatio * 180);
  const underPenalty = Math.min(45, m.underExposedRatio * 180);
  const brightnessDiff = Math.abs(m.brightnessMean - 52);
  const globalExposure = Math.max(
    20,
    Math.min(100, Math.round(94 - overPenalty - underPenalty - Math.max(0, brightnessDiff - 14) * 0.7))
  );

  let sharpness = m.globalSharpness;
  let exposure = globalExposure;
  let subjectQuality = 75;
  let composition = 78;
  let total = 75;
  let primaryReason = '';

  switch (scene) {
    case 'portrait': {
      // 瞳(まつ毛・虹彩)のピントを65%、顔全体のシャープネスを35%で評価
      sharpness =
        m.faceCount > 0
          ? Math.round(m.eyeRegionSharpness * 0.65 + m.faceRegionSharpness * 0.35)
          : Math.round(m.centerSharpness * 0.75 + m.globalSharpness * 0.25);

      // 目開き度(62%) + 表情・正面度(38%)
      subjectQuality = Math.round(m.eyeOpenScore * 0.62 + m.smileOrFrontalScore * 0.38);

      // 逆光でも顔の明るさが適正なら高評価になるよう顔領域の露出を75%重視
      exposure =
        m.faceCount > 0
          ? Math.round(m.faceExposureScore * 0.75 + globalExposure * 0.25)
          : globalExposure;

      composition = Math.round(m.smileOrFrontalScore * 0.55 + m.contrastScore * 0.45);

      // 目つぶり検出時は大きく減点して確実にベストから外す
      const blinkPenalty = m.isBlinking ? 14 : m.eyeOpenScore < 55 ? (55 - m.eyeOpenScore) * 0.6 : 0;

      total =
        sharpness * 0.44 +
        subjectQuality * 0.34 +
        exposure * 0.14 +
        composition * 0.08 -
        blinkPenalty;

      if (m.isBlinking || m.eyeOpenScore < 48) {
        primaryReason = '目つぶり・まばたき検出（減点）';
      } else if (m.eyeRegionSharpness >= 80 && m.eyeOpenScore >= 75) {
        primaryReason =
          m.faceCount > 1
            ? `${m.faceCount}人の瞳にピントが合い、目開き・表情が良好`
            : '瞳にピントが合い、目開き・表情が良好';
      } else if (sharpness >= 74) {
        primaryReason = '顔へのピントと肌の明るさが良好';
      } else {
        primaryReason = '瞳・顔領域のピントがやや甘め';
      }
      break;
    }

    case 'document': {
      sharpness = Math.round(m.globalSharpness * 0.55 + m.centerSharpness * 0.45);
      subjectQuality = Math.min(100, Math.round(m.textEdgeDensity * 0.6 + m.contrastScore * 0.4));
      composition = Math.round((1 - Math.abs(0.65 - m.whiteBgRatio)) * 95);
      total = sharpness * 0.45 + subjectQuality * 0.3 + exposure * 0.15 + composition * 0.1;

      if (sharpness >= 80) {
        primaryReason = '文字の輪郭がくっきりして読みやすい';
      } else {
        primaryReason = '文字のコントラスト・ピント基準で選出';
      }
      break;
    }

    case 'food': {
      sharpness = Math.round(m.centerSharpness * 0.75 + m.globalSharpness * 0.25);
      const appetizingColor = Math.min(
        100,
        Math.round(50 + m.warmColorRatio * 85 + m.saturationMean * 0.5)
      );
      subjectQuality = appetizingColor;
      composition = Math.round(m.contrastScore * 0.5 + exposure * 0.5);
      total = sharpness * 0.45 + subjectQuality * 0.25 + exposure * 0.2 + composition * 0.1;

      if (sharpness >= 80 && subjectQuality >= 78) {
        primaryReason = '中央の被写体にピントが合い、色合い・明るさが良好';
      } else {
        primaryReason = '中央のピントと明るさのバランスで選出';
      }
      break;
    }

    case 'landscape':
    default: {
      sharpness = Math.round(m.globalSharpness * 0.75 + m.centerSharpness * 0.25);
      subjectQuality = m.horizonStraightness;
      composition = Math.round(
        m.contrastScore * 0.55 + Math.min(100, m.saturationMean * 1.5) * 0.45
      );
      total = sharpness * 0.45 + exposure * 0.25 + subjectQuality * 0.15 + composition * 0.15;

      if (sharpness >= 82 && exposure >= 82) {
        primaryReason = '全体がシャープで白飛び・黒つぶれが少ない';
      } else {
        primaryReason = '全体の解像感と露出バランスで選出';
      }
      break;
    }
  }

  return {
    sharpness: Math.min(100, Math.max(0, sharpness)),
    exposure: Math.min(100, Math.max(0, exposure)),
    subjectQuality: Math.min(100, Math.max(0, subjectQuality)),
    composition: Math.min(100, Math.max(0, composition)),
    total: Math.round(Math.min(100, Math.max(0, total)) * 10) / 10,
    primaryReason
  };
}
