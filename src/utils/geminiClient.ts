import { GeminiJudgment, PhotoGroup } from '../types';

/**
 * グループ内の候補写真（1024px縮小済みサムネイル）を1リクエストでGemini APIへ送信し、
 * ベストショットの選定結果（JSON）を取得する
 */
export async function judgeGroupWithGemini(
  group: PhotoGroup,
  apiKey: string,
  modelName = 'gemini-2.5-flash'
): Promise<GeminiJudgment> {
  if (!apiKey.trim()) {
    throw new Error('設定画面で Gemini API キーを入力してください。');
  }

  // 最大6枚まで上位候補を送信（トークンとペイロード最適化）
  const candidates = group.photos.slice(0, 6);

  const imageParts = await Promise.all(
    candidates.map(async (photo, idx) => {
      const base64Data = await blobUrlToBase64(photo.thumbnailUrl);
      return [
        { text: `候補 index=${idx} (ファイル名: ${photo.fileName}, 初期スコア: ${photo.score.total})` },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Data
          }
        }
      ];
    })
  );

  const promptText = `あなたはプロの写真編集者・フォトグラファーです。
同じ場面で撮影された ${candidates.length} 枚の候補写真（index 0 〜 ${candidates.length - 1}）を比較し、最も優れたベストショット1枚を選出してください。
- 人物の場合は「瞳へのピント」「目つぶりしていないか」「表情の自然さ」を最優先してください。
- 料理・モノの場合は「中央の主役へのピント」「シズル感・明るさ」を重視してください。
- 風景・建物の場合は「画面全体のシャープネス」「水平の安定」「白飛び・黒つぶれの少なさ」を重視してください。
- 資料・メモの場合は「文字の判読性・くっきりさ」を重視してください。

以下のJSON形式のみで回答してください:
{
  "scene": "判別されたシーン名（人物・ペット / 料理・モノ / 風景・建物 / 資料・メモ のいずれか）",
  "bestIndex": 最も優れた写真のindex数値(0〜${candidates.length - 1}),
  "reason": "その写真を選んだ理由（日本語1〜2文で具体的に）",
  "runnerUpNote": "次点（他の候補）との違い・比較コメント（日本語1文）"
}`;

  const contents = [
    {
      parts: [...imageParts.flat(), { text: promptText }]
    }
  ];

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API エラー (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini API から有効な応答が得られませんでした。');
  }

  const parsed = JSON.parse(rawText);
  const bestIdx =
    typeof parsed.bestIndex === 'number' && parsed.bestIndex >= 0 && parsed.bestIndex < candidates.length
      ? parsed.bestIndex
      : 0;

  return {
    scene: parsed.scene || '自動判別',
    bestIndex: bestIdx,
    bestPhotoId: candidates[bestIdx].id,
    reason: parsed.reason || 'ピント・構図・表情の総合バランスが最も優れています。',
    runnerUpNote: parsed.runnerUpNote || ''
  };
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
