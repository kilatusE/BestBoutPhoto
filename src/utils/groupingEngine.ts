import { PhotoGroup, PhotoItem, SceneType } from '../types';
import { calculateSceneScore } from './imageAnalyzer';

export function dHashSimilarity(hashA: string, hashB: string): number {
  if (!hashA || !hashB || hashA.length !== hashB.length) return 0;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) diff++;
  }
  return 1 - diff / hashA.length;
}

export function histogramSimilarity(histA: number[], histB: number[]): number {
  if (!histA || !histB || histA.length !== histB.length) return 0;
  let intersection = 0;
  for (let i = 0; i < histA.length; i++) {
    intersection += Math.min(histA[i], histB[i]);
  }
  return Math.min(1, intersection / 3);
}

export function groupPhotosBySimilarity(
  photos: PhotoItem[],
  sensitivity: number,
  closeCallThreshold = 5.0
): PhotoGroup[] {
  if (photos.length === 0) return [];

  const sorted = [...photos].sort((a, b) => {
    if (a.exif.timestamp !== b.exif.timestamp) {
      return a.exif.timestamp - b.exif.timestamp;
    }
    return a.fileName.localeCompare(b.fileName);
  });

  const normSens = Math.max(0, Math.min(100, sensitivity)) / 100;
  const similarityThreshold = 0.82 - normSens * 0.24;
  const hardVisualFloor = 0.48 - normSens * 0.1;
  const maxTimeWindowSec = 15 + normSens * 165;

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

    const hashSimLast = dHashSimilarity(photo.dHash, lastPhoto.dHash);
    const histSimLast = histogramSimilarity(photo.colorHist, lastPhoto.colorHist);
    const visualSimLast = hashSimLast * 0.58 + histSimLast * 0.42;

    const hashSimFirst = dHashSimilarity(photo.dHash, firstPhoto.dHash);
    const histSimFirst = histogramSimilarity(photo.colorHist, firstPhoto.colorHist);
    const visualSimFirst = hashSimFirst * 0.58 + histSimFirst * 0.42;

    const bestVisualSim = Math.max(visualSimLast, visualSimFirst * 0.96);

    let timeBonus = 0;
    if (bestVisualSim >= hardVisualFloor) {
      if (timeDiffSec <= 2.5) {
        timeBonus = 0.14;
      } else if (timeDiffSec <= 10) {
        timeBonus = 0.08;
      } else if (timeDiffSec <= 30) {
        timeBonus = 0.03;
      }
    }

    const effectiveSimilarity = bestVisualSim + timeBonus;

    const canJoin =
      bestVisualSim >= hardVisualFloor &&
      ((timeDiffSec <= maxTimeWindowSec && effectiveSimilarity >= similarityThreshold) ||
        bestVisualSim >= similarityThreshold + 0.1);

    if (canJoin) {
      currentCluster.push(photo);
    } else {
      rawClusters.push([photo]);
    }
  }

  return rawClusters.map((cluster, idx) => buildPhotoGroup(cluster, idx, closeCallThreshold));
}

