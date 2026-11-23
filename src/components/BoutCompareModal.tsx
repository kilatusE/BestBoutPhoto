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
  MapPin,
  Loader2,
  AlertTriangle
} from 'lucide-react';
import { PhotoGroup, PhotoItem, SceneType } from '../types';
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
  onChangeGroupScene: (groupId: string, newScene: SceneType) => void;
  onAskGemini: (group: PhotoGroup) => void;
}

export const BoutCompareModal: React.FC<BoutCompareModalProps> = ({
  group,
  groupIndex,
  totalGroups,
  isJudgingGemini,
  onClose,
  onPrevGroup,
  onNextGroup,
  onSelectSingleBest,
  onToggleMultiSelect,
  onToggleExcludeGroup,
  onChangeGroupScene,
  onAskGemini
}) => {
  const [leftIdx, setLeftIdx] = useState(0);
  const [rightIdx, setRightIdx] = useState(1);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

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

  useEffect(() => {
    if (!leftPhoto) return;
    const url = URL.createObjectURL(leftPhoto.file);
    setLeftFullUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [leftPhoto?.id]);

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
      return 3.5;
    });
  }, []);

  useEffect(() => {
    if (!group) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

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

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.35 : -0.35;
    setZoom((prev) => {
      const next = Math.min(8, Math.max(1, Number((prev + delta).toFixed(2))));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

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

  return (
    <div className="fixed inset-0 z-50 bg-[#0D0E11] flex flex-col select-none">
      {/* 上部バー */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 h-12 bg-[#16181D] border-b border-gray-800">
        <div className="flex items-center gap-2">
          <button
            onClick={onPrevGroup}
            disabled={groupIndex <= 0}
            className="p-1.5 rounded hover:bg-gray-800 disabled:opacity-30 text-gray-300"
            title="前のグループ"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono text-gray-400">
            {groupIndex + 1} / {totalGroups}
          </span>
          <button
            onClick={onNextGroup}
            disabled={groupIndex >= totalGroups - 1}
            className="p-1.5 rounded hover:bg-gray-800 disabled:opacity-30 text-gray-300"
            title="次のグループ"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* シーン手動切り替え（切り替え時は即座にその基準で再採点） */}
          <select
            value={group.scene}
            onChange={(e) => onChangeGroupScene(group.id, e.target.value as SceneType)}
            className="ml-1 px-2 py-1 rounded bg-gray-900 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            title="評価基準シーンを変更して再採点"
          >
            <option value="portrait">人物</option>
            <option value="food">料理・モノ</option>
            <option value="landscape">風景</option>
            <option value="document">資料</option>
          </select>

          {group.isCloseCall && (
            <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-amber-500 text-black">
              僅差
            </span>
          )}
        </div>

        {/* ズーム・AI相談・閉じる */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-900 rounded-lg p-0.5 border border-gray-800">
            <button
              onClick={() => {
                setZoom((z) => {
                  const next = Math.max(1, Number((z - 0.5).toFixed(1)));
                  if (next === 1) setPan({ x: 0, y: 0 });
                  return next;
                });
              }}
              className="p-1 text-gray-400 hover:text-white"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono text-gray-300 min-w-[46px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(8, Number((z + 0.5).toFixed(1))))}
              className="p-1 text-gray-400 hover:text-white"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={toggleFitOr100}
              className={`ml-1 px-2 py-1 rounded text-xs font-medium transition ${
                zoom > 1 ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span className="flex items-center gap-1">
                <Maximize2 className="w-3 h-3" />
                {zoom > 1 ? '全体表示' : '等倍 (Z)'}
              </span>
            </button>
          </div>

          {!isSinglePhotoGroup && (
            <button
              onClick={() => onAskGemini(group)}
              disabled={isJudgingGemini}
              className="px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700"
            >
              {isJudgingGemini ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span>AI判定</span>
            </button>
          )}

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-300"
            title="閉じる (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* AI判定コメント */}
      {group.geminiJudgment && (
        <div className="px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs text-amber-200 flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>{group.geminiJudgment.reason}</span>
          {group.geminiJudgment.runnerUpNote && (
            <span className="text-gray-400">（{group.geminiJudgment.runnerUpNote}）</span>
          )}
        </div>
      )}

      {/* 2分割比較エリア */}
      <div
        className={`flex-1 grid ${
          isSinglePhotoGroup ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'
        } gap-1 bg-black overflow-hidden`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {renderPhotoPane({
          photo: leftPhoto,
          fullUrl: leftFullUrl || leftPhoto.thumbnailUrl,
          rankLabel: `#${leftIdx + 1}`,
          isSelected: isLeftSelected,
          isExcluded: group.excluded,
          zoom,
          pan,
          shortcutKey: '1',
          onAdopt: () => onSelectSingleBest(group.id, leftPhoto.id)
        })}

        {!isSinglePhotoGroup &&
          rightPhoto &&
          renderPhotoPane({
            photo: rightPhoto,
            fullUrl: rightFullUrl || rightPhoto.thumbnailUrl,
            rankLabel: `#${rightIdx + 1}`,
            isSelected: Boolean(isRightSelected),
            isExcluded: group.excluded,
            zoom,
            pan,
            shortcutKey: '2',
            onAdopt: () => onSelectSingleBest(group.id, rightPhoto.id)
          })}
      </div>

      {/* 下部コントロール */}
      <div className="bg-[#16181D] border-t border-gray-800 px-4 py-2.5 flex flex-col gap-2.5">
        {group.photos.length > 2 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
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
                  className={`flex items-center gap-2 px-2 py-1 rounded border text-left transition shrink-0 ${
                    isRight
                      ? 'border-amber-400 bg-amber-500/10'
                      : isLeft
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-gray-800 bg-gray-900 hover:border-gray-700'
                  }`}
                >
                  <img
                    src={p.thumbnailUrl}
                    alt={p.fileName}
                    className="w-8 h-8 object-cover rounded-xs"
                  />
                  <div className="text-xs">
                    <div className="font-medium text-gray-200 flex items-center gap-1">
                      <span>#{idx + 1}</span>
                      <span className="text-gray-400 font-mono">{p.score.total}</span>
                      {isChosen && <Check className="w-3 h-3 text-blue-400" />}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onSelectSingleBest(group.id, leftPhoto.id)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
                isLeftSelected && !isBothSelected
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
              }`}
            >
              <Check className="w-3.5 h-3.5" />
              <span>左を採用 [1]</span>
            </button>

            {!isSinglePhotoGroup && rightPhoto && (
              <>
                <button
                  onClick={() => onSelectSingleBest(group.id, rightPhoto.id)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
                    isRightSelected && !isBothSelected
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>右を採用 [2]</span>
                </button>

                <button
                  onClick={() => onToggleMultiSelect(group.id, leftPhoto.id, rightPhoto.id)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
                    isBothSelected
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>両方残す [B]</span>
                </button>
              </>
            )}

            <button
              onClick={() => onToggleExcludeGroup(group.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
                group.excluded
                  ? 'bg-rose-600 text-white'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{group.excluded ? '除外を解除 [X]' : 'すべて除外 [X]'}</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs"
          >
            一覧へ戻る [Enter]
          </button>
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
      className={`relative flex flex-col bg-[#0F1014] overflow-hidden border-2 transition ${
        isExcluded
          ? 'border-gray-800 opacity-45'
          : isSelected
          ? 'border-blue-500'
          : 'border-transparent'
      }`}
    >
      {/* 上部ラベル */}
      <div className="absolute top-2.5 left-2.5 right-2.5 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex flex-wrap items-center gap-2 bg-black/75 backdrop-blur-xs px-2.5 py-1 rounded-lg">
          <span className="text-xs font-semibold text-white">{rankLabel}</span>
          <span className="text-xs font-mono text-gray-300">{photo.fileName}</span>
          <span className="text-xs font-mono text-blue-300">{photo.score.total}点</span>
          {photo.rawFileName && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/20 text-amber-300">
              RAW
            </span>
          )}
          {photo.metrics.faceCount > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-500/20 text-blue-200">
              瞳ピント {photo.metrics.eyeRegionSharpness} / 目開き {photo.metrics.eyeOpenScore}
            </span>
          )}
          {photo.metrics.isBlinking && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-rose-500/80 text-white flex items-center gap-0.5">
              <AlertTriangle className="w-2.5 h-2.5" />
              目つぶり注意
            </span>
          )}
        </div>

        <button
          onClick={onAdopt}
          className={`pointer-events-auto px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 transition ${
            isSelected
              ? 'bg-blue-600 text-white'
              : 'bg-black/75 hover:bg-gray-800 text-gray-200'
          }`}
        >
          <Check className="w-3.5 h-3.5" />
          <span>{isSelected ? '採用中' : `採用 [${shortcutKey}]`}</span>
        </button>
      </div>

      {/* 写真表示 */}
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

      {/* 下部Exif & スコア */}
      <div className="bg-[#14161B] border-t border-gray-800 px-3 py-2 text-xs flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-400 font-mono">
          <div className="flex flex-wrap items-center gap-2.5">
            {photo.exif.model && <span className="text-gray-300">{photo.exif.model}</span>}
            {photo.exif.focalLength && <span>{photo.exif.focalLength}mm</span>}
            {photo.exif.fNumber && <span>F{photo.exif.fNumber}</span>}
            {photo.exif.exposureTime && <span>{formatShutterSpeed(photo.exif.exposureTime)}</span>}
            {photo.exif.iso && <span>ISO {photo.exif.iso}</span>}
            <span>
              {photo.exif.width}×{photo.exif.height}
            </span>
            {photo.exif.hasGps && (
              <span className="flex items-center gap-0.5 text-emerald-400">
                <MapPin className="w-3 h-3" />
                GPS
              </span>
            )}
          </div>
          {photo.exif.dateTimeOriginal && <span>{photo.exif.dateTimeOriginal}</span>}
        </div>

        <div className="grid grid-cols-4 gap-2">
          <ScoreMiniBar label="ピント" value={photo.score.sharpness} />
          <ScoreMiniBar label="被写体" value={photo.score.subjectQuality} />
          <ScoreMiniBar label="露出" value={photo.score.exposure} />
          <ScoreMiniBar label="構図" value={photo.score.composition} />
        </div>
      </div>
    </div>
  );
}

const ScoreMiniBar: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] text-gray-400 shrink-0">{label}</span>
    <div className="h-1 flex-1 bg-gray-800 rounded-full overflow-hidden">
      <div
        className="h-full bg-blue-500 rounded-full"
        style={{ width: `${Math.min(100, Math.max(10, value))}%` }}
      />
    </div>
    <span className="text-[10px] font-mono text-gray-300">{value}</span>
  </div>
);
