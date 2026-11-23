import { PhotoItem, RawImageMetrics, SceneType, ScoreBreakdown } from '../types';
import { extractExif } from './exifUtils';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif']);
const RAW_EXTENSIONS = new Set(['arw', 'cr2', 'cr3', 'nef', 'nrw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw']);

export interface PairedFileEntry {
  baseName: string;
  imageFile: File;
  rawFile?: File;
}

/**
 * 取り込まれたFileリストからJPEG/画像とRAW(.ARW等)を拡張子を除いたファイル名で自動ペアリングする
 */
export function pairImportedFiles(files: File[], enableRawPairing: boolean): PairedFileEntry[] {
  const imageMap = new Map<string, File>();
  const rawMap = new Map<string, File>();
  const standaloneImages: PairedFileEntry[] = [];

  for (const file of files) {
    if (file.name.startsWith('.')) continue;
    const dotIdx = file.name.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const baseName = file.name.slice(0, dotIdx);
    const ext = file.name.slice(dotIdx + 1).toLowerCase();
    // フォルダ階層がある場合も考慮しつつ、同一ファイル名ベースでマッチング
    const key = baseName.toLowerCase();

    if (IMAGE_EXTENSIONS.has(ext)) {
      // 同名がある場合はサイズが大きい方または後勝ち
      imageMap.set(key, file);
    } else if (RAW_EXTENSIONS.has(ext)) {
      rawMap.set(key, file);
    }
  }

  for (const [key, imageFile] of imageMap.entries()) {
    const dotIdx = imageFile.name.lastIndexOf('.');
    const baseName = imageFile.name.slice(0, dotIdx);
    const rawFile = enableRawPairing ? rawMap.get(key) : undefined;
    standaloneImages.push({
      baseName,
      imageFile,
      rawFile
    });
  }

  return standaloneImages;
}

/**
 * 50MP級の高画素画像でもメモリパンクしないよう、1枚ずつ長辺1024pxサムネイルと解析特徴量を生成し、
 * フル解像度Bitmapを即座に破棄する
 */