function buildPhotoGroup(
  cluster: PhotoItem[],
  groupIndex: number,
  closeCallThreshold: number
): PhotoGroup {
  // グループ内で1枚でもMediaPipeが人物の顔を検出していれば、連写グループ全体を「人物(portrait)」として扱う
  const hasAnyFaceInCluster = cluster.some((p) => p.metrics.faceCount > 0);

  let groupScene: SceneType = cluster[0].scene;
  if (hasAnyFaceInCluster) {
    groupScene = 'portrait';
  } else {
    const sceneCounts = new Map<SceneType, number>();
    for (const p of cluster) {
      sceneCounts.set(p.scene, (sceneCounts.get(p.scene) || 0) + 1);
    }
    let maxCount = -1;
    for (const [sc, cnt] of sceneCounts.entries()) {
      if (cnt > maxCount) {
        maxCount = cnt;
        groupScene = sc;
      }
    }
  }

  // グループ内での最高目開き度・最高瞳ピント・最高全体シャープネスを取得して相対比較を行う
  const faceDetectedPhotos = cluster.filter((p) => p.metrics.faceCount > 0);
  const maxEyeOpen =
    faceDetectedPhotos.length > 0
      ? Math.max(...faceDetectedPhotos.map((p) => p.metrics.eyeOpenScore))
      : Math.max(...cluster.map((p) => p.metrics.eyeOpenScore));
  const maxEyeSharpness =
    faceDetectedPhotos.length > 0
      ? Math.max(...faceDetectedPhotos.map((p) => p.metrics.eyeRegionSharpness))
      : Math.max(...cluster.map((p) => p.metrics.centerSharpness));
  const maxSharpness = Math.max(...cluster.map((p) => p.metrics.globalSharpness));

  const refinedPhotos: PhotoItem[] = cluster.map((p) => {
    const baseScore = calculateSceneScore(groupScene, p.metrics);
    let adjustedTotal = baseScore.total;
    let adjustedReason = baseScore.primaryReason;

    if (cluster.length >= 2) {
      if (groupScene === 'portrait') {
        // 連写内で他のカットでは顔が検出されているのに、このカットだけ横向き・ブレ等で顔未検出の場合
        if (hasAnyFaceInCluster && p.metrics.faceCount === 0) {
          adjustedTotal = Math.max(10, Math.round((adjustedTotal - 12) * 10) / 10);
          adjustedReason = '他の連写カットと比較して顔が隠れているか大きくブレています';
        } else if (p.metrics.isBlinking || maxEyeOpen - p.metrics.eyeOpenScore >= 9) {
          // 連写内の最良カットより目開き度が9点以上低い場合は半目・まばたきとして減点
          const drop = Math.max(6, (maxEyeOpen - p.metrics.eyeOpenScore) * 0.75);
          adjustedTotal = Math.max(10, Math.round((adjustedTotal - drop) * 10) / 10);
          adjustedReason = '連写内の他カットと比べて目つぶり・半目の可能性';
        } else if (maxEyeSharpness - p.metrics.eyeRegionSharpness >= 7) {
          const drop = Math.min(8, (maxEyeSharpness - p.metrics.eyeRegionSharpness) * 0.55);
          adjustedTotal = Math.max(10, Math.round((adjustedTotal - drop) * 10) / 10);
          adjustedReason = '連写内の1位と比べて瞳・顔のピントがやや甘め';
        }
      } else if (maxSharpness - p.metrics.globalSharpness >= 8) {
        adjustedTotal = Math.max(10, Math.round((adjustedTotal - 4.5) * 10) / 10);
        adjustedReason = '連写内の1位と比べてわずかにピント甘め・微ブレ';
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

  refinedPhotos.sort((a, b) => {
    if (b.score.total !== a.score.total) {
      return b.score.total - a.score.total;
    }
    return a.exif.timestamp - b.exif.timestamp;
  });

  // 1位の写真の選出理由を2位との比較で具体的に記載
  if (refinedPhotos.length >= 2) {
    const first = refinedPhotos[0];
    const second = refinedPhotos[1];
    if (groupScene === 'portrait') {
      if (second.metrics.isBlinking || first.metrics.eyeOpenScore >= second.metrics.eyeOpenScore + 8) {
        first.score.primaryReason = '目がしっかり開いており表情・ピントが最良';
      } else if (first.metrics.eyeRegionSharpness >= second.metrics.eyeRegionSharpness + 3) {
        first.score.primaryReason = `${refinedPhotos.length}枚中で瞳へのピントが最もシャープ`;
      } else if (first.metrics.smileOrFrontalScore >= second.metrics.smileOrFrontalScore + 3) {
        first.score.primaryReason = `${refinedPhotos.length}枚中で表情・顔の向きが最も自然`;
      }
    } else if (first.score.sharpness > second.score.sharpness + 2) {
      first.score.primaryReason = `${refinedPhotos.length}枚中で最もピントがシャープ`;
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
    selectedIds: [refinedPhotos[0].id],
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
    label: '人物',
    shortLabel: '人物',
    badgeClass: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
    description: '瞳のピント、目開き、表情、顔の明るさを重視'
  },
  document: {
    label: '資料',
    shortLabel: '資料',
    badgeClass: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    description: '文字のくっきりさ、白飛びの少なさを重視'
  },
  food: {
    label: '料理・モノ',
    shortLabel: '料理・モノ',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    description: '中央のピント、色合い、明るさを重視'
  },
  landscape: {
    label: '風景',
    shortLabel: '風景',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    description: '全体のシャープネス、階調、水平を重視'
  }
};
