import { PhotoGroup, PhotoItem, SceneType } from '../types';
import { calculateSceneScore } from './imageAnalyzer';

/**
 * 64bit dHash 間のハミング距離から類似度 (0.0 〜 1.0) を算出
 */
export function dHashSimilarity(hashA: string, hashB: string): number {
  if (!hashA || !hashB || hashA.length !== hashB.length) return 0;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) diff++;
  }
  return 1 - diff / hashA.length;
}

/**
 * 48ビン正規化カラーヒストグラム間の類似度 (Histogram Intersection: 0.0 〜 1.0)
 */
export function histogramSimilarity(histA: number[], histB: number[]): number {
  if (!histA || !histB || histA.length !== histB.length) return 0;
  let intersection = 0;
  for (let i = 0; i < histA.length; i++) {
    intersection += Math.min(histA[i], histB[i]);
  }
  // R, G, B それぞれ合計1.0で3チャンネル分あるため3で割る
  return Math.min(1, intersection / 3);
}

/**
 * 保存済みの特徴量からリアルタイムに類似写真グルーピングを行う（再デコード不要）
 * @param photos 解析済み写真リスト
 * @param sensitivity 0(厳しめ: ほぼ同じ構図のみ) 〜 100(ゆるめ: 同じシーン・連写を広くまとめる), デフォルト 50
 * @param closeCallThreshold 僅差判定のスコア差しきい値（デフォルト 5.0）
 */
export function groupPhotosBySimilarity(
  photos: PhotoItem[],
  sensitivity: number,
  closeCallThreshold = 5.0
): PhotoGroup[] {
  if (photos.length === 0) return [];

  // 1. 撮影日時順（同秒の場合はファイル名順）にソート
  const sorted = [...photos].sort((a, b) => {
    if (a.exif.timestamp !== b.exif.timestamp) {
      return a.exif.timestamp - b.exif.timestamp;
    }
    return a.fileName.localeCompare(b.fileName);
  });

  // 感度スライダー(0〜100)に応じたしきい値設定
  // sensitivity が高いほど threshold が下がり、まとまりやすくなる
  const normSens = Math.max(0, Math.min(100, sensitivity)) / 100;
  const similarityThreshold = 0.82 - normSens * 0.24; // 0.82 (厳しめ) 〜 0.58 (ゆるめ)
  const hardVisualFloor = 0.48 - normSens * 0.1;      // これ未満の別被写体は連写直後でも絶対分離
  const maxTimeWindowSec = 15 + normSens * 165;       // 15秒 〜 180秒

  const rawClusters: PhotoItem[][] = [];

  for (const photo of sorted) {
    if (rawClusters.length === 0) {
      rawClusters.push([photo]);
      continue;
    }

    const currentCluster = rawClusters[rawClusters.length - 1];
    const lastPhoto = currentCluster[currentCluster.length - 1];
    const firstPhoto = currentCluster[0];

    const timeDiffSec = Math.abs(photo.exif.timestamp - lastPhoto.exif.timestamp) / 1000;

    // 直前の写真およびグループの先頭写真との視覚的類似度を計算
    const hashSimLast = dHashSimilarity(photo.dHash, lastPhoto.dHash);
    const histSimLast = histogramSimilarity(photo.colorHist, lastPhoto.colorHist);
    const visualSimLast = hashSimLast * 0.58 + histSimLast * 0.42;

    const hashSimFirst = dHashSimilarity(photo.dHash, firstPhoto.dHash);
    const histSimFirst = histogramSimilarity(photo.colorHist, firstPhoto.colorHist);
    const visualSimFirst = hashSimFirst * 0.58 + histSimFirst * 0.42;

    const bestVisualSim = Math.max(visualSimLast, visualSimFirst * 0.96);

    // 時間ボーナス（SPEC 4.2: 数秒〜10秒以内の連写は少し動きがあっても同グループになりやすくする）
    // ただし見た目が大きく異なる別被写体（bestVisualSim < hardVisualFloor）は分離する
    let timeBonus = 0;
    if (bestVisualSim >= hardVisualFloor) {
      if (timeDiffSec <= 2.5) {
        timeBonus = 0.14; // 高速連写ボーナス
      } else if (timeDiffSec <= 10) {
        timeBonus = 0.08; // 撮り直し連写ボーナス
      } else if (timeDiffSec <= 30) {
        timeBonus = 0.03;
      }
    }

    const effectiveSimilarity = bestVisualSim + timeBonus;

    // 時間差が許容ウィンドウ内かつ有効類似度がしきい値以上なら同一グループへ追加
    const canJoin =
      bestVisualSim >= hardVisualFloor &&
      ((timeDiffSec <= maxTimeWindowSec && effectiveSimilarity >= similarityThreshold) ||
        bestVisualSim >= similarityThreshold + 0.1); // 時間が離れていても見た目が極めて酷似していれば統合

    if (canJoin) {
      currentCluster.push(photo);
    } else {
      rawClusters.push([photo]);
    }
  }

  // 各クラスター内でシーン統一・相対比較補正・スコア順ソートを実施
  return rawClusters.map((cluster, idx) => buildPhotoGroup(cluster, idx, closeCallThreshold));
}

