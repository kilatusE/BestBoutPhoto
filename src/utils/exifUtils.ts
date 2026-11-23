import exifr from 'exifr';
import { ExifInfo } from '../types';

const MAX_JPEG_SEGMENTS = 256;
const MAX_IFD_ENTRIES = 256;
const MAX_GPS_ENTRIES = 128;

export async function extractExif(file: File, fallbackWidth = 0, fallbackHeight = 0): Promise<ExifInfo> {
  try {
    const data = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'Make',
        'Model',
        'LensModel',
        'FocalLength',
        'FNumber',
        'ExposureTime',
        'ISO',
        'ExifImageWidth',
        'ExifImageHeight',
        'ImageWidth',
        'ImageHeight',
        'GPSLatitude',
        'GPSLongitude',
        'latitude',
        'longitude'
      ]
    });

    if (!data) {
      return {
        timestamp: file.lastModified || Date.now(),
        width: fallbackWidth,
        height: fallbackHeight,
        hasGps: false
      };
    }

    const rawDate = data.DateTimeOriginal || data.CreateDate;
    let timestamp = file.lastModified || Date.now();
    let dateTimeOriginal: string | undefined;

    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
      timestamp = rawDate.getTime();
      dateTimeOriginal = formatExifDate(rawDate);
    } else if (typeof rawDate === 'string') {
      const parsed = new Date(rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
      if (!isNaN(parsed.getTime())) {
        timestamp = parsed.getTime();
        dateTimeOriginal = formatExifDate(parsed);
      }
    }

    const lat = typeof data.latitude === 'number' && isFinite(data.latitude) ? data.latitude : undefined;
    const lon = typeof data.longitude === 'number' && isFinite(data.longitude) ? data.longitude : undefined;
    const hasGps = lat !== undefined || lon !== undefined || Boolean(data.GPSLatitude);

    return {
      dateTimeOriginal,
      timestamp,
      make: data.Make ? String(data.Make).trim().slice(0, 80) : undefined,
      model: data.Model ? String(data.Model).trim().slice(0, 80) : undefined,
      lensModel: data.LensModel ? String(data.LensModel).trim().slice(0, 120) : undefined,
      focalLength:
        typeof data.FocalLength === 'number' && isFinite(data.FocalLength)
          ? Math.round(data.FocalLength * 10) / 10
          : undefined,
      fNumber:
        typeof data.FNumber === 'number' && isFinite(data.FNumber)
          ? Math.round(data.FNumber * 10) / 10
          : undefined,
      exposureTime:
        typeof data.ExposureTime === 'number' && isFinite(data.ExposureTime) && data.ExposureTime > 0
          ? data.ExposureTime
          : undefined,
      iso:
        typeof data.ISO === 'number' && isFinite(data.ISO) && data.ISO > 0
          ? Math.round(data.ISO)
          : undefined,
      width: Number(data.ExifImageWidth || data.ImageWidth || fallbackWidth) || fallbackWidth,
      height: Number(data.ExifImageHeight || data.ImageHeight || fallbackHeight) || fallbackHeight,
      hasGps,
      gpsLatitude: lat,
      gpsLongitude: lon
    };
  } catch {
    return {
      timestamp: file.lastModified || Date.now(),
      width: fallbackWidth,
      height: fallbackHeight,
      hasGps: false
    };
  }
}

export function formatExifDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

export function formatShutterSpeed(exposureTime?: number): string {
  if (!exposureTime || exposureTime <= 0 || !isFinite(exposureTime)) return '-';
  if (exposureTime >= 1) return `${exposureTime.toFixed(1)}s`;
  const denom = Math.round(1 / exposureTime);
  return `1/${denom}s`;
}

export function getMostFrequentDatePrefix(timestamps: number[]): string {
  if (timestamps.length === 0) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_`;
  }
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestDate = '';
  let maxCount = -1;
  for (const [dateStr, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestDate = dateStr;
    }
  }
  if (!bestDate) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_`;
  }
  return `${bestDate}_`;
}

/**
 * 元JPEGのAPP1(Exif)セグメントを安全に抽出・サニタイズし、ターゲットJPEG Blobへ注入する
 */
