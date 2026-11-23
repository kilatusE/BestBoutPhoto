import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Check,
  Sparkles,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Trash2,
  Layers,
  ChevronLeft,
  ChevronRight,
  Award,
  Camera,
  Clock,
  MapPin,
  Loader2
} from 'lucide-react';
import { PhotoGroup, PhotoItem } from '../types';
import { SCENE_META } from '../utils/groupingEngine';
import { formatShutterSpeed } from '../utils/exifUtils';

interface BoutCompareModalProps {
  group: PhotoGroup | null;
  groupIndex: number;
  totalGroups: number;
  hasGeminiKey: boolean;
  isJudgingGemini: boolean;
  onClose: () => void;
  onPrevGroup: () => void;
  onNextGroup: () => void;
  onSelectSingleBest: (groupId: string, photoId: string) => void;
  onToggleMultiSelect: (groupId: string, photoIdA: string, photoIdB: string) => void;
  onToggleExcludeGroup: (groupId: string) => void;
  onAskGemini: (group: PhotoGroup) => void;
}

export const BoutCompareModal: React.FC<BoutCompareModalProps> = ({
  group,
  groupIndex,
  totalGroups,
  hasGeminiKey,
  isJudgingGemini,
  onClose,
  onPrevGroup,
  onNextGroup,
  onSelectSingleBest,
  onToggleMultiSelect,
  onToggleExcludeGroup,
  onAskGemini
}) => {
  // 左ペイン（暫定1位または現在メイン）と右ペイン（対抗馬）のインデックス
  const [leftIdx, setLeftIdx] = useState(0);
  const [rightIdx, setRightIdx] = useState(1);

  // 同期ズーム状態 (zoom = 1: Fit全体表示, zoom > 1: 拡大・等倍比較)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  // 比較中の2枚のみフル解像度ObjectURLを生成し、閉じたら即解放（SPEC 4.1 3段階キャッシュ）
  const [leftFullUrl, setLeftFullUrl] = useState<string>('');
  const [rightFullUrl, setRightFullUrl] = useState<string>('');

  useEffect(() => {
    if (!group) return;
    setLeftIdx(0);
    setRightIdx(group.photos.length > 1 ? 1 : 0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [group?.id]);

  const leftPhoto: PhotoItem | undefined = group?.photos[leftIdx];
  const rightPhoto: PhotoItem | undefined = group?.photos[rightIdx];

  // 表示中の左写真のフル解像度URL管理
  useEffect(() => {
    if (!leftPhoto) return;
    const url = URL.createObjectURL(leftPhoto.file);
    setLeftFullUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [leftPhoto?.id]);

  // 表示中の右写真のフル解像度URL管理
  useEffect(() => {
    if (!rightPhoto) return;
    const url = URL.createObjectURL(rightPhoto.file);
    setRightFullUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [rightPhoto?.id]);

  const toggleFitOr100 = useCallback(() => {
    setZoom((prev) => {
      if (prev > 1.05) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      return 3.5; // 100%等倍相当のディテール確認倍率
    });
  }, []);

  // PC用キーボードショートカット（SPEC 4.5.3）
  useEffect(() => {
    if (!group) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case '1':
          if (leftPhoto) onSelectSingleBest(group.id, leftPhoto.id);
          break;
        case '2':
          if (rightPhoto) onSelectSingleBest(group.id, rightPhoto.id);
          break;
        case 'b':
        case 'B':
          if (leftPhoto && rightPhoto && leftPhoto.id !== rightPhoto.id) {
            onToggleMultiSelect(group.id, leftPhoto.id, rightPhoto.id);
          }
          break;
        case 'z':
        case 'Z':
        case ' ':
          e.preventDefault();
          toggleFitOr100();
          break;
        case 'x':
        case 'X':
          onToggleExcludeGroup(group.id);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (group.photos.length > 2 && rightIdx < group.photos.length - 1) {
            setRightIdx((r) => r + 1);
          } else {
            onNextGroup();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (group.photos.length > 2 && rightIdx > 1) {
            setRightIdx((r) => r - 1);
          } else {
            onPrevGroup();
          }
          break;
        case 'Enter':
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    group,
    leftPhoto,
    rightPhoto,
    rightIdx,
    onSelectSingleBest,
    onToggleMultiSelect,
    onToggleExcludeGroup,
    onNextGroup,
    onPrevGroup,
    onClose,
    toggleFitOr100
  ]);

  if (!group || !leftPhoto) return null;

  const isSinglePhotoGroup = group.photos.length === 1;
  const isLeftSelected = !group.excluded && group.selectedIds.includes(leftPhoto.id);
  const isRightSelected =
    !group.excluded && rightPhoto && group.selectedIds.includes(rightPhoto.id);
  const isBothSelected =
    !isSinglePhotoGroup && Boolean(isLeftSelected && isRightSelected && leftPhoto.id !== rightPhoto?.id);

  // マウスホイールによる同期ズーム
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.35 : -0.35;
    setZoom((prev) => {
      const next = Math.min(8, Math.max(1, Number((prev + delta).toFixed(2))));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  // ドラッグ・スワイプによる同期パン
  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging || zoom <= 1) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y
    });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  const sceneMeta = SCENE_META[group.scene];

  return (
    <div className="fixed inset-0 z-50 bg-[#0B0D11]/95 backdrop-blur-md flex flex-col select-none">
      {/* トップバー */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-[#14171E] border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onPrevGroup}
            disabled={groupIndex <= 0}
            className="p-1.5 rounded-lg bg-gray-800/80 hover:bg-gray-700 disabled:opacity-30 text-gray-200"
            title="前のグループ (←)"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono text-gray-400">
            Group {groupIndex + 1} / {totalGroups}
          </span>
          <button
            onClick={onNextGroup}
            disabled={groupIndex >= totalGroups - 1}
            className="p-1.5 rounded-lg bg-gray-800/80 hover:bg-gray-700 disabled:opacity-30 text-gray-200"
            title="次のグループ (→)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <span className={`px-2.5 py-0.5 text-xs font-medium rounded-full border ${sceneMeta.badgeClass}`}>
            {sceneMeta.label}
          </span>

          {group.isCloseCall && (
            <span className="px-2.5 py-0.5 text-xs font-bold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
              ⚡ 僅差 ({group.scoreDiff}点差)
            </span>
          )}
        </div>

        {/* 同期ズーム操作バー */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-900 rounded-xl p-1 border border-gray-800">
            <button
              onClick={() => {
                setZoom((z) => {
                  const next = Math.max(1, Number((z - 0.5).toFixed(1)));
                  if (next === 1) setPan({ x: 0, y: 0 });
                  return next;
                });
              }}
              className="p-1.5 text-gray-400 hover:text-white"
              title="縮小"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="px-2 text-xs font-mono text-gray-200 min-w-[52px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(8, Number((z + 0.5).toFixed(1))))}
              className="p-1.5 text-gray-400 hover:text-white"
              title="拡大"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={toggleFitOr100}
              className={`ml-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                zoom > 1
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
              title="Fit (全体) ⇔ 100%等倍切替 (Z / Space)"
            >
              <span className="flex items-center gap-1">
                <Maximize2 className="w-3 h-3" />
                {zoom > 1 ? 'Fitへ戻す' : '等倍ズーム (Z)'}
              </span>
            </button>
          </div>

          <button
            onClick={() => onAskGemini(group)}
            disabled={isJudgingGemini || isSinglePhotoGroup}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition ${
              hasGeminiKey
                ? 'bg-purple-600/25 hover:bg-purple-600/40 text-purple-200 border-purple-500/40'
                : 'bg-gray-800/70 hover:bg-gray-800 text-gray-400 border-gray-700'
            }`}
            title="Gemini API にこのグループのベスト判定を相談"
          >
            {isJudgingGemini ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            )}
            <span>🤖 AIに相談</span>
          </button>

          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200"
            title="一覧へ戻る (Enter / Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Gemini 判定コメントバナー（存在する場合） */}
      {group.geminiJudgment && (
        <div className="px-4 py-2 bg-purple-950/60 border-b border-purple-500/30 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-purple-200">
            <Sparkles className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="font-bold">Gemini AI 判定 ({group.geminiJudgment.scene}):</span>
            <span>{group.geminiJudgment.reason}</span>
            {group.geminiJudgment.runnerUpNote && (
              <span className="text-purple-300/80">（次点比較: {group.geminiJudgment.runnerUpNote}）</span>
            )}
          </div>
        </div>
      )}

      {/* メイン2分割比較ビュー（PC: 左右2分割 / スマホ: 上下2分割） */}
      <div
        className={`flex-1 grid ${
          isSinglePhotoGroup ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'
        } gap-1 bg-[#090B0E] overflow-hidden`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* 左（または上）ペイン：暫定1位 */}
        {renderPhotoPane({
          photo: leftPhoto,
          fullUrl: leftFullUrl || leftPhoto.thumbnailUrl,
          rankLabel: `候補 #${leftIdx + 1} ${leftIdx === 0 ? '(暫定1位)' : ''}`,
          isSelected: isLeftSelected,
          isExcluded: group.excluded,
          zoom,
          pan,
          shortcutKey: '1',
          onAdopt: () => onSelectSingleBest(group.id, leftPhoto.id)
        })}

        {/* 右（または下）ペイン：対抗馬 */}
        {!isSinglePhotoGroup &&
          rightPhoto &&
          renderPhotoPane({
            photo: rightPhoto,
            fullUrl: rightFullUrl || rightPhoto.thumbnailUrl,
            rankLabel: `対抗馬 #${rightIdx + 1}`,
            isSelected: Boolean(isRightSelected),
            isExcluded: group.excluded,
            zoom,
            pan,
            shortcutKey: '2',
            onAdopt: () => onSelectSingleBest(group.id, rightPhoto.id)
          })}
      </div>

      {/* 下部コントロール ＆ グループ内候補サムネイルストリップ */}
      <div className="bg-[#14171E] border-t border-gray-800 px-4 py-3 flex flex-col gap-3">
        {/* 候補が3枚以上ある場合の対抗馬切り替えサムネイルバー */}
        {group.photos.length > 2 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="text-xs text-gray-400 shrink-0 mr-1">
              グループ内候補 ({group.photos.length}枚):
            </span>
            {group.photos.map((p, idx) => {
              const isLeft = idx === leftIdx;
              const isRight = idx === rightIdx;
              const isChosen = !group.excluded && group.selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    if (idx === leftIdx) return;
                    setRightIdx(idx);
                  }}
                  className={`relative group/thumb flex items-center gap-2 px-2 py-1 rounded-lg border text-left transition shrink-0 ${
                    isRight
                      ? 'border-amber-400 bg-amber-500/15'
                      : isLeft
                      ? 'border-indigo-500 bg-indigo-500/15'
                      : 'border-gray-700 bg-gray-800/60 hover:border-gray-500'
                  }`}
                >
                  <img
                    src={p.thumbnailUrl}
                    alt={p.fileName}
                    className="w-10 h-10 object-cover rounded"
                  />
                  <div className="text-xs">
                    <div className="font-semibold text-gray-200 flex items-center gap-1">
                      <span>#{idx + 1}</span>
                      <span className="text-indigo-400 font-mono">{p.score.total}点</span>
                      {isChosen && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                    </div>
                    <div className="text-[10px] text-gray-400 truncate max-w-[96px]">
                      {p.fileName}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* アクションボタン群 + ショートカット案内 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onSelectSingleBest(group.id, leftPhoto.id)}
              className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition ${
                isLeftSelected && !isBothSelected
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
              }`}
            >
              <Check className="w-4 h-4" />
              <span>左を採用 [1]</span>
            </button>

            {!isSinglePhotoGroup && rightPhoto && (
              <>
                <button
                  onClick={() => onSelectSingleBest(group.id, rightPhoto.id)}
                  className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition ${
                    isRightSelected && !isBothSelected
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
                  }`}
                >
                  <Check className="w-4 h-4" />
                  <span>右を採用 [2]</span>
                </button>

                <button
                  onClick={() => onToggleMultiSelect(group.id, leftPhoto.id, rightPhoto.id)}
                  className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition ${
                    isBothSelected
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
                  }`}
                >
                  <Layers className="w-4 h-4" />
                  <span>両方残す（複数採用） [B]</span>
                </button>
              </>
            )}

            <button
              onClick={() => onToggleExcludeGroup(group.id)}
              className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition ${
                group.excluded
                  ? 'bg-rose-600 text-white'
                  : 'bg-rose-950/40 hover:bg-rose-900/50 text-rose-300 border border-rose-800/50'
              }`}
            >
              <Trash2 className="w-4 h-4" />
              <span>{group.excluded ? '除外を解除 [X]' : 'このグループをすべて除外 [X]'}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden xl:inline text-[11px] text-gray-400">
              ショートカット: [1/2] 採用 ・ [B] 両方残す ・ [Z/Space] 等倍ズーム ・ [←/→] 切替 ・ [Enter] 確定
            </span>
            <button
              onClick={onClose}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs sm:text-sm"
            >
              確定して一覧へ戻る [Enter]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function renderPhotoPane(params: {
  photo: PhotoItem;
  fullUrl: string;
  rankLabel: string;
  isSelected: boolean;
  isExcluded: boolean;
  zoom: number;
  pan: { x: number; y: number };
  shortcutKey: string;
  onAdopt: () => void;
}) {
  const { photo, fullUrl, rankLabel, isSelected, isExcluded, zoom, pan, shortcutKey, onAdopt } =
    params;

  return (
    <div
      className={`relative flex flex-col bg-[#0F1115] overflow-hidden border-2 transition ${
        isExcluded
          ? 'border-rose-900/50 opacity-50'
          : isSelected
          ? 'border-indigo-500'
          : 'border-transparent'
      }`}
    >
      {/* 上部オーバーレイバッジ */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2 bg-black/75 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10">
          <Award className={`w-4 h-4 ${isSelected ? 'text-indigo-400' : 'text-gray-400'}`} />
          <span className="text-xs font-bold text-white">{rankLabel}</span>
          <span className="text-xs font-mono text-indigo-300 font-bold">
            {photo.score.total}点
          </span>
          <span className="text-xs text-gray-300 font-mono">{photo.fileName}</span>
          {photo.rawFileName && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
              +RAW ({photo.rawFileName.split('.').pop()?.toUpperCase()})
            </span>
          )}
        </div>

        <button
          onClick={onAdopt}
          className={`pointer-events-auto px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition shadow-lg ${
            isSelected
              ? 'bg-indigo-600 text-white'
              : 'bg-black/75 hover:bg-gray-800 text-gray-200 border border-white/15'
          }`}
        >
          <Check className="w-3.5 h-3.5" />
          <span>{isSelected ? '採用中' : `この写真を採用 [${shortcutKey}]`}</span>
        </button>
      </div>

      {/* 画像キャンバス領域（同期パン・ズーム） */}
      <div
        className={`flex-1 relative flex items-center justify-center overflow-hidden ${
          zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
        }`}
      >
        <img
          src={fullUrl}
          alt={photo.fileName}
          draggable={false}
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            transition: zoom === 1 ? 'transform 0.15s ease-out' : 'none'
          }}
          className="max-w-full max-h-full object-contain select-none"
        />
      </div>

      {/* 下部Exif & スコア内訳パネル（SPEC 4.5.2） */}
      <div className="bg-[#151821]/95 border-t border-gray-800/80 px-3.5 py-2.5 text-xs flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-gray-300 font-mono text-[11px]">
            <span className="flex items-center gap-1 text-gray-400">
              <Camera className="w-3.5 h-3.5 text-indigo-400" />
              {photo.exif.model || 'Camera'}
            </span>
            {photo.exif.focalLength && <span>{photo.exif.focalLength}mm</span>}
            {photo.exif.fNumber && <span>F{photo.exif.fNumber}</span>}
            {photo.exif.exposureTime && <span>{formatShutterSpeed(photo.exif.exposureTime)}</span>}
            {photo.exif.iso && <span>ISO {photo.exif.iso}</span>}
            <span className="text-gray-400">
              {photo.exif.width}×{photo.exif.height}
            </span>
            {photo.exif.hasGps && (
              <span className="flex items-center gap-0.5 text-emerald-400" title="GPS位置情報あり">
                <MapPin className="w-3 h-3" />
                GPS
              </span>
            )}
          </div>

          {photo.exif.dateTimeOriginal && (
            <span className="flex items-center gap-1 text-[11px] text-gray-400 font-mono">
              <Clock className="w-3 h-3" />
              {photo.exif.dateTimeOriginal}
            </span>
          )}
        </div>

        {/* 4項目スコア内訳バー */}
        <div className="grid grid-cols-4 gap-2 pt-0.5">
          <ScoreMiniBar label="ピント/解像" value={photo.score.sharpness} />
          <ScoreMiniBar label="被写体/目開き" value={photo.score.subjectQuality} />
          <ScoreMiniBar label="露出/階調" value={photo.score.exposure} />
          <ScoreMiniBar label="構図/水平" value={photo.score.composition} />
        </div>

        <div className="text-[11px] text-indigo-300/90 truncate">
          💡 {photo.score.primaryReason}
        </div>
      </div>
    </div>
  );
}

const ScoreMiniBar: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <div className="flex justify-between text-[10px] text-gray-400">
      <span>{label}</span>
      <span className="font-mono text-gray-200">{value}</span>
    </div>
    <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${
          value >= 80 ? 'bg-emerald-500' : value >= 65 ? 'bg-indigo-500' : 'bg-amber-500'
        }`}
        style={{ width: `${Math.min(100, Math.max(10, value))}%` }}
      />
    </div>
  </div>
);