export async function analyzePhotoEntry(
  entry: PairedFileEntry,
  index: number
): Promise<PhotoItem> {
  const { imageFile, rawFile, baseName } = entry;

  // 1. Exif抽出 と 画像デコード（1024px縮小）を並列実行
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

  return {
    id: `photo_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    file: imageFile,
    fileName: imageFile.name,
    baseName,
    rawFile,
    rawFileName: rawFile?.name,
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
  // createImageBitmap が使える場合は高速デコードし、描画後に close() で即座にメモリ解放
  let originalWidth = 0;
  let originalHeight = 0;
  let thumbWidth = 0;
  let thumbHeight = 0;

  const thumbCanvas = document.createElement('canvas');
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: false })!;

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
    bitmap.close(); // 50MPフル解像度メモリを即解放
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
  }

  // サムネイルBlob URL生成
  const thumbBlob = await new Promise<Blob>((resolve) => {
    thumbCanvas.toBlob((b) => resolve(b || new Blob()), 'image/jpeg', 0.85);
  });
  const thumbnailUrl = URL.createObjectURL(thumbBlob);

  // 2. dHash (9x8 グレースケール差分ハッシュ = 64bit)
  const dHash = computeDHash(thumbCanvas);

  // 3. 解析用キャンバス（長辺256px）で色ヒストグラム・シャープネス・顔/被写体領域・露出・水平を計測
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
  const metrics = analyzePixels(imgData.data, aW, aH);

  // メモリ解放補助
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

/**
 * 9x8 縮小画像から64bitのdHash文字列（'0'/'1'の64文字）を生成
 */
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

/**
 * 48ビン（R:16, G:16, B:16）の正規化カラーヒストグラムを計算
 */
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
 * ピクセル統計・Laplacianシャープネス・肌色/顔候補領域・目開き度・文字エッジ密度・露出・水平度を解析
 */
function analyzePixels(data: Uint8ClampedArray, w: number, h: number): RawImageMetrics {
  const total = w * h;
  const gray = new Float32Array(total);
  const skinMask = new Uint8Array(total);

  let sumLum = 0;
  let sumLumSq = 0;
  let sumSat = 0;
  let overExposed = 0;
  let underExposed = 0;
  let whiteBgPixels = 0;
  let warmPixels = 0;
  let skinPixels = 0;

  // 肌色領域の重心とバウンディングボックス
  let skinMinX = w, skinMaxX = 0, skinMinY = h, skinMaxY = 0;

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

      // 白地・単色書類背景判定（高輝度・低彩度）
      if (lum > 185 && sat < 18) {
        whiteBgPixels++;
      }

      // 暖色判定（料理・紅葉・夕景など）
      if (r > g && g >= b * 0.85 && sat > 22 && lum > 35 && lum < 235) {
        warmPixels++;
      }

      // YCbCr による肌色領域検出（人物の顔・肌の検出）
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const isCenterish = x > w * 0.12 && x < w * 0.88 && y > h * 0.08 && y < h * 0.85;
      if (
        isCenterish &&
        lum > 45 &&
        lum < 235 &&
        cr >= 135 &&
        cr <= 175 &&
        cb >= 85 &&
        cb <= 128 &&
        r > g &&
        r > b
      ) {
        skinMask[idx] = 1;
        skinPixels++;
        if (x < skinMinX) skinMinX = x;
        if (x > skinMaxX) skinMaxX = x;
        if (y < skinMinY) skinMinY = y;
        if (y > skinMaxY) skinMaxY = y;
      }
    }
  }

  // エッジ・Laplacianシャープネス・テキストエッジ密度・水平傾き解析
  let globalLapSum = 0;
  let globalCount = 0;
  let centerLapSum = 0;
  let centerCount = 0;
  let faceLapSum = 0;
  let faceLapCount = 0;
  let sharpTextEdges = 0;
  let alignedEdges = 0;
  let tiltedEdges = 0;

  const cX0 = Math.floor(w * 0.25);
  const cX1 = Math.ceil(w * 0.75);
  const cY0 = Math.floor(h * 0.25);
  const cY1 = Math.ceil(h * 0.75);

  const skinRatio = skinPixels / total;
  const hasFaceCandidate =
    skinRatio >= 0.035 &&
    skinRatio <= 0.55 &&
    skinMaxX > skinMinX + w * 0.06 &&
    skinMaxY > skinMinY + h * 0.06;

  // 顔の上半分（目・眉の領域）のコントラストから目開き度・表情を推定
  let eyeRegionEdgeSum = 0;
  let eyeRegionCount = 0;
  const eyeY0 = hasFaceCandidate ? skinMinY + Math.floor((skinMaxY - skinMinY) * 0.18) : 0;
  const eyeY1 = hasFaceCandidate ? skinMinY + Math.floor((skinMaxY - skinMinY) * 0.52) : 0;

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

      if (hasFaceCandidate && x >= skinMinX && x <= skinMaxX && y >= skinMinY && y <= skinMaxY) {
        faceLapSum += lap;
        faceLapCount++;
        if (y >= eyeY0 && y <= eyeY1) {
          // 瞳・まつ毛・黒目のエッジ（縦方向＋横方向の急峻な輝度変化）
          const dy = Math.abs(gray[idx + w] - gray[idx - w]);
          const dx = Math.abs(gray[idx + 1] - gray[idx - 1]);
          eyeRegionEdgeSum += dy * 1.4 + dx * 0.8;
          eyeRegionCount++;
        }
      }

      // 文字らしい高コントラストエッジ
      if (lap > 38) {
        sharpTextEdges++;
      }

      // 水平・垂直エッジの傾きチェック（風景の水平線・建物の垂直線）
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + w] - gray[idx - w];
      const mag = Math.hypot(gx, gy);
      if (mag > 28) {
        const angle = Math.abs(Math.atan2(gy, gx) * (180 / Math.PI)); // 0〜180
        // 完全水平(90度付近)または完全垂直(0/180度付近)からのズレ
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
  const rawFaceLap = faceLapCount > 0 ? faceLapSum / faceLapCount : rawCenterLap;

  // 0〜100のスコアに正規化（一般的な写真のLaplacian平均 6〜24 を 45〜98 にマッピング）
  const normalizeSharpness = (val: number) => Math.min(100, Math.max(15, Math.round((1 - Math.exp(-val / 11)) * 102)));

  const globalSharpness = normalizeSharpness(rawGlobalLap);
  const centerSharpness = normalizeSharpness(rawCenterLap);
  const faceRegionSharpness = normalizeSharpness(rawFaceLap * 1.15);

  const eyeRaw = eyeRegionCount > 0 ? eyeRegionEdgeSum / eyeRegionCount : 18;
  const eyeOpenScore = hasFaceCandidate
    ? Math.min(100, Math.max(25, Math.round(40 + eyeRaw * 2.2)))
    : 75;

  // 顔の位置・左右バランスから正面度・表情スコアを算出
  let smileOrFrontalScore = 75;
  if (hasFaceCandidate) {
    const faceCenterX = (skinMinX + skinMaxX) / (2 * w);
    const centerBias = 1 - Math.min(1, Math.abs(faceCenterX - 0.5) * 2.2);
    smileOrFrontalScore = Math.min(98, Math.max(45, Math.round(62 + centerBias * 22 + (eyeOpenScore - 60) * 0.35)));
  }

  const meanLum = sumLum / total;
  const varianceLum = Math.max(0, sumLumSq / total - meanLum * meanLum);
  const stdLum = Math.sqrt(varianceLum);

  const brightnessMean = Math.round((meanLum / 255) * 100);
  const saturationMean = Math.round(sumSat / total);
  const contrastScore = Math.min(100, Math.max(20, Math.round((stdLum / 72) * 85)));
  const textEdgeDensity = Math.min(100, Math.round((sharpTextEdges / total) * 450));

  const axisTotal = alignedEdges + tiltedEdges;
  const horizonStraightness =
    axisTotal > 20 ? Math.min(100, Math.max(40, Math.round(55 + (alignedEdges / axisTotal) * 45))) : 82;

  return {
    globalSharpness,
    centerSharpness,
    faceRegionSharpness,
    faceCount: hasFaceCandidate ? 1 : 0,
    faceAreaRatio: hasFaceCandidate ? skinRatio : 0,
    eyeOpenScore,
    smileOrFrontalScore,
    skinToneRatio: skinRatio,
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
 * SPEC 4.3 に基づき、画像の統計・特徴からシーンを自動判別する
 */
export function classifyScene(m: RawImageMetrics): SceneType {
  // 1. 資料・メモ: 白地/単色背景比が高く、文字エッジ密度が高く、彩度が低い
  if (m.whiteBgRatio >= 0.36 && m.saturationMean <= 26 && m.textEdgeDensity >= 18) {
    return 'document';
  }

  // 2. 人物・ペット: 一定サイズ以上の顔・肌領域があり、かつ中央〜上部に被写体がある
  if (m.faceCount > 0 && m.faceAreaRatio >= 0.045 && m.whiteBgRatio < 0.45) {
    return 'portrait';
  }

  // 3. 料理・モノ: 中央被写体フォーカスが強く（背景ボケ）、暖色または高彩度傾向
  const centerFocusRatio = m.centerSharpness / Math.max(1, m.globalSharpness);
  if (
    (centerFocusRatio >= 1.08 && (m.warmColorRatio >= 0.16 || m.saturationMean >= 32)) ||
    (m.warmColorRatio >= 0.28 && m.centerSharpness >= 60)
  ) {
    return 'food';
  }

  // 4. 風景・建物: 上記以外
  return 'landscape';
}

/**
 * SPEC 4.3 のシーン別重み付けに基づき、0〜100点のスコアと内訳・評価理由を算出する
 */
export function calculateSceneScore(scene: SceneType, m: RawImageMetrics): ScoreBreakdown {
  // 露出スコア（白飛び・黒つぶれペナルティ＋適正輝度評価）
  const overPenalty = Math.min(45, m.overExposedRatio * 180);
  const underPenalty = Math.min(45, m.underExposedRatio * 180);
  const brightnessDiff = Math.abs(m.brightnessMean - 52);
  const exposure = Math.max(
    20,
    Math.min(100, Math.round(94 - overPenalty - underPenalty - Math.max(0, brightnessDiff - 14) * 0.7))
  );

  let sharpness = m.globalSharpness;
  let subjectQuality = 75;
  let composition = 78;
  let total = 75;
  let primaryReason = '';

  switch (scene) {
    case 'portrait': {
      sharpness = Math.round(m.faceRegionSharpness * 0.7 + m.centerSharpness * 0.3);
      subjectQuality = Math.round(m.eyeOpenScore * 0.6 + m.smileOrFrontalScore * 0.4);
      composition = Math.round(m.contrastScore * 0.5 + Math.min(100, m.saturationMean * 1.6) * 0.5);
      total = sharpness * 0.42 + subjectQuality * 0.33 + exposure * 0.15 + composition * 0.1;

      if (m.eyeOpenScore < 52) {
        primaryReason = '目つぶり・まばたきの可能性あり（減点）';
      } else if (sharpness >= 82 && subjectQuality >= 80) {
        primaryReason = '顔・瞳のピントがシャープで表情も良好';
      } else if (sharpness >= 75) {
        primaryReason = '被写体へのピントと露出バランスが安定';
      } else {
        primaryReason = '被写体のわずかなブレまたはピント甘め';
      }
      break;
    }

    case 'document': {
      sharpness = Math.round(m.globalSharpness * 0.55 + m.centerSharpness * 0.45);
      subjectQuality = Math.min(100, Math.round(m.textEdgeDensity * 0.6 + m.contrastScore * 0.4));
      composition = Math.round((1 - Math.abs(0.65 - m.whiteBgRatio)) * 95);
      total = sharpness * 0.45 + subjectQuality * 0.3 + exposure * 0.15 + composition * 0.1;

      if (sharpness >= 80) {
        primaryReason = '文字の輪郭がくっきりしており判読性が最も高い';
      } else {
        primaryReason = '文字領域のコントラスト・ピント基準で選出';
      }
      break;
    }

    case 'food': {
      sharpness = Math.round(m.centerSharpness * 0.75 + m.globalSharpness * 0.25);
      const appetizingColor = Math.min(100, Math.round(50 + m.warmColorRatio * 85 + m.saturationMean * 0.5));
      subjectQuality = appetizingColor;
      composition = Math.round(m.contrastScore * 0.5 + exposure * 0.5);
      total = sharpness * 0.45 + subjectQuality * 0.25 + exposure * 0.2 + composition * 0.1;

      if (sharpness >= 80 && subjectQuality >= 78) {
        primaryReason = '中央の被写体にピントが合い、色ツヤ・明るさが良好';
      } else {
        primaryReason = '中央ピントと彩度・露出バランスが優位';
      }
      break;
    }

    case 'landscape':
    default: {
      sharpness = Math.round(m.globalSharpness * 0.75 + m.centerSharpness * 0.25);
      subjectQuality = m.horizonStraightness;
      composition = Math.round(m.contrastScore * 0.55 + Math.min(100, m.saturationMean * 1.5) * 0.45);
      total = sharpness * 0.45 + exposure * 0.25 + subjectQuality * 0.15 + composition * 0.15;

      if (sharpness >= 82 && exposure >= 82) {
        primaryReason = '画面全体がシャープで白飛び・黒つぶれが少ない';
      } else {
        primaryReason = '全体の解像感と階調バランスで選出';
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