export async function copyAndProcessJpegExif(
  sourceFile: Blob,
  targetJpegBlob: Blob,
  options: { stripGps: boolean; resetOrientation: boolean }
): Promise<Blob> {
  try {
    const srcBuf = await sourceFile.arrayBuffer();
    const srcView = new DataView(srcBuf);

    if (srcView.byteLength < 4 || srcView.getUint16(0, false) !== 0xffd8) {
      return targetJpegBlob;
    }

    let offset = 2;
    let exifSegment: Uint8Array | null = null;
    let segmentCount = 0;

    while (offset + 4 <= srcView.byteLength && segmentCount < MAX_JPEG_SEGMENTS) {
      segmentCount++;
      const marker = srcView.getUint16(offset, false);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffda || marker === 0xffd9) break; // SOS or EOI

      // スタンドアロンマーカー (RST0-RST7, TEM)
      if ((marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xff01) {
        offset += 2;
        continue;
      }

      const segLength = srcView.getUint16(offset + 2, false);
      // JPEG仕様上 segLength は2以上必須（不正な0や1による無限ループを防御）
      if (segLength < 2 || offset + 2 + segLength > srcView.byteLength) {
        break;
      }

      if (
        marker === 0xffe1 &&
        segLength >= 16 &&
        srcView.getUint32(offset + 4, false) === 0x45786966 && // "Exif"
        srcView.getUint16(offset + 8, false) === 0x0000
      ) {
        const segBytes = new Uint8Array(srcBuf.slice(offset, offset + 2 + segLength));
        exifSegment = sanitizeExifApp1Segment(segBytes, options);
        break;
      }

      offset += 2 + segLength;
    }

    if (!exifSegment) {
      return targetJpegBlob;
    }

    const targetBuf = await targetJpegBlob.arrayBuffer();
    const targetView = new DataView(targetBuf);
    if (targetView.byteLength < 4 || targetView.getUint16(0, false) !== 0xffd8) {
      return targetJpegBlob;
    }

    // ターゲットJPEG内のAPP0は保持し、既存のExif APP1セグメント（重複含む）はすべて除外して差し替える
    const preservedChunks: Uint8Array[] = [new Uint8Array(targetBuf, 0, 2)]; // SOI (FF D8)
    let inserted = false;
    let tPos = 2;
    let tSegCount = 0;

    while (tPos + 4 <= targetView.byteLength && tSegCount < MAX_JPEG_SEGMENTS) {
      tSegCount++;
      const marker = targetView.getUint16(tPos, false);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || marker === 0xffd9) {
        break;
      }

      const segLength = targetView.getUint16(tPos + 2, false);
      if (segLength < 2 || tPos + 2 + segLength > targetView.byteLength) {
        break;
      }

      const isExifApp1 =
        marker === 0xffe1 &&
        segLength >= 10 &&
        targetView.getUint32(tPos + 4, false) === 0x45786966 &&
        targetView.getUint16(tPos + 8, false) === 0x0000;

      if (marker === 0xffe0) {
        // JFIF APP0 は先頭に維持
        preservedChunks.push(new Uint8Array(targetBuf, tPos, 2 + segLength));
        tPos += 2 + segLength;
      } else if (isExifApp1) {
        // 既存のExif APP1はスキップし、サニタイズ済みのExifを1回だけ挿入
        if (!inserted) {
          preservedChunks.push(exifSegment);
          inserted = true;
        }
        tPos += 2 + segLength;
      } else {
        break;
      }
    }

    if (!inserted) {
      preservedChunks.push(exifSegment);
    }

    preservedChunks.push(new Uint8Array(targetBuf, tPos));
    return new Blob(preservedChunks as BlobPart[], { type: 'image/jpeg' });
  } catch {
    return targetJpegBlob;
  }
}

/**
 * APP1 Exifセグメント内のTIFF IFD0を境界検証付きで走査し、
 * - resetOrientation: Orientationタグ(0x0112)を1に書き換え
 * - stripGps: GPSInfoIFDPointer(0x8825)およびその参照先GPSサブIFD領域をゼロクリア
 */
