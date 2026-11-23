import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  FolderOpen,
  ImagePlus,
  Sparkles,
  Sliders,
  Settings as SettingsIcon,
  Download,
  Layers,
  Trash2,
  Check,
  Loader2,
  RotateCcw,
  Sun,
  Moon
} from 'lucide-react';
import { AppSettings, PhotoGroup, PhotoItem, SceneType } from './types';
import { analyzePhotoEntry, pairImportedFiles } from './utils/imageAnalyzer';
import { getVisionEngines } from './utils/faceDetector';
import { groupPhotosBySimilarity, SCENE_META } from './utils/groupingEngine';
import { judgeGroupWithGemini } from './utils/geminiClient';
import { getSelectedPhotos } from './utils/exportEngine';
import { generateDemoPhotoFiles } from './utils/demoGenerator';
import { BoutCompareModal } from './components/BoutCompareModal';
import { ExportModal } from './components/ExportModal';
import { SettingsModal } from './components/SettingsModal';
import { CameraCaptureModal } from './components/CameraCaptureModal';

const SETTINGS_STORAGE_KEY = 'bestbout_photo_settings_v1';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  pairRaw: true,
  groupingSensitivity: 50,
  closeCallThreshold: 5.0,
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  googleClientId: '',
  googleDriveParentFolderId: ''
};

