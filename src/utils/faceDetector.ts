import { FaceDetector, FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface SingleFaceAnalysis {
  box: { x: number; y: number; width: number; height: number };
  areaRatio: number;
  eyeSharpness: number;      // 0-100 (元画像フル解像度1:1ピクセルでの瞳・まつ毛シャープネス)
  faceSharpness: number;     // 0-100 (元画像高解像度での顔領域シャープネス)
  eyeOpenScore: number;      // 0-100 (Blendshape eyeBlink + 幾何学的EARによる目開き度)
  isBlinking: boolean;       // 目つぶり判定フラグ
  smileScore: number;        // 0-100 (Blendshape mouthSmile)
  frontalScore: number;      // 0-100 (顔の正面度・傾き安定度)
  faceExposureScore: number; // 0-100 (顔領域の適正露出スコア)
}

export interface PortraitAnalysisResult {
  detected: boolean;
  faceCount: number;
  totalFaceAreaRatio: number;
  primaryFace?: SingleFaceAnalysis;
  allFaces: SingleFaceAnalysis[];
  aggregatedEyeSharpness: number;
  aggregatedFaceSharpness: number;
  aggregatedEyeOpenScore: number;
  aggregatedExpressionScore: number;
  aggregatedFaceExposure: number;
  anyFaceBlinking: boolean;
}

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const DETECTOR_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let visionEnginePromise: Promise<{
  landmarker: FaceLandmarker | null;
  detector: FaceDetector | null;
}> | null = null;

// WebGL/WASM推論の同時呼び出しによるコンテキスト競合・検出漏れを防ぐ非同期ミューテックスキュー
let visionMutexChain: Promise<void> = Promise.resolve();

function runWithVisionLock<T>(task: () => Promise<T>): Promise<T> {
  const resultPromise = visionMutexChain.then(task, task);
  visionMutexChain = resultPromise.then(
    () => undefined,
    () => undefined
  );
  return resultPromise;
}

/**
 * MediaPipe FaceLandmarker (478点3Dメッシュ+52表情Blendshape) と
 * FaceDetector (横顔・マスク・小顔に強いBlazeFace) をシングルトン初期化する
 */
export function getVisionEngines(): Promise<{
  landmarker: FaceLandmarker | null;
  detector: FaceDetector | null;
}> {
  if (!visionEnginePromise) {
    visionEnginePromise = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);

        const createLandmarker = async (delegate: 'GPU' | 'CPU') =>
          FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: LANDMARKER_MODEL_URL, delegate },
            outputFaceBlendshapes: true,
            runningMode: 'IMAGE',
            numFaces: 6,
            minFaceDetectionConfidence: 0.28,
            minFacePresenceConfidence: 0.28
          });

        const createDetector = async (delegate: 'GPU' | 'CPU') =>
          FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: DETECTOR_MODEL_URL, delegate },
            runningMode: 'IMAGE',
            minDetectionConfidence: 0.38
          });

        let landmarker: FaceLandmarker | null = null;
        let detector: FaceDetector | null = null;

        try {
          [landmarker, detector] = await Promise.all([
            createLandmarker('GPU'),
            createDetector('GPU')
          ]);
        } catch {
          [landmarker, detector] = await Promise.all([
            createLandmarker('CPU').catch(() => null),
            createDetector('CPU').catch(() => null)
          ]);
        }

        return { landmarker, detector };
      } catch (err) {
        console.warn('MediaPipe initialization failed:', err);
        return { landmarker: null, detector: null };
      }
    })();
  }
  return visionEnginePromise;
}

/**
 * 1024pxサムネイルCanvasで顔・瞳の座標と表情・目開きを検出し、
 * 元画像のフル解像度ソース (fullResSource) から等倍(1:1)で瞳・まつ毛のガチピントを計測する
 */
export function analyzeFacesOnCanvas(
  thumbCanvas: HTMLCanvasElement,
  fullResSource?: CanvasImageSource,
  fullResWidth?: number,
  fullResHeight?: number
): Promise<PortraitAnalysisResult> {
  return runWithVisionLock(() =>
    analyzeFacesOnCanvasInternal(thumbCanvas, fullResSource, fullResWidth, fullResHeight)
  );
}