function buildPhotoGroup(
  cluster: PhotoItem[],
  groupIndex: number,
  closeCallThreshold: number
): PhotoGroup {
  // グループ内の多数決シーンを決定
  const sceneCounts = new Map<SceneType, number>();
  for (const p of cluster) {
    sceneCounts.set(p.scene, (sceneCounts.get(p.scene) || 0) + 1);
  }
  let groupScene: SceneType = cluster[0].scene;
  let maxCount = -1;
  for (const [sc, cnt] of sceneCounts.entries()) {
    if (cnt > maxCount) {
      maxCount = cnt;
      groupScene = sc;
    }
  }

  // グループ内の最大シャープネス・最大目開き度を基準に相対補正（連写内の目つぶり・微ブレ検出精度向上）
  const maxEyeOpen = Math.max(...cluster.map((p) => p.metrics.eyeOpenScore));
  const maxSharpness = Math.max(...cluster.map((p) => p.metrics.globalSharpness));

  const refinedPhotos: PhotoItem[] = cluster.map((p) => {
    const baseScore = calculateSceneScore(groupScene, p.metrics);
    let adjustedTotal = baseScore.total;
    let adjustedReason = baseScore.primaryReason;

    if (cluster.length >= 2) {
      // 人物シーンで他の連写カットより目開き度が大きく落ちている場合は目つぶり減点
      if (groupScene === 'portrait' && maxEyeOpen - p.metrics.eyeOpenScore >= 12) {
        adjustedTotal = Math.max(10, Math.round((adjustedTotal - 8.5) * 10) / 10);
        adjustedReason = '連写内の他カットと比較して目つぶり・まばたきの可能性';
      } else if (maxSharpness - p.metrics.globalSharpness >= 10) {
        adjustedTotal = Math.max(10, Math.round((adjustedTotal - 4.0) * 10) / 10);
        adjustedReason = '連写内のベストカットと比較してわずかにピント甘め・微ブレ';
      }
    }

    return {
      ...p,
      scene: groupScene,
      score: {
        ...baseScore,
        total: adjustedTotal,
        primaryReason: adjustedReason
      }
    };
  });

  // スコア降順ソート（同点の場合は撮影順）
  refinedPhotos.sort((a, b) => {
    if (b.score.total !== a.score.total) {
      return b.score.total - a.score.total;
    }
    return a.exif.timestamp - b.exif.timestamp;
  });

  // 1位の写真の選定理由をより分かりやすく補強
  if (refinedPhotos.length >= 2) {
    const first = refinedPhotos[0];
    const second = refinedPhotos[1];
    const diff = Math.round((first.score.total - second.score.total) * 10) / 10;
    if (first.score.sharpness > second.score.sharpness + 3) {
      first.score.primaryReason = `${refinedPhotos.length}枚中で最もピントがシャープ（2位と+${diff}点差）`;
    } else if (groupScene === 'portrait' && first.score.subjectQuality > second.score.subjectQuality + 3) {
      first.score.primaryReason = `${refinedPhotos.length}枚中で目開き・表情バランスが最良（2位と+${diff}点差）`;
    }
  }

  const timestamps = refinedPhotos.map((p) => p.exif.timestamp);
  const scoreDiff =
    refinedPhotos.length >= 2
      ? Math.round((refinedPhotos[0].score.total - refinedPhotos[1].score.total) * 10) / 10
      : 100;

  const isCloseCall = refinedPhotos.length >= 2 && scoreDiff < closeCallThreshold;

  return {
    id: `group_${groupIndex}_${refinedPhotos[0].id}`,
    photos: refinedPhotos,
    selectedIds: [refinedPhotos[0].id], // デフォルトで暫定1位を採用
    excluded: false,
    scene: groupScene,
    isCloseCall,
    scoreDiff,
    captureTimeRange: {
      start: Math.min(...timestamps),
      end: Math.max(...timestamps)
    }
  };
}

export const SCENE_META: Record<
  SceneType,
  { label: string; shortLabel: string; badgeClass: string; description: string }
> = {
  portrait: {
    label: '人物・ペット',
    shortLabel: '人物',
    badgeClass: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
    description: '顔・瞳のピント、目開き度、表情・露出を重視'
  },
  document: {
    label: '資料・メモ',
    shortLabel: '資料',
    badgeClass: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    description: '文字の輪郭コントラスト、シャープネス、白飛びの少なさを重視'
  },
  food: {
    label: '料理・モノ',
    shortLabel: '料理/モノ',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    description: '中央被写体のピント、彩度・暖色ツヤ、適正な明るさを重視'
  },
  landscape: {
    label: '風景・建物',
    shortLabel: '風景',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    description: '画面全体のシャープネス、白飛び/黒つぶれの少なさ、水平を重視'
  }
};