type FilterType =
  | 'all'
  | 'close_call'
  | 'multi_selected'
  | 'excluded'
  | SceneType;

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [groups, setGroups] = useState<PhotoGroup[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  const [judgingGroupId, setJudgingGroupId] = useState<string | null>(null);
  const [isBatchJudging, setIsBatchJudging] = useState(false);
  const [aiErrorMsg, setAiErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // MediaPipe 顔・瞳検出エンジンをバックグラウンドでウォームアップ
  useEffect(() => {
    getVisionEngines();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
    if (settings.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [settings]);

  const updateSettings = (partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  useEffect(() => {
    if (photos.length === 0) {
      setGroups([]);
      return;
    }
    setGroups((prevGroups) => {
      const prevMap = new Map<string, PhotoGroup>();
      for (const g of prevGroups) {
        if (g.photos[0]) prevMap.set(g.photos[0].id, g);
      }

      const nextGroups = groupPhotosBySimilarity(
        photos,
        settings.groupingSensitivity,
        settings.closeCallThreshold
      );

      return nextGroups.map((ng) => {
        const leaderId = ng.photos[0]?.id;
        const matchedPrev = leaderId ? prevMap.get(leaderId) : undefined;
        if (matchedPrev && matchedPrev.photos.length === ng.photos.length) {
          return {
            ...ng,
            selectedIds: matchedPrev.selectedIds,
            excluded: matchedPrev.excluded,
            geminiJudgment: matchedPrev.geminiJudgment
          };
        }
        return ng;
      });
    });
  }, [photos, settings.groupingSensitivity, settings.closeCallThreshold]);

  const handleImportFiles = async (rawFileList: File[]) => {
    if (rawFileList.length === 0) return;
    const pairedEntries = pairImportedFiles(rawFileList, settings.pairRaw);
    if (pairedEntries.length === 0) return;

    setIsAnalyzing(true);
    setAnalyzeProgress({ current: 0, total: pairedEntries.length, fileName: '' });

    const newPhotoItems: PhotoItem[] = [];
    const concurrency = 3;
    for (let i = 0; i < pairedEntries.length; i += concurrency) {
      const batch = pairedEntries.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (entry, idx) => {
          const item = await analyzePhotoEntry(entry, photos.length + i + idx);
          setAnalyzeProgress((prev) => ({
            current: Math.min(pairedEntries.length, prev.current + 1),
            total: pairedEntries.length,
            fileName: entry.imageFile.name
          }));
          return item;
        })
      );
      newPhotoItems.push(...results);
    }

    setPhotos((prev) => [...prev, ...newPhotoItems]);
    setIsAnalyzing(false);
  };

  const handleLoadDemo = async () => {
    setIsAnalyzing(true);
    setAnalyzeProgress({ current: 0, total: 8, fileName: 'サンプル生成中...' });
    const demoFiles = await generateDemoPhotoFiles();
    await handleImportFiles(demoFiles);
  };

  const handleResetAll = () => {
    for (const p of photos) {
      URL.revokeObjectURL(p.thumbnailUrl);
    }
    setPhotos([]);
    setGroups([]);
    setActiveGroupId(null);
    setFilter('all');
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const collected: File[] = [];
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) {
        for (const entry of entries) {
          await traverseFileTree(entry, collected);
        }
        if (collected.length > 0) {
          await handleImportFiles(collected);
          return;
        }
      }
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleImportFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleSelectSingleBest = (groupId: string, photoId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              excluded: false,
              selectedIds: [photoId]
            }
          : g
      )
    );
  };

  const handleToggleMultiSelect = (groupId: string, photoIdA: string, photoIdB: string) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const hasBoth = g.selectedIds.includes(photoIdA) && g.selectedIds.includes(photoIdB);
        if (hasBoth) {
          return { ...g, excluded: false, selectedIds: [photoIdA] };
        }
        const merged = Array.from(new Set([...g.selectedIds, photoIdA, photoIdB]));
        return { ...g, excluded: false, selectedIds: merged };
      })
    );
  };

  const handleToggleExcludeGroup = (groupId: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, excluded: !g.excluded } : g))
    );
  };

  const handleAskGeminiSingle = async (group: PhotoGroup) => {
    if (!settings.geminiApiKey.trim()) {
      setIsSettingsOpen(true);
      return;
    }
    setJudgingGroupId(group.id);
    setAiErrorMsg(null);
    try {
      const judgment = await judgeGroupWithGemini(
        group,
        settings.geminiApiKey,
        settings.geminiModel
      );
      setGroups((prev) =>
        prev.map((g) =>
          g.id === group.id
            ? {
                ...g,
                geminiJudgment: judgment,
                selectedIds: [judgment.bestPhotoId],
                excluded: false
              }
            : g
        )
      );
    } catch (err) {
      setAiErrorMsg(err instanceof Error ? err.message : 'AI判定に失敗しました');
    } finally {
      setJudgingGroupId(null);
    }
  };

  const handleBatchAskGeminiForCloseCalls = async () => {
    if (!settings.geminiApiKey.trim()) {
      setIsSettingsOpen(true);
      return;
    }
    const targetGroups = groups.filter(
      (g) => !g.excluded && g.isCloseCall && g.photos.length >= 2 && !g.geminiJudgment
    );
    if (targetGroups.length === 0) return;

    setIsBatchJudging(true);
    setAiErrorMsg(null);
    try {
      for (const g of targetGroups) {
        setJudgingGroupId(g.id);
        const judgment = await judgeGroupWithGemini(
          g,
          settings.geminiApiKey,
          settings.geminiModel
        );
        setGroups((prev) =>
          prev.map((item) =>
            item.id === g.id
              ? {
                  ...item,
                  geminiJudgment: judgment,
                  selectedIds: [judgment.bestPhotoId]
                }
              : item
          )
        );
      }
    } catch (err) {
      setAiErrorMsg(err instanceof Error ? err.message : 'AI判定中にエラーが発生しました');
    } finally {
      setJudgingGroupId(null);
      setIsBatchJudging(false);
    }
  };

  const filteredGroups = useMemo(() => {
    return groups.filter((g) => {
      switch (filter) {
        case 'close_call':
          return !g.excluded && g.isCloseCall;
        case 'multi_selected':
          return !g.excluded && g.selectedIds.length > 1;
        case 'excluded':
          return g.excluded;
        case 'portrait':
        case 'document':
        case 'food':
        case 'landscape':
          return !g.excluded && g.scene === filter;
        case 'all':
        default:
          return true;
      }
    });
  }, [groups, filter]);

  const activeGroupIndex = useMemo(
    () => filteredGroups.findIndex((g) => g.id === activeGroupId),
    [filteredGroups, activeGroupId]
  );
  const activeGroup = activeGroupIndex >= 0 ? filteredGroups[activeGroupIndex] : null;

  const selectedPhotos = useMemo(() => getSelectedPhotos(groups), [groups]);
  const closeCallCount = useMemo(
    () => groups.filter((g) => !g.excluded && g.isCloseCall).length,
    [groups]
  );

  const isDark = settings.theme === 'dark';

  return (
    <div
      className={`min-h-screen flex flex-col ${
        isDark ? 'bg-[#121316] text-gray-100' : 'bg-gray-50 text-gray-900'
      }`}
    >
      {/* シンプルなヘッダー */}
      <header
        className={`sticky top-0 z-30 border-b px-4 sm:px-6 h-14 flex items-center justify-between gap-3 ${
          isDark
            ? 'bg-[#181A1F]/95 border-gray-800 backdrop-blur'
            : 'bg-white/95 border-gray-200 backdrop-blur'
        }`}
      >
        <div className="flex items-center gap-4">
          <h1 className="font-semibold text-base tracking-tight">BestBout Photo</h1>

          {photos.length > 0 && (
            <div className={`hidden sm:flex items-center gap-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              <span>{photos.length}枚読込</span>
              <span>/</span>
              <span>{groups.length}グループ</span>
              <span>/</span>
              <span className={isDark ? 'text-white font-medium' : 'text-gray-900 font-medium'}>
                採用 {selectedPhotos.length}枚
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {photos.length > 0 && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                    : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
                }`}
              >
                <ImagePlus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">写真追加</span>
              </button>

              <button
                onClick={() => folderInputRef.current?.click()}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                    : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
                }`}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">フォルダ追加</span>
              </button>

              <button
                onClick={handleResetAll}
                className={`p-1.5 rounded-lg border ${
                  isDark
                    ? 'bg-gray-800/60 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border-gray-700'
                    : 'bg-white hover:bg-gray-100 text-gray-500 border-gray-300'
                }`}
                title="クリア"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </>
          )}

          <button
            onClick={() => setIsCameraOpen(true)}
            className={`p-1.5 rounded-lg border ${
              isDark
                ? 'bg-gray-800/60 hover:bg-gray-700 text-gray-300 border-gray-700'
                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
            }`}
            title="カメラ撮影"
          >
            <Camera className="w-4 h-4" />
          </button>

          <button
            onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
            className={`p-1.5 rounded-lg border ${
              isDark
                ? 'bg-gray-800/60 hover:bg-gray-700 text-gray-300 border-gray-700'
                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
            }`}
            title="テーマ切替"
          >
            {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            className={`p-1.5 rounded-lg border ${
              isDark
                ? 'bg-gray-800/60 hover:bg-gray-700 text-gray-300 border-gray-700'
                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
            }`}
            title="設定"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>

          <button
            onClick={() => setIsExportOpen(true)}
            disabled={selectedPhotos.length === 0}
            className="ml-1 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>書き出し ({selectedPhotos.length})</span>
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.arw,.cr2,.cr3,.nef,.dng,.raf,.orf,.rw2"
        onChange={(e) => {
          if (e.target.files) handleImportFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory="true"
        onChange={(e) => {
          if (e.target.files) handleImportFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
        className="hidden"
      />

      <main
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 space-y-4"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
      >
        {aiErrorMsg && (
          <div className="p-3 rounded-lg bg-rose-950/80 border border-rose-700/50 text-rose-200 text-xs flex items-center justify-between">
            <span>{aiErrorMsg}</span>
            <button onClick={() => setAiErrorMsg(null)} className="underline ml-3">
              閉じる
            </button>
          </div>
        )}

        {/* 読み込み中バー */}
        {isAnalyzing && (
          <div
            className={`p-3.5 rounded-xl border space-y-2 ${
              isDark ? 'bg-[#181A1F] border-gray-800' : 'bg-white border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 font-medium">
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                読み込み中: {analyzeProgress.fileName}
              </span>
              <span className="font-mono text-gray-400">
                {analyzeProgress.current} / {analyzeProgress.total}
              </span>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-200'}`}>
              <div
                className="h-full bg-blue-500 transition-all duration-150"
                style={{
                  width: `${Math.round(
                    (analyzeProgress.current / Math.max(1, analyzeProgress.total)) * 100
                  )}%`
                }}
              />
            </div>
          </div>
        )}

        {/* 写真未選択時：シンプルで迷わないドロップエリア */}
        {photos.length === 0 && !isAnalyzing ? (
          <div className="py-12 sm:py-20 flex items-center justify-center">
            <div
              className={`w-full max-w-xl rounded-2xl border border-dashed p-8 sm:p-12 text-center transition flex flex-col items-center gap-5 ${
                isDraggingOver
                  ? 'border-blue-500 bg-blue-500/5'
                  : isDark
                  ? 'border-gray-700 bg-[#181A1F]'
                  : 'border-gray-300 bg-white'
              }`}
            >
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                  isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'
                }`}
              >
                <ImagePlus className="w-6 h-6" />
              </div>

              <div className="space-y-1">
                <h2 className="text-base font-semibold">
                  写真またはフォルダをドロップして読み込む
                </h2>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  JPEG / PNG / HEIC / RAW (.ARW, .CR3, .NEF, .DNG) 対応
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 transition"
                >
                  <ImagePlus className="w-4 h-4" />
                  <span>写真を選択</span>
                </button>

                <button
                  onClick={() => folderInputRef.current?.click()}
                  className={`px-4 py-2 rounded-lg font-medium text-xs sm:text-sm flex items-center gap-2 border transition ${
                    isDark
                      ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                  }`}
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>フォルダを選択</span>
                </button>

                <button
                  onClick={() => setIsCameraOpen(true)}
                  className={`px-3.5 py-2 rounded-lg font-medium text-xs sm:text-sm flex items-center gap-2 border transition ${
                    isDark
                      ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                  }`}
                >
                  <Camera className="w-4 h-4" />
                  <span>カメラ</span>
                </button>
              </div>

              <button
                onClick={handleLoadDemo}
                className={`text-xs underline underline-offset-4 ${
                  isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                サンプル写真で動作を試す
              </button>
            </div>
          </div>
        ) : null}

        {/* 写真読み込み後：フィルター ＆ まとめ具合スライダー ＆ グリッド */}
        {photos.length > 0 && (
          <>
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
              {/* フィルタータブ */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
                {[
                  { id: 'all', label: `すべて (${groups.length})` },
                  { id: 'close_call', label: `僅差 (${closeCallCount})` },
                  {
                    id: 'portrait',
                    label: `人物 (${groups.filter((g) => !g.excluded && g.scene === 'portrait').length})`
                  },
                  {
                    id: 'food',
                    label: `料理・モノ (${groups.filter((g) => !g.excluded && g.scene === 'food').length})`
                  },
                  {
                    id: 'landscape',
                    label: `風景 (${groups.filter((g) => !g.excluded && g.scene === 'landscape').length})`
                  },
                  {
                    id: 'document',
                    label: `資料 (${groups.filter((g) => !g.excluded && g.scene === 'document').length})`
                  },
                  {
                    id: 'multi_selected',
                    label: `複数採用 (${groups.filter((g) => !g.excluded && g.selectedIds.length > 1).length})`
                  },
                  {
                    id: 'excluded',
                    label: `除外 (${groups.filter((g) => g.excluded).length})`
                  }
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setFilter(tab.id as FilterType)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                      filter === tab.id
                        ? isDark
                          ? 'bg-gray-200 text-gray-900 font-semibold'
                          : 'bg-gray-900 text-white font-semibold'
                        : isDark
                        ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/70'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* まとめ具合スライダー & AI一括判定 */}
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs ${
                    isDark ? 'bg-[#181A1F] border-gray-800' : 'bg-white border-gray-200'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="text-gray-400">グループ化:</span>
                  <span className="text-[11px] text-gray-500">厳しめ</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settings.groupingSensitivity}
                    onChange={(e) =>
                      updateSettings({ groupingSensitivity: Number(e.target.value) })
                    }
                    className="w-24 accent-blue-500 cursor-pointer"
                  />
                  <span className="text-[11px] text-gray-500">ゆるめ</span>
                </div>

                {closeCallCount > 0 && (
                  <button
                    onClick={handleBatchAskGeminiForCloseCalls}
                    disabled={isBatchJudging}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition ${
                      isDark
                        ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                        : 'bg-white hover:bg-gray-100 text-gray-800 border-gray-300'
                    }`}
                  >
                    {isBatchJudging ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <span>僅差をAI判定 ({closeCallCount})</span>
                  </button>
                )}
              </div>
            </div>

            {/* 写真グリッド */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
              {filteredGroups.map((group) => {
                const primaryPhoto =
                  group.photos.find((p) => group.selectedIds.includes(p.id)) || group.photos[0];
                const sceneMeta = SCENE_META[group.scene];
                const isMulti = group.selectedIds.length > 1;
                const isBeingJudged = judgingGroupId === group.id;

                return (
                  <div
                    key={group.id}
                    onClick={() => setActiveGroupId(group.id)}
                    className={`group/card rounded-xl overflow-hidden border transition cursor-pointer flex flex-col ${
                      group.excluded
                        ? 'opacity-45 border-gray-800'
                        : isDark
                        ? 'bg-[#181A1F] border-gray-800 hover:border-gray-600'
                        : 'bg-white border-gray-200 hover:border-gray-400 shadow-xs'
                    }`}
                  >
                    {/* 写真サムネイル */}
                    <div className="relative aspect-[3/2] bg-black overflow-hidden">
                      <img
                        src={primaryPhoto.thumbnailUrl}
                        alt={primaryPhoto.fileName}
                        className="w-full h-full object-cover"
                      />

                      {/* 左上：連写枚数・僅差・複数採用 */}
                      <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1">
                        {group.photos.length > 1 && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-black/75 text-white backdrop-blur-xs">
                            {group.photos.length}枚
                          </span>
                        )}

                        {group.isCloseCall && !group.excluded && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-500 text-black">
                            僅差
                          </span>
                        )}

                        {isMulti && !group.excluded && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-600 text-white flex items-center gap-1">
                            <Layers className="w-3 h-3" />
                            {group.selectedIds.length}枚採用
                          </span>
                        )}
                      </div>

                      {/* 右上：RAW & スコア */}
                      <div className="absolute top-2 right-2 flex items-center gap-1">
                        {primaryPhoto.rawFileName && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-black/75 text-amber-300 backdrop-blur-xs">
                            RAW
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-black/75 text-gray-200 backdrop-blur-xs">
                          {primaryPhoto.score.total}
                        </span>
                      </div>

                      {isBeingJudged && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                          <div className="flex items-center gap-2 text-xs text-white">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>AI判定中...</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 下部メタ情報 & 連写候補サムネイル */}
                    <div className="p-3 flex-1 flex flex-col justify-between gap-2">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-medium truncate">
                            {primaryPhoto.fileName}
                          </span>
                          <span className={`text-[11px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {sceneMeta.shortLabel}
                          </span>
                        </div>

                        <p
                          className={`mt-1 text-[11px] line-clamp-1 ${
                            group.geminiJudgment
                              ? 'text-amber-300'
                              : isDark
                              ? 'text-gray-400'
                              : 'text-gray-500'
                          }`}
                        >
                          {group.geminiJudgment
                            ? group.geminiJudgment.reason
                            : primaryPhoto.score.primaryReason}
                        </p>
                      </div>

                      {/* 連写グループ内の切り替えサムネイル */}
                      {group.photos.length > 1 ? (
                        <div
                          className={`pt-2 border-t flex items-center justify-between gap-1 ${
                            isDark ? 'border-gray-800' : 'border-gray-100'
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center gap-1 overflow-x-auto">
                            {group.photos.slice(0, 5).map((p) => {
                              const isChosen = !group.excluded && group.selectedIds.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  onClick={() => handleSelectSingleBest(group.id, p.id)}
                                  title={`${p.fileName} (${p.score.total}点)`}
                                  className={`relative w-8 h-8 rounded overflow-hidden border transition shrink-0 ${
                                    isChosen
                                      ? 'border-blue-500 ring-1 ring-blue-500'
                                      : 'border-transparent opacity-55 hover:opacity-100'
                                  }`}
                                >
                                  <img
                                    src={p.thumbnailUrl}
                                    alt={p.fileName}
                                    className="w-full h-full object-cover"
                                  />
                                  {isChosen && (
                                    <span className="absolute bottom-0 right-0 bg-blue-600 text-white p-0.5">
                                      <Check className="w-2 h-2" />
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                            {group.photos.length > 5 && (
                              <span className="text-[10px] text-gray-500 pl-1">
                                +{group.photos.length - 5}
                              </span>
                            )}
                          </div>

                          <button
                            onClick={() => handleToggleExcludeGroup(group.id)}
                            title={group.excluded ? '除外を解除' : '除外する'}
                            className={`p-1.5 rounded transition ${
                              group.excluded
                                ? 'bg-rose-600 text-white'
                                : 'text-gray-400 hover:text-rose-400'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div
                          className="flex justify-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleToggleExcludeGroup(group.id)}
                            title={group.excluded ? '除外を解除' : '除外する'}
                            className={`p-1 rounded transition ${
                              group.excluded
                                ? 'bg-rose-600 text-white'
                                : 'text-gray-500 hover:text-rose-400'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>

      <BoutCompareModal
        group={activeGroup}
        groupIndex={activeGroupIndex}
        totalGroups={filteredGroups.length}
        hasGeminiKey={Boolean(settings.geminiApiKey.trim())}
        isJudgingGemini={Boolean(activeGroup && judgingGroupId === activeGroup.id)}
        onClose={() => setActiveGroupId(null)}
        onPrevGroup={() => {
          if (activeGroupIndex > 0) {
            setActiveGroupId(filteredGroups[activeGroupIndex - 1].id);
          }
        }}
        onNextGroup={() => {
          if (activeGroupIndex >= 0 && activeGroupIndex < filteredGroups.length - 1) {
            setActiveGroupId(filteredGroups[activeGroupIndex + 1].id);
          }
        }}
        onSelectSingleBest={handleSelectSingleBest}
        onToggleMultiSelect={handleToggleMultiSelect}
        onToggleExcludeGroup={handleToggleExcludeGroup}
        onAskGemini={handleAskGeminiSingle}
      />

      <ExportModal
        isOpen={isExportOpen}
        groups={groups}
        settings={settings}
        onClose={() => setIsExportOpen(false)}
        onOpenSettings={() => {
          setIsExportOpen(false);
          setIsSettingsOpen(true);
        }}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClose={() => setIsSettingsOpen(false)}
      />

      <CameraCaptureModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCaptureFiles={handleImportFiles}
      />
    </div>
  );
};

async function traverseFileTree(entry: FileSystemEntry, collected: File[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | null>((resolve) =>
      fileEntry.file((f) => resolve(f), () => resolve(null))
    );
    if (file) collected.push(file);
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const readEntriesBatch = (): Promise<FileSystemEntry[]> =>
      new Promise((resolve) => reader.readEntries((entries) => resolve(entries), () => resolve([])));

    let batch = await readEntriesBatch();
    while (batch.length > 0) {
      for (const child of batch) {
        await traverseFileTree(child, collected);
      }
      batch = await readEntriesBatch();
    }
  }
}