async function analyzeFacesOnCanvasInternal(
  thumbCanvas: HTMLCanvasElement,
  fullResSource?: CanvasImageSource,
  fullResWidth?: number,
  fullResHeight?: number
): Promise<PortraitAnalysisResult> {
  const tw = thumbCanvas.width;
  const th = thumbCanvas.height;
  const srcImage = fullResSource || thumbCanvas;
  const sw = fullResWidth || tw;
  const sh = fullResHeight || th;

  const { landmarker, detector } = await getVisionEngines();
  if (!landmarker && !detector) {
    return emptyPortraitResult();
  }

  try {
    const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
    if (!thumbCtx) return emptyPortraitResult();

    // --- Step 1: FaceLandmarker で全体画像を検査 ---
    let lmResult = landmarker ? landmarker.detect(thumbCanvas) : null;
    let offsetX = 0;
    let offsetY = 0;
    let scaleX = 1;
    let scaleY = 1;

    // --- Step 2: 全体で見つからない場合、肌色または人物想定エリアへズームクロップして再検査 ---
    // （全身ポートレートや引きの構図で顔が画面の1%以下と小さい場合でも478点ランドマークを捕捉する）
    if (landmarker && (!lmResult?.faceLandmarks || lmResult.faceLandmarks.length === 0)) {
      const candidateCrops = findPortraitZoomCrops(thumbCtx, tw, th);
      for (const crop of candidateCrops) {
        const subCanvas = document.createElement('canvas');
        subCanvas.width = crop.w;
        subCanvas.height = crop.h;
        const subCtx = subCanvas.getContext('2d');
        if (subCtx) {
          subCtx.drawImage(thumbCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
          const subRes = landmarker.detect(subCanvas);
          subCanvas.width = 0;
          subCanvas.height = 0;
          if (subRes.faceLandmarks && subRes.faceLandmarks.length > 0) {
            lmResult = subRes;
            offsetX = crop.x / tw;
            offsetY = crop.y / th;
            scaleX = crop.w / tw;
            scaleY = crop.h / th;
            break;
          }
        }
      }
    }

    const faces: SingleFaceAnalysis[] = [];

    if (lmResult && lmResult.faceLandmarks && lmResult.faceLandmarks.length > 0) {
      for (let i = 0; i < lmResult.faceLandmarks.length; i++) {
        const landmarks = lmResult.faceLandmarks[i].map((pt) => ({
          x: offsetX + pt.x * scaleX,
          y: offsetY + pt.y * scaleY,
          z: pt.z
        }));
        const blendshapes = lmResult.faceBlendshapes?.[i]?.categories || [];

        let minX = 1, maxX = 0, minY = 1, maxY = 0;
        for (const pt of landmarks) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }

        const normW = maxX - minX;
        const normH = maxY - minY;
        const areaRatio = normW * normH;
        if (areaRatio < 0.0006 || normW * tw < 12 || normH * th < 12) continue;

        // フル解像度画像(srcImage)から左右の瞳領域を1:1等倍で切り出してシャープネス計測
        const leftEyeBox = getLandmarkNormBox(landmarks, [33, 133, 159, 145, 158, 153], 0.45, 0.85);
        const rightEyeBox = getLandmarkNormBox(landmarks, [362, 263, 386, 374, 385, 380], 0.45, 0.85);

        const leftEyeSharp = measureFullResRegionSharpness(srcImage, sw, sh, leftEyeBox);
        const rightEyeSharp = measureFullResRegionSharpness(srcImage, sw, sh, rightEyeBox);
        // 手前の目（よりピントが合っている側の瞳）を75%、奥の目を25%で評価
        const eyeSharpness = Math.round(
          Math.max(leftEyeSharp, rightEyeSharp) * 0.75 +
            Math.min(leftEyeSharp, rightEyeSharp) * 0.25
        );

        // 顔領域のシャープネスと露出
        const faceNormBox = { x: minX, y: minY, w: normW, h: normH };
        const faceSharpness = measureFullResRegionSharpness(srcImage, sw, sh, faceNormBox);
        const faceExposureScore = measureThumbRegionExposure(
          thumbCtx,
          Math.max(0, Math.floor(minX * tw)),
          Math.max(0, Math.floor(minY * th)),
          Math.min(tw, Math.ceil(normW * tw)),
          Math.min(th, Math.ceil(normH * th))
        );

        // 目開き度（幾何学的EAR + MediaPipe Blendshape eyeBlinkLeft / eyeBlinkRight）
        const leftEar = computeEAR(landmarks, 33, 133, 159, 158, 145, 153);
        const rightEar = computeEAR(landmarks, 263, 362, 386, 385, 374, 380);
        const avgEar = (leftEar + rightEar) / 2;
        const earScore = Math.min(100, Math.max(0, ((avgEar - 0.11) / 0.19) * 100));

        const blinkLeft = getBlendshapeScore(blendshapes, 'eyeBlinkLeft');
        const blinkRight = getBlendshapeScore(blendshapes, 'eyeBlinkRight');
        const squintLeft = getBlendshapeScore(blendshapes, 'eyeSquintLeft');
        const squintRight = getBlendshapeScore(blendshapes, 'eyeSquintRight');

        const maxBlink = Math.max(blinkLeft, blinkRight);
        const avgBlink = (blinkLeft + blinkRight) / 2;
        const avgSquint = (squintLeft + squintRight) / 2;

        const blendEyeOpen = Math.max(
          0,
          Math.min(100, (1 - (maxBlink * 0.65 + avgBlink * 0.35)) * 100 - avgSquint * 10)
        );

        const eyeOpenScore = Math.round(blendEyeOpen * 0.65 + earScore * 0.35);
        const isBlinking = maxBlink >= 0.48 || avgEar <= 0.155 || eyeOpenScore < 48;

        // 表情・笑顔スコア
        const smileLeft = getBlendshapeScore(blendshapes, 'mouthSmileLeft');
        const smileRight = getBlendshapeScore(blendshapes, 'mouthSmileRight');
        const avgSmile = (smileLeft + smileRight) / 2;
        const frown =
          (getBlendshapeScore(blendshapes, 'mouthFrownLeft') +
            getBlendshapeScore(blendshapes, 'mouthFrownRight')) /
          2;
        const jawOpen = getBlendshapeScore(blendshapes, 'jawOpen');
        const talkingMouthPenalty = jawOpen > 0.35 && avgSmile < 0.2 ? (jawOpen - 0.35) * 35 : 0;

        const smileScore = Math.min(
          100,
          Math.max(40, Math.round(68 + avgSmile * 38 - frown * 25 - talkingMouthPenalty))
        );

        // 顔の正面度・安定度
        const nose = landmarks[1];
        const leftCheek = landmarks[234];
        const rightCheek = landmarks[454];
        let frontalScore = 80;
        if (nose && leftCheek && rightCheek) {
          const distL = Math.hypot(nose.x - leftCheek.x, nose.y - leftCheek.y);
          const distR = Math.hypot(rightCheek.x - nose.x, rightCheek.y - nose.y);
          const symmetry = Math.min(distL, distR) / Math.max(0.0001, Math.max(distL, distR));
          frontalScore = Math.round(55 + symmetry * 45);
        }

        faces.push({
          box: {
            x: Math.floor(minX * tw),
            y: Math.floor(minY * th),
            width: Math.ceil(normW * tw),
            height: Math.ceil(normH * th)
          },
          areaRatio,
          eyeSharpness,
          faceSharpness,
          eyeOpenScore,
          isBlinking,
          smileScore,
          frontalScore,
          faceExposureScore
        });
      }
    }

    // --- Step 3: FaceLandmarkerで見つからなかった横顔・俯き・小顔を BlazeFace (FaceDetector) で補完 ---
    if (faces.length === 0 && detector) {
      const detResult = detector.detect(thumbCanvas);
      if (detResult.detections && detResult.detections.length > 0) {
        for (const det of detResult.detections) {
          const bb = det.boundingBox;
          if (!bb || bb.width < 14 || bb.height < 14) continue;

          const minX = Math.max(0, bb.originX / tw);
          const minY = Math.max(0, bb.originY / th);
          const normW = Math.min(1 - minX, bb.width / tw);
          const normH = Math.min(1 - minY, bb.height / th);
          const areaRatio = normW * normH;
          if (areaRatio < 0.0008) continue;

          // BlazeFaceの目キーポイント(index 0: 左目, 1: 右目)からフル解像度ピントを計測
          const kps = det.keypoints || [];
          let eyeSharpness = 70;
          if (kps.length >= 2) {
            const eyeBoxSize = Math.max(0.025, normW * 0.26);
            const leftBox = {
              x: Math.max(0, kps[0].x - eyeBoxSize / 2),
              y: Math.max(0, kps[0].y - eyeBoxSize / 2),
              w: eyeBoxSize,
              h: eyeBoxSize * 0.75
            };
            const rightBox = {
              x: Math.max(0, kps[1].x - eyeBoxSize / 2),
              y: Math.max(0, kps[1].y - eyeBoxSize / 2),
              w: eyeBoxSize,
              h: eyeBoxSize * 0.75
            };
            const ls = measureFullResRegionSharpness(srcImage, sw, sh, leftBox);
            const rs = measureFullResRegionSharpness(srcImage, sw, sh, rightBox);
            eyeSharpness = Math.round(Math.max(ls, rs) * 0.75 + Math.min(ls, rs) * 0.25);
          }

          const faceSharpness = measureFullResRegionSharpness(srcImage, sw, sh, {
            x: minX,
            y: minY,
            w: normW,
            h: normH
          });
          if (kps.length < 2) eyeSharpness = faceSharpness;

          const faceExposureScore = measureThumbRegionExposure(
            thumbCtx,
            Math.max(0, Math.floor(bb.originX)),
            Math.max(0, Math.floor(bb.originY)),
            Math.min(tw, Math.ceil(bb.width)),
            Math.min(th, Math.ceil(bb.height))
          );

          faces.push({
            box: {
              x: Math.floor(bb.originX),
              y: Math.floor(bb.originY),
              width: Math.ceil(bb.width),
              height: Math.ceil(bb.height)
            },
            areaRatio,
            eyeSharpness,
            faceSharpness,
            eyeOpenScore: 76,
            isBlinking: false,
            smileScore: 74,
            frontalScore: 72,
            faceExposureScore
          });
        }
      }
    }

    if (faces.length === 0) {
      return emptyPortraitResult();
    }

    faces.sort((a, b) => b.areaRatio - a.areaRatio);
    const primary = faces[0];
    const totalArea = faces.reduce((acc, f) => acc + f.areaRatio, 0);

    const mainFaces = faces.filter((f) => f.areaRatio >= primary.areaRatio * 0.25);
    const anyFaceBlinking = mainFaces.some((f) => f.isBlinking);
    const minEyeOpenAcrossFaces = Math.min(...mainFaces.map((f) => f.eyeOpenScore));

    const aggregatedEyeSharpness =
      mainFaces.length === 1
        ? primary.eyeSharpness
        : Math.round(
            primary.eyeSharpness * 0.7 +
              (mainFaces.reduce((s, f) => s + f.eyeSharpness, 0) / mainFaces.length) * 0.3
          );

    const aggregatedFaceSharpness =
      mainFaces.length === 1
        ? primary.faceSharpness
        : Math.round(
            primary.faceSharpness * 0.7 +
              (mainFaces.reduce((s, f) => s + f.faceSharpness, 0) / mainFaces.length) * 0.3
          );

    const aggregatedEyeOpenScore =
      mainFaces.length === 1
        ? primary.eyeOpenScore
        : Math.round(primary.eyeOpenScore * 0.55 + minEyeOpenAcrossFaces * 0.45);

    const primaryExpr = Math.round(primary.smileScore * 0.65 + primary.frontalScore * 0.35);
    const avgExpr =
      mainFaces.reduce((s, f) => s + (f.smileScore * 0.65 + f.frontalScore * 0.35), 0) /
      mainFaces.length;
    const aggregatedExpressionScore = Math.round(primaryExpr * 0.65 + avgExpr * 0.35);

    return {
      detected: true,
      faceCount: mainFaces.length,
      totalFaceAreaRatio: totalArea,
      primaryFace: primary,
      allFaces: mainFaces,
      aggregatedEyeSharpness,
      aggregatedFaceSharpness,
      aggregatedEyeOpenScore,
      aggregatedExpressionScore,
      aggregatedFaceExposure: primary.faceExposureScore,
      anyFaceBlinking
    };
  } catch (err) {
    console.warn('Face detection error:', err);
    return emptyPortraitResult();
  }
}

