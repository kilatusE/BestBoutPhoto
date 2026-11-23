import exifr from 'exifr';
import { ExifInfo } from '../types';

/**
 * ファイルから高速にExif情報を抽出する
 */
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

    const lat = typeof data.latitude === 'number' ? data.latitude : undefined;
    const lon = typeof data.longitude === 'number' ? data.longitude : undefined;
    const hasGps = (lat !== undefined && !isNaN(lat)) || (lon !== undefined && !isNaN(lon)) || Boolean(data.GPSLatitude);

    return {
      dateTimeOriginal,
      timestamp,
      make: data.Make ? String(data.Make).trim() : undefined,
      model: data.Model ? String(data.Model).trim() : undefined,
      lensModel: data.LensModel ? String(data.LensModel).trim() : undefined,
      focalLength: typeof data.FocalLength === 'number' ? Math.round(data.FocalLength * 10) / 10 : undefined,
      fNumber: typeof data.FNumber === 'number' ? Math.round(data.FNumber * 10) / 10 : undefined,
      exposureTime: typeof data.ExposureTime === 'number' ? data.ExposureTime : undefined,
      iso: typeof data.ISO === 'number' ? data.ISO : undefined,
      width: data.ExifImageWidth || data.ImageWidth || fallbackWidth,
      height: data.ExifImageHeight || data.ImageHeight || fallbackHeight,
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
  if (!exposureTime || exposureTime <= 0) return '-';
  if (exposureTime >= 1) return `${exposureTime.toFixed(1)}s`;
  const denom = Math.round(1 / exposureTime);
  return `1/${denom}s`;
}

/**
 * 写真群の最頻撮影日（YYYY-MM-DD_）を算出する
 */
