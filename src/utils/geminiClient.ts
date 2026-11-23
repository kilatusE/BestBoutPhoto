import { GeminiJudgment, PhotoGroup } from '../types';
import { parseAndValidateGeminiResponse } from './securityUtils';

const GEMINI_TIMEOUT_MS = 25000;
const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']);

/**
 * グループ内の候補写真をGemini APIへ送信し、ベストショットの選定結果（JSON）を取得する。
 * セキュリティ対策:
 * - APIキーをURLクエリパラメータではなく `x-goog-api-key` HTTPヘッダーで送信しURLログ漏洩を防止
 * - タイムアウト制御 (25秒)
 * - レスポンスJSONのスキーマ検証・制御文字除去
 * - エラー文字列にAPIキーが含まれないようマスキング
 */
export async function judgeGroupWithGemini(
  group: PhotoGroup,
  apiKey: string,
  modelName = 'gemini-2.5-flash'
): Promise<GeminiJudgment> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('設定画面で Gemini API キーを入力してください。');
  }

  const safeModel = ALLOWED_MODELS.has(modelName) ? modelName : 'gemini-2.5-flash';
  const candidates = group.photos.slice(0, 6);

  const imageParts = await Promise.all(
    candidates.map(async (photo, idx) => {
      const base64Data = await blobUrlToBase64(photo.thumbnailUrl);
      return [
        { text: `候補 index=${idx} (初期スコア: ${photo.score.total})` },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Data
          }
        }
      ];
    })
  );

  const promptText = `あなたはプロの写真編集者です。
同じ場面で撮影された ${candidates.length} 枚の候補写真（index 0 〜 ${candidates.length - 1}）を比較し、最も優れたベストショット1枚を選出してください。
- 人物の場合は「瞳へのピント」「目つぶりしていないか」「表情の自然さ」を最優先してください。
- 料理・モノの場合は「中央の主役へのピント」「色合い・明るさ」を重視してください。
- 風景・建物の場合は「画面全体のシャープネス」「水平の安定」「白飛び・黒つぶれの少なさ」を重視してください。
- 資料・メモの場合は「文字の判読性・くっきりさ」を重視してください。

以下のJSON形式のみで回答してください:
{
  "scene": "人物 / 料理・モノ / 風景 / 資料 のいずれか",
  "bestIndex": 最も優れた写真のindex数値(0〜${candidates.length - 1}),
  "reason": "その写真を選んだ理由（日本語1〜2文で簡潔に）",
  "runnerUpNote": "他の候補との違い（日本語1文）"
}`;

  const contents = [
    {
      parts: [...imageParts.flat(), { text: promptText }]
    }
  ];

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    safeModel
  )}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      const maskedErr = maskSecret(errText, cleanKey).slice(0, 200);
      throw new Error(`Gemini API エラー (${res.status}): ${maskedErr}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText || typeof rawText !== 'string') {
      throw new Error('Gemini API から有効な応答が得られませんでした。');
    }

    const validated = parseAndValidateGeminiResponse(rawText, candidates.length);

    return {
      scene: validated.scene,
      bestIndex: validated.bestIndex,
      bestPhotoId: candidates[validated.bestIndex].id,
      reason: validated.reason,
      runnerUpNote: validated.runnerUpNote
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Gemini API の応答がタイムアウトしました。通信環境を確認してください。');
    }
    if (err instanceof Error) {
      throw new Error(maskSecret(err.message, cleanKey));
    }
    throw new Error('AI判定中にエラーが発生しました。');
  } finally {
    clearTimeout(timer);
  }
}

function maskSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('***');
}

async function blobUrlToBase64(blobUrl: string): Promise<string> {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