/**
 * 全身ポートレートや三分割構図で顔が小さい場合のため、肌色密度の高い領域＋中央上部クロップ領域を算出する
 */
function findPortraitZoomCrops(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): Array<{ x: number; y: number; w: number; h: number }> {
  const crops: Array<{ x: number; y: number; w: number; h: number }> = [];

  // 1. 肌色ピクセルの重心を探してその周辺を45%サイズでクロップ
  const step = 8;
  const data = ctx.getImageData(0, 0, w, h).data;
  let skinSumX = 0;
  let skinSumY = 0;
  let skinCount = 0;

  for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.78); y += step) {
    for (let x = Math.floor(w * 0.08); x < Math.floor(w * 0.92); x += step) {
      const p = (y * w + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (lum > 45 && lum < 235 && cr >= 136 && cr <= 173 && cb >= 88 && cb <= 125 && r > g) {
        skinSumX += x;
        skinSumY += y;
        skinCount++;
      }
    }
  }

  if (skinCount >= 6) {
    const cx = skinSumX / skinCount;
    const cy = skinSumY / skinCount;
    const cw = Math.floor(w * 0.48);
    const ch = Math.floor(h * 0.48);
    const rx = Math.max(0, Math.min(w - cw, Math.floor(cx - cw / 2)));
    const ry = Math.max(0, Math.min(h - ch, Math.floor(cy - ch * 0.55)));
    crops.push({ x: rx, y: ry, w: cw, h: ch });
  }

  // 2. 標準的なポートレート中央上部領域
  crops.push({
    x: Math.floor(w * 0.2),
    y: Math.floor(h * 0.04),
    w: Math.floor(w * 0.6),
    h: Math.floor(h * 0.65)
  });

  return crops;
}