export function getMostFrequentDatePrefix(timestamps: number[]): string {
  if (timestamps.length === 0) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_`;
  }
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    const d = new Date(ts);
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
  return `${bestDate}_`;
}

/**
 * 元JPEGのAPP1(Exif)セグメントを抽出し、必要に応じてGPSタグ(0x8825)およびOrientationリセットを行って
 * リサイズ後または出力用のJPEG Blobに注入する。
 *
 * - Canvasリサイズ後の画像はすでに回転適用済みのため、resetOrientation=trueでOrientationタグ(0x0112)を1(標準)に補正可能
 * - stripGps=true の場合は GPSInfoIFDPointer (0x8825) を無効化して位置情報を除去
 */
export async function copyAndProcessJpegExif(
  sourceFile: File,
  targetJpegBlob: Blob,
  options: { stripGps: boolean; resetOrientation: boolean }
): Promise<Blob> {
  try {
    const srcBuf = await sourceFile.arrayBuffer();
    const srcView = new DataView(srcBuf);

    // JPEG SOI (0xFFD8) チェック
    if (srcView.byteLength < 4 || srcView.getUint16(0, false) !== 0xffd8) {
      return targetJpegBlob;
    }

    // 元JPEGからExif APP1セグメントを探す
    let offset = 2;
    let exifSegment: Uint8Array | null = null;

    while (offset + 4 <= srcView.byteLength) {
      const marker = srcView.getUint16(offset, false);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffda || marker === 0xffd9) break; // SOS or EOI

      const segLength = srcView.getUint16(offset + 2, false);
      if (offset + 2 + segLength > srcView.byteLength) break;

      // APP1 (0xFFE1) かつ "Exif\0\0" ヘッダー
      if (
        marker === 0xffe1 &&
        segLength >= 14 &&
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
    if (targetView.byteLength < 2 || targetView.getUint16(0, false) !== 0xffd8) {
      return targetJpegBlob;
    }

    // ターゲットJPEGの既存APP1(Exif)があればスキップして差し替える
    let insertPos = 2;
    let skipEndPos = 2;
    while (skipEndPos + 4 <= targetView.byteLength) {
      const marker = targetView.getUint16(skipEndPos, false);
      if (marker === 0xffe0) {
        // JFIF APP0 は維持
        const len = targetView.getUint16(skipEndPos + 2, false);
        insertPos = skipEndPos + 2 + len;
        skipEndPos = insertPos;
      } else if (
        marker === 0xffe1 &&
        skipEndPos + 10 <= targetView.byteLength &&
        targetView.getUint32(skipEndPos + 4, false) === 0x45786966
      ) {
        // 既存のExif APP1は除去
        const len = targetView.getUint16(skipEndPos + 2, false);
        skipEndPos += 2 + len;
        break;
      } else {
        break;
      }
    }

    const head = new Uint8Array(targetBuf, 0, insertPos);
    const tail = new Uint8Array(targetBuf, skipEndPos);

    return new Blob([head, exifSegment, tail], { type: 'image/jpeg' });
  } catch {
    return targetJpegBlob;
  }
}

/**
 * APP1 Exifセグメント内のTIFF IFD0を走査し、
 * - resetOrientation: Orientationタグ(0x0112)を1に書き換え（Canvasリサイズ画像の二重回転防止）
 * - stripGps: GPSInfoIFDPointer(0x8825)が指すGPSサブIFD領域をゼロ埋め＆ポインタ無効化
 */
function sanitizeExifApp1Segment(
  segment: Uint8Array,
  options: { stripGps: boolean; resetOrientation: boolean }
): Uint8Array {
  const buf = segment.buffer.slice(segment.byteOffset, segment.byteOffset + segment.byteLength);
  const view = new DataView(buf);
  const tiffStart = 10; // FF E1 [len:2] "Exif\0\0" [6] -> index 10

  if (view.byteLength < tiffStart + 8) return segment;

  const byteOrder = view.getUint16(tiffStart, false);
  const littleEndian = byteOrder === 0x4949; // "II"
  if (!littleEndian && byteOrder !== 0x4d4d) return segment;

  const magic = view.getUint16(tiffStart + 2, littleEndian);
  if (magic !== 0x002a) return segment;

  const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
  const ifd0Pos = tiffStart + ifd0Offset;
  if (ifd0Pos + 2 > view.byteLength) return segment;

  const entryCount = view.getUint16(ifd0Pos, littleEndian);

  for (let i = 0; i < entryCount; i++) {
    const entryPos = ifd0Pos + 2 + i * 12;
    if (entryPos + 12 > view.byteLength) break;

    const tag = view.getUint16(entryPos, littleEndian);

    // Orientation (0x0112) -> 1 (Horizontal / normal)
    if (tag === 0x0112 && options.resetOrientation) {
      view.setUint16(entryPos + 8, 1, littleEndian);
    }

    // GPSInfoIFDPointer (0x8825) -> GPSサブIFDを消去してタグを無効化
    if (tag === 0x8825 && options.stripGps) {
      const gpsIfdRelOffset = view.getUint32(entryPos + 8, littleEndian);
      const gpsIfdPos = tiffStart + gpsIfdRelOffset;

      if (gpsIfdPos + 2 <= view.byteLength) {
        const gpsEntries = view.getUint16(gpsIfdPos, littleEndian);
        const gpsTableEnd = Math.min(view.byteLength, gpsIfdPos + 2 + gpsEntries * 12 + 4);
        // 各GPSエントリが外部データ領域を指している場合もゼロクリア
        for (let g = 0; g < gpsEntries; g++) {
          const gPos = gpsIfdPos + 2 + g * 12;
          if (gPos + 12 > view.byteLength) break;
          const gType = view.getUint16(gPos + 2, littleEndian);
          const gCount = view.getUint32(gPos + 4, littleEndian);
          const typeSize = gType === 5 || gType === 10 ? 8 : gType === 3 ? 2 : gType === 4 ? 4 : 1;
          const totalBytes = gCount * typeSize;
          if (totalBytes > 4) {
            const valOffset = tiffStart + view.getUint32(gPos + 8, littleEndian);
            if (valOffset >= tiffStart && valOffset + totalBytes <= view.byteLength) {
              new Uint8Array(buf, valOffset, totalBytes).fill(0);
            }
          }
        }
        new Uint8Array(buf, gpsIfdPos, gpsTableEnd - gpsIfdPos).fill(0);
      }

      // タグ自体を0x0000（無効タグ）および値0にクリア
      view.setUint16(entryPos, 0x0000, littleEndian);
      view.setUint16(entryPos + 2, 1, littleEndian);
      view.setUint32(entryPos + 4, 0, littleEndian);
      view.setUint32(entryPos + 8, 0, littleEndian);
    }
  }

  return new Uint8Array(buf);
}
