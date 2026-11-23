export type SceneType = 'portrait' | 'document' | 'food' | 'landscape';

export interface ExifInfo {
  dateTimeOriginal?: string;
  timestamp: number;
  make?: string;
  model?: string;
  lensModel?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: number; // in seconds, e.g. 0.002 for 1/500
  iso?: number;
  width: number;
  height: number;
  hasGps: boolean;
  gpsLatitude?: number;
  gpsLongitude?: number;
}

export interface RawImageMetrics {
  globalSharpness: number;      // 0-100
  centerSharpness: number;      // 0-100
  faceRegionSharpness: number;  // 0-100
  eyeRegionSharpness: number;   // 0-100 (1024pxでの瞳・まつ毛ピント)
  faceCount: number;
  faceAreaRatio: number;        // 0-1
  eyeOpenScore: number;         // 0-100
  isBlinking: boolean;          // 目つぶり検出フラグ
  smileOrFrontalScore: number;  // 0-100
  faceExposureScore: number;    // 0-100 (顔領域の露出スコア)
  skinToneRatio: number;        // 0-1
  whiteBgRatio: number;         // 0-1
  textEdgeDensity: number;      // 0-100
  warmColorRatio: number;       // 0-1
  saturationMean: number;       // 0-100
  brightnessMean: number;       // 0-100
  overExposedRatio: number;     // 0-1
  underExposedRatio: number;    // 0-1
  contrastScore: number;        // 0-100
  horizonStraightness: number;  // 0-100
}

export interface ScoreBreakdown {
  sharpness: number;            // ピント・解像感 (0-100)
  exposure: number;             // 露出・階調 (0-100)
  subjectQuality: number;       // 被写体・表情・目開き/文字明瞭度 (0-100)
  composition: number;          // 構図・彩度・水平 (0-100)
  total: number;                // 総合スコア (0-100, 小数第1位)
  primaryReason: string;        // 自動生成された高評価/減点ポイント
}

export interface PhotoItem {
  id: string;
  file: File;
  fileName: string;
  baseName: string;
  rawFile?: File;
  rawFileName?: string;
  thumbnailUrl: string;         // 長辺1024px縮小Blob URL（省メモリ用）
  thumbnailWidth: number;
  thumbnailHeight: number;
  exif: ExifInfo;
  dHash: string;                // 64-bit hex string or binary string
  colorHist: number[];          // 48-bin RGB/HSV normalized histogram
  metrics: RawImageMetrics;
  scene: SceneType;
  score: ScoreBreakdown;
}

export interface GeminiJudgment {
  scene: string;
  bestPhotoId: string;
  bestIndex: number;
  reason: string;
  runnerUpNote: string;
}

export interface PhotoGroup {
  id: string;
  photos: PhotoItem[];          // スコア降順ソート済み
  selectedIds: string[];        // 採用された写真のID配列（デフォルトは1位の1枚、複数採用可）
  excluded: boolean;            // グループ丸ごと除外フラグ
  scene: SceneType;
  isCloseCall: boolean;         // 1位と2位の差がしきい値未満
  scoreDiff: number;
  captureTimeRange: {
    start: number;
    end: number;
  };
  geminiJudgment?: GeminiJudgment;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  pairRaw: boolean;
  groupingSensitivity: number;  // 0 (厳しめ) 〜 100 (ゆるめ), default 50
  closeCallThreshold: number;   // default 5.0
  geminiApiKey: string;
  geminiModel: string;
  googleClientId: string;
  googleDriveParentFolderId: string;
}

export interface ExportOptions {
  folderName: string;
  stripGps: boolean;
  local: {
    enabled: boolean;
    includeRaw: boolean;
  };
  googleDrive: {
    enabled: boolean;
    maxDimension: number;       // default 4096 (0 = original)
    jpegQuality: number;        // default 0.88
    includeRaw: boolean;
  };
  amazonPhotos: {
    enabled: boolean;
    includeRaw: boolean;
    useWebShare: boolean;
  };
}