function getLandmarkNormBox(
  landmarks: Array<{ x: number; y: number }>,
  indices: number[],
  padXFactor: number,
  padYFactor: number
): { x: number; y: number; w: number; h: number } {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const idx of indices) {
    const pt = landmarks[idx];
    if (!pt) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const padX = (maxX - minX) * padXFactor;
  const padY = (maxY - minY) * padYFactor;
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  const w = Math.min(1 - x, maxX - minX + padX * 2);
  const h = Math.min(1 - y, maxY - minY + padY * 2);
  return { x, y, w, h };
}

/**
 * 元画像のフル解像度ソース (50MP等のImageBitmap) から指定の正規化矩形領域のみを直接切り出し、
 * 縮小で潰れない「真の等倍ピント（まつ毛・虹彩のエッジ鋭度）」を計測する
 */
function measureFullResRegionSharpness(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  normBox: { x: number; y: number; w: number; h: number }
): number {
  const sx = Math.max(0, Math.floor(normBox.x * srcW));
  const sy = Math.max(0, Math.floor(normBox.y * srcH));
  const sw = Math.min(srcW - sx, Math.max(8, Math.ceil(normBox.w * srcW)));
  const sh = Math.min(srcH - sy, Math.max(8, Math.ceil(normBox.h * srcH)));

  if (sw < 6 || sh < 6) return 65;

  // フル解像度の切り出しが巨大な場合でも最大256px四方に抑えて高速計算
  const maxCropDim = 256;
  const scale = Math.min(1, maxCropDim / Math.max(sw, sh));
  const cw = Math.max(8, Math.round(sw * scale));
  const ch = Math.max(8, Math.round(sh * scale));

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cw;
  cropCanvas.height = ch;
  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 65;

  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
  const imgData = ctx.getImageData(0, 0, cw, ch).data;
  cropCanvas.width = 0;
  cropCanvas.height = 0;

  const gray = new Float32Array(cw * ch);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * imgData[p] + 0.587 * imgData[p + 1] + 0.114 * imgData[p + 2];
  }

  // 上位20%のエッジエネルギー（まつ毛・瞳のキャッチライトの鋭さ）の平均を算出
  const energies: number[] = [];
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const idx = y * cw + x;
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + cw] - gray[idx - cw];
      const lap = Math.abs(
        4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - cw] - gray[idx + cw]
      );
      energies.push(Math.hypot(gx, gy) * 0.55 + lap * 0.45);
    }
  }

  if (energies.length === 0) return 65;
  energies.sort((a, b) => b - a);
  const topCount = Math.max(1, Math.floor(energies.length * 0.2));
  let topSum = 0;
  for (let i = 0; i < topCount; i++) {
    topSum += energies[i];
  }
  const topMean = topSum / topCount;

  return Math.min(100, Math.max(20, Math.round((1 - Math.exp(-topMean / 30)) * 104)));
}