export function sanitizeExifApp1Segment(
  segment: Uint8Array,
  options: { stripGps: boolean; resetOrientation: boolean }
): Uint8Array {
  const buf = segment.buffer.slice(segment.byteOffset, segment.byteOffset + segment.byteLength);
  const view = new DataView(buf);
  const tiffStart = 10; // FF E1 [len:2] "Exif\0\0" [6]

  if (view.byteLength < tiffStart + 8) return segment;

  const byteOrder = view.getUint16(tiffStart, false);
  const littleEndian = byteOrder === 0x4949; // "II"
  if (!littleEndian && byteOrder !== 0x4d4d) return segment;

  const magic = view.getUint16(tiffStart + 2, littleEndian);
  if (magic !== 0x002a) return segment;

  const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
  if (ifd0Offset < 8 || ifd0Offset > view.byteLength - tiffStart - 2) return segment;

  const ifd0Pos = tiffStart + ifd0Offset;
  if (ifd0Pos + 2 > view.byteLength) return segment;

  const rawEntryCount = view.getUint16(ifd0Pos, littleEndian);
  const entryCount = Math.min(MAX_IFD_ENTRIES, rawEntryCount);
  const ifd0TableEnd = Math.min(view.byteLength, ifd0Pos + 2 + entryCount * 12);

  for (let i = 0; i < entryCount; i++) {
    const entryPos = ifd0Pos + 2 + i * 12;
    if (entryPos + 12 > view.byteLength) break;

    const tag = view.getUint16(entryPos, littleEndian);

    // Orientation (0x0112) -> 1
    if (tag === 0x0112 && options.resetOrientation) {
      view.setUint16(entryPos + 8, 1, littleEndian);
    }

    // GPSInfoIFDPointer (0x8825) -> GPS領域を安全にゼロ埋め＆ポインタ抹消
    if (tag === 0x8825 && options.stripGps) {
      const gpsIfdRelOffset = view.getUint32(entryPos + 8, littleEndian);
      if (gpsIfdRelOffset >= 8 && gpsIfdRelOffset <= view.byteLength - tiffStart - 2) {
        const gpsIfdPos = tiffStart + gpsIfdRelOffset;

        // IFD0自体のテーブルと重ならないことを検証
        const overlapsIfd0 = gpsIfdPos < ifd0TableEnd && gpsIfdPos + 2 > ifd0Pos;
        if (!overlapsIfd0 && gpsIfdPos + 2 <= view.byteLength) {
          const rawGpsEntries = view.getUint16(gpsIfdPos, littleEndian);
          const gpsEntries = Math.min(MAX_GPS_ENTRIES, rawGpsEntries);
          const gpsTableEnd = Math.min(view.byteLength, gpsIfdPos + 2 + gpsEntries * 12 + 4);

          for (let g = 0; g < gpsEntries; g++) {
            const gPos = gpsIfdPos + 2 + g * 12;
            if (gPos + 12 > view.byteLength) break;
            const gType = view.getUint16(gPos + 2, littleEndian);
            const gCount = view.getUint32(gPos + 4, littleEndian);
            if (gCount > 65536) continue; // 整数オーバーフロー防御

            const typeSize =
              gType === 5 || gType === 10
                ? 8
                : gType === 3 || gType === 8
                ? 2
                : gType === 4 || gType === 9 || gType === 11
                ? 4
                : gType === 12
                ? 8
                : 1;
            const totalBytes = gCount * typeSize;

            if (totalBytes > 4 && totalBytes <= view.byteLength) {
              const relValOffset = view.getUint32(gPos + 8, littleEndian);
              const valOffset = tiffStart + relValOffset;
              const overlapsHeaderOrIfd0 =
                valOffset < tiffStart + 8 ||
                (valOffset < ifd0TableEnd && valOffset + totalBytes > ifd0Pos);

              if (!overlapsHeaderOrIfd0 && valOffset + totalBytes <= view.byteLength) {
                new Uint8Array(buf, valOffset, totalBytes).fill(0);
              }
            }
          }

          if (gpsTableEnd > gpsIfdPos) {
            new Uint8Array(buf, gpsIfdPos, gpsTableEnd - gpsIfdPos).fill(0);
          }
        }
      }

      // IFD0上のGPSポインタエントリ自体を0クリア
      view.setUint16(entryPos, 0x0000, littleEndian);
      view.setUint16(entryPos + 2, 1, littleEndian);
      view.setUint32(entryPos + 4, 0, littleEndian);
      view.setUint32(entryPos + 8, 0, littleEndian);
    }
  }

  return new Uint8Array(buf);
}
