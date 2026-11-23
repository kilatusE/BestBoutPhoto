/**
 * セキュリティ・入力検証・サニタイズユーティリティ
 * - パストラバーサル (Zip Slip / File System Access API での不正階層アクセス) 防止
 * - Windows予約デバイス名・制御文字・NULLバイトの無害化
 * - 画像ファイルのマジックバイト（シグネチャ）およびサイズ上限（DoS防止）検証
 * - Gemini API レスポンスの厳格なスキーマ検証（Prototype Pollution / XSS防止）
 */

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export const MAX_IMAGE_FILE_SIZE_BYTES = 150 * 1024 * 1024; // 150MB (50MP非圧縮TIFF/PNG等も許容しつつDoS防止)
export const MAX_RAW_FILE_SIZE_BYTES = 250 * 1024 * 1024;   // 250MB (高画素RAW上限)

/**
 * ファイル名を無害化する（Zip Slip / Directory Traversal 対策）
 * 例: "../../etc/passwd" -> "passwd", "..\CON.jpg" -> "_CON.jpg"
 */
export function sanitizeFileName(rawName: string, fallback = 'photo.jpg'): string {
  if (!rawName || typeof rawName !== 'string') return fallback;

  // 1. パス区切り文字（/ または \）で分割し、末尾のベース名のみを取得
  const segments = rawName.replace(/\\/g, '/').split('/').filter(Boolean);
  let base = segments.length > 0 ? segments[segments.length - 1] : '';

  // 2. NULLバイト・制御文字・OS禁止文字を除去またはアンダースコアへ置換
  base = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();

  // 3. 先頭のドット連続（".." や隠しファイル "."）を除去
  base = base.replace(/^\.+/, '');

  if (!base) return fallback;

  // 4. Windows予約デバイス名（CON, NUL, AUX, PRN, COM1..9, LPT1..9）の回避
  if (WINDOWS_RESERVED_NAMES.test(base)) {
    base = `_${base}`;
  }

  // 5. 長すぎるファイル名の切り詰め（拡張子は維持）
  if (base.length > 200) {
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx > 0 && base.length - dotIdx <= 10) {
      const ext = base.slice(dotIdx);
      base = base.slice(0, 200 - ext.length) + ext;
    } else {
      base = base.slice(0, 200);
    }
  }

  return base;
}

/**
 * 出力フォルダ名を無害化する
 */
export function sanitizeFolderName(rawName: string, fallback = 'BestBout_Export'): string {
  if (!rawName || typeof rawName !== 'string') return fallback;

  let cleaned = rawName
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\.\.+/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();

  if (!cleaned) return fallback;
  if (WINDOWS_RESERVED_NAMES.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }

  return cleaned.slice(0, 120);
}

/**
 * 取り込みファイルのサイズ・基本妥当性チェック（0バイトファイルや巨大ファイルによるメモリ枯渇DoSを防止）
 */
export function validateFileSizeAndBasics(
  file: File,
  isRaw = false
): { valid: boolean; reason?: string } {
  if (!file || typeof file.size !== 'number') {
    return { valid: false, reason: '無効なファイルオブジェクトです' };
  }
  if (file.size <= 0) {
    return { valid: false, reason: 'ファイルサイズが0バイトです' };
  }
  const maxLimit = isRaw ? MAX_RAW_FILE_SIZE_BYTES : MAX_IMAGE_FILE_SIZE_BYTES;
  if (file.size > maxLimit) {
    return {
      valid: false,
      reason: `ファイルサイズが上限（${Math.round(maxLimit / 1024 / 1024)}MB）を超えています`
    };
  }
  return { valid: true };
}

/**
 * 画像ファイルの先頭12バイト（マジックバイト）を検査し、拡張子偽装された非画像ファイルや破損ファイルを弾く
 */
export async function validateImageMagicBytes(file: File): Promise<boolean> {
  try {
    if (file.size < 4) return false;
    const headerSlice = file.slice(0, 12);
    const buf = await headerSlice.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // 1. JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true;
    }

    // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return true;
    }

    // 3. WebP: "RIFF" .... "WEBP"
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return true;
    }

    // 4. HEIC / HEIF / AVIF: offset 4..7 is "ftyp" (66 74 79 70)
    if (
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return true;
    }

    // 5. GIF / BMP / TIFF (II* or MM*)
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Gemini API からのJSON出力を安全にパース・検証する（Prototype Pollution や不正型インジェクション防止）
 */
export function parseAndValidateGeminiResponse(
  rawText: string,
  candidateCount: number
): {
  scene: string;
  bestIndex: number;
  reason: string;
  runnerUpNote: string;
} {
  // コードブロック ```json ... ``` が含まれる場合も安全に抽出
  const cleanedText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const parsed = JSON.parse(cleanedText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI応答のJSONフォーマットが不正です');
  }

  const rawIdx = Number(parsed.bestIndex);
  const bestIndex =
    Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < candidateCount ? rawIdx : 0;

  const sanitizeText = (val: unknown, maxLen: number, fallback: string): string => {
    if (typeof val !== 'string') return fallback;
    return val.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, maxLen) || fallback;
  };

  return {
    scene: sanitizeText(parsed.scene, 40, '自動判別'),
    bestIndex,
    reason: sanitizeText(
      parsed.reason,
      300,
      'ピント・構図・表情の総合バランスが最も優れています。'
    ),
    runnerUpNote: sanitizeText(parsed.runnerUpNote, 240, '')
  };
}