function measureThumbRegionExposure(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  bw: number,
  bh: number
): number {
  if (bw < 4 || bh < 4) return 75;
  const imgData = ctx.getImageData(bx, by, bw, bh).data;
  const total = bw * bh;
  let sumLum = 0;
  let overClipped = 0;
  let underClipped = 0;

  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const lum = 0.299 * imgData[p] + 0.587 * imgData[p + 1] + 0.114 * imgData[p + 2];
    sumLum += lum;
    if (lum > 245) overClipped++;
    if (lum < 22) underClipped++;
  }

  const meanLum = sumLum / Math.max(1, total);
  const idealDiff = Math.abs(meanLum - 138);
  const clipPenalty = ((overClipped + underClipped) / Math.max(1, total)) * 140;
  return Math.min(
    100,
    Math.max(25, Math.round(96 - Math.max(0, idealDiff - 18) * 0.45 - clipPenalty))
  );
}

function emptyPortraitResult(): PortraitAnalysisResult {
  return {
    detected: false,
    faceCount: 0,
    totalFaceAreaRatio: 0,
    allFaces: [],
    aggregatedEyeSharpness: 0,
    aggregatedFaceSharpness: 0,
    aggregatedEyeOpenScore: 75,
    aggregatedExpressionScore: 75,
    aggregatedFaceExposure: 75,
    anyFaceBlinking: false
  };
}

function getBlendshapeScore(
  categories: Array<{ categoryName: string; score: number }>,
  name: string
): number {
  const found = categories.find((c) => c.categoryName === name);
  return found ? found.score : 0;
}

function computeEAR(
  landmarks: Array<{ x: number; y: number }>,
  p1Idx: number,
  p4Idx: number,
  p2Idx: number,
  p3Idx: number,
  p6Idx: number,
  p5Idx: number
): number {
  const p1 = landmarks[p1Idx];
  const p2 = landmarks[p2Idx];
  const p3 = landmarks[p3Idx];
  const p4 = landmarks[p4Idx];
  const p5 = landmarks[p5Idx];
  const p6 = landmarks[p6Idx];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0.25;

  const vert1 = Math.hypot(p2.x - p6.x, p2.y - p6.y);
  const vert2 = Math.hypot(p3.x - p5.x, p3.y - p5.y);
  const horiz = Math.hypot(p1.x - p4.x, p1.y - p4.y);
  if (horiz <= 0.0001) return 0.25;
  return (vert1 + vert2) / (2.0 * horiz);
}
