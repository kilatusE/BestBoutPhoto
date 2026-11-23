import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  FolderOpen,
  ImagePlus,
  Sparkles,
  Sliders,
  Settings as SettingsIcon,
  FolderOutput,
  Award,
  Layers,
  Trash2,
  Check,
  Loader2,
  Zap,
  RotateCcw,
  Sun,
  Moon,
  Eye
} from 'lucide-react';
import { AppSettings, PhotoGroup, PhotoItem, SceneType } from './types';
import { analyzePhotoEntry, pairImportedFiles } from './utils/imageAnalyzer';
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

  // 解析進行状況
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // モーダル開閉状態
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  // Gemini AI 判定状態
  const [judgingGroupId, setJudgingGroupId] = useState<string | null>(null);
  const [isBatchJudging, setIsBatchJudging] = useState(false);
  const [aiErrorMsg, setAiErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // 設定の保存とダーク/ライトテーマ反映
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage errors
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

  // 感度スライダーやしきい値変更時、保存済み特徴量から再デコードなしで即時再グルーピング（SPEC 4.2）
  useEffect(() => {
    if (photos.length === 0) {
      setGroups([]);
      return;
    }
    setGroups((prevGroups) => {
      // 既存の手動選択・除外・Gemini判定を可能な限り引き継ぐマップ
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

  // 写真取り込み＆逐次省メモリ解析
  const handleImportFiles = async (rawFileList: File[]) => {
    if (rawFileList.length === 0) return;
    const pairedEntries = pairImportedFiles(rawFileList, settings.pairRaw);
    if (pairedEntries.length === 0) return;

    setIsAnalyzing(true);
    setAnalyzeProgress({ current: 0, total: pairedEntries.length, fileName: '' });

    const newPhotoItems: PhotoItem[] = [];
    // 3枚ずつ並列解析してUIフリーズとメモリピークを防止
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

  // サンプル連写データの読み込み
  const handleLoadDemo = async () => {
    setIsAnalyzing(true);
    setAnalyzeProgress({ current: 0, total: 8, fileName: 'サンプル連写写真を生成中...' });
    const demoFiles = await generateDemoPhotoFiles();
    await handleImportFiles(demoFiles);
  };

  // 全クリア（ObjectURL解放）
  const handleResetAll = () => {
    for (const p of photos) {
      URL.revokeObjectURL(p.thumbnailUrl);
    }
    setPhotos([]);
    setGroups([]);
    setActiveGroupId(null);
    setFilter('all');
  };

  // ドラッグ＆ドロップ（フォルダ再帰走査対応）
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

  // バウト採用操作
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

  // 単一グループのGemini相談
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
      setAiErrorMsg(err instanceof Error ? err.message : 'Gemini判定に失敗しました');
    } finally {
      setJudgingGroupId(null);
    }
  };

  // 僅差グループを一括AI再判定（SPEC 4.4）
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
      setAiErrorMsg(err instanceof Error ? err.message : '一括AI判定中にエラーが発生しました');
    } finally {
      setJudgingGroupId(null);
      setIsBatchJudging(false);
    }
  };

  // フィルター適用後グループ
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
  const rawPairedCount = useMemo(
    () => photos.filter((p) => Boolean(p.rawFile)).length,
    [photos]
  );

  const isDark = settings.theme === 'dark';

  return (
    <div
      className={`min-h-screen flex flex-col transition-colors ${
        isDark ? 'bg-[#0F1115] text-gray-100' : 'bg-gray-100 text-gray-900'
      }`}
    >
      {/* ヘッダー */}
      <header
        className={`sticky top-0 z-30 backdrop-blur-md border-b px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3 ${
          isDark
            ? 'bg-[#14171D]/90 border-gray-800/80'
            : 'bg-white/90 border-gray-200 shadow-sm'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Award className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-base sm:text-lg tracking-tight">BestBout Photo</h1>
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                PWA / 0円ブラウザ完結
              </span>
            </div>
            <p className={`text-[11px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              連写・類似写真の自動グルーピング＆ベストショット選出・同期ズーム比較
            </p>
          </div>
        </div>

        {/* 右側アクションボタン群 */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setIsCameraOpen(true)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition ${
              isDark
                ? 'bg-gray-800/80 hover:bg-gray-700 text-gray-200 border-gray-700'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
            }`}
          >
            <Camera className="w-3.5 h-3.5 text-indigo-400" />
            <span>カメラ連写</span>
          </button>

          {photos.length > 0 && (
            <button
              onClick={handleResetAll}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 border transition ${
                isDark
                  ? 'bg-gray-800/60 hover:bg-gray-800 text-gray-300 border-gray-700'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-300'
              }`}
              title="読み込んだ写真をクリア"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>リセット</span>
            </button>
          )}

          <button
            onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
            className={`p-2 rounded-xl border transition ${
              isDark
                ? 'bg-gray-800/70 hover:bg-gray-700 text-gray-300 border-gray-700'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-300'
            }`}
            title="ダーク/ライトモード切替"
          >
            {isDark ? <Moon className="w-4 h-4 text-indigo-400" /> : <Sun className="w-4 h-4 text-amber-500" />}
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            className={`p-2 rounded-xl border transition ${
              isDark
                ? 'bg-gray-800/70 hover:bg-gray-700 text-gray-300 border-gray-700'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-300'
            }`}
            title="設定（Gemini API / Google Drive / RAWペアリング）"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>

          <button
            onClick={() => setIsExportOpen(true)}
            disabled={selectedPhotos.length === 0}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs sm:text-sm font-bold flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 transition"
          >
            <FolderOutput className="w-4 h-4" />
            <span>保存・クラウド転送 ({selectedPhotos.length}枚)</span>
          </button>
        </div>
      </header>

      {/* 非表示ファイル/フォルダInput */}
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
        // @ts-expect-error webkitdirectory is standard across desktop browsers
        webkitdirectory="true"
        onChange={(e) => {
          if (e.target.files) handleImportFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* メインコンテンツ */}
      <main
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 space-y-5"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
      >
        {/* AIエラー通知 */}
        {aiErrorMsg && (
          <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-200 text-xs flex items-center justify-between">
            <span>⚠️ {aiErrorMsg}</span>
            <button onClick={() => setAiErrorMsg(null)} className="underline ml-3">
              閉じる
            </button>
          </div>
        )}

        {/* 解析プログレスバー */}
        {isAnalyzing && (
          <div className="p-4 rounded-2xl bg-indigo-950/60 border border-indigo-500/40 space-y-2 shadow-lg">
            <div className="flex items-center justify-between text-xs sm:text-sm text-indigo-200 font-semibold">
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                オンデバイス高速解析＆サムネイル生成中... ({analyzeProgress.fileName})
              </span>
              <span className="font-mono">
                {analyzeProgress.current} / {analyzeProgress.total} 枚
              </span>
            </div>
            <div className="w-full h-2.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-150"
                style={{
                  width: `${Math.round(
                    (analyzeProgress.current / Math.max(1, analyzeProgress.total)) * 100
                  )}%`
                }}
              />
            </div>
          </div>
        )}

        {/* 写真未読み込み時のウェルカム＆ドロップゾーン */}
        {photos.length === 0 && !isAnalyzing ? (
          <div
            className={`rounded-3xl border-2 border-dashed p-8 sm:p-14 text-center transition flex flex-col items-center justify-center gap-5 ${
              isDraggingOver
                ? 'border-indigo-400 bg-indigo-500/10'
                : isDark
                ? 'border-gray-700/80 bg-[#151820]/80 hover:border-gray-600'
                : 'border-gray-300 bg-white hover:border-gray-400'
            }`}
          >
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <ImagePlus className="w-8 h-8" />
            </div>

            <div className="space-y-2 max-w-xl">
              <h2 className="text-lg sm:text-xl font-bold">
                写真またはSDカードのフォルダ（DCIM）をここにドロップ
              </h2>
              <p className={`text-xs sm:text-sm leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                50MP高画素機（α1 II等）の高速連写・RAW+JPEG（<code>.ARW</code> + <code>.JPG</code>）ペアリングからスマホ写真まで、すべてブラウザ内のメモリ最適化エンジンで高速選別します。写真が外部サーバーに送信されることはありません。
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm flex items-center gap-2 shadow-lg shadow-indigo-600/30 transition"
              >
                <ImagePlus className="w-4 h-4" />
                <span>写真ファイルを選択（複数可）</span>
              </button>

              <button
                onClick={() => folderInputRef.current?.click()}
                className={`px-5 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 border transition ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-100 border-gray-700'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                }`}
              >
                <FolderOpen className="w-4 h-4 text-amber-400" />
                <span>フォルダごと読み込む (SDカード等)</span>
              </button>

              <button
                onClick={() => setIsCameraOpen(true)}
                className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 border transition ${
                  isDark
                    ? 'bg-gray-800/80 hover:bg-gray-700 text-gray-200 border-gray-700'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                }`}
              >
                <Camera className="w-4 h-4 text-emerald-400" />
                <span>カメラで連写撮影</span>
              </button>

              <button
                onClick={handleLoadDemo}
                className="px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 font-semibold text-sm flex items-center gap-2 transition"
              >
                <Zap className="w-4 h-4" />
                <span>サンプル連写データで試す (RAWペア付)</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* 写真読み込み後のコントロールバー＆ベストバウト一覧 */}
        {photos.length > 0 && (
          <>
            {/* サマリー＆リアルタイム感度スライダーバー */}
            <div
              className={`p-4 rounded-2xl border flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 ${
                isDark ? 'bg-[#161920] border-gray-800' : 'bg-white border-gray-200 shadow-sm'
              }`}
            >
              {/* 統計バッジと追加読み込み */}
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <div className="px-3 py-1.5 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-semibold">
                  全 {photos.length} 枚 → {groups.length} グループに集約（選出 {selectedPhotos.length} 枚）
                </div>
                {rawPairedCount > 0 && (
                  <div className="px-2.5 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold">
                    +RAWペア {rawPairedCount}組
                  </div>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={`px-3 py-1.5 rounded-xl font-medium flex items-center gap-1 border ${
                    isDark
                      ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                  }`}
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                  <span>写真を追加</span>
                </button>
                <button
                  onClick={() => folderInputRef.current?.click()}
                  className={`px-3 py-1.5 rounded-xl font-medium flex items-center gap-1 border ${
                    isDark
                      ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                  }`}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>フォルダ追加</span>
                </button>
              </div>

              {/* リアルタイムまとめ具合スライダー（SPEC 4.2） */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 min-w-[260px] flex-1 sm:flex-initial">
                  <Sliders className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span className="text-xs font-semibold whitespace-nowrap">まとめ具合:</span>
                  <span className="text-[11px] text-gray-400">厳しめ</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settings.groupingSensitivity}
                    onChange={(e) =>
                      updateSettings({ groupingSensitivity: Number(e.target.value) })
                    }
                    className="w-28 sm:w-36 accent-indigo-500 cursor-pointer"
                  />
                  <span className="text-[11px] text-gray-400">ゆるめ</span>
                  <span className="text-xs font-mono text-indigo-400 w-7">
                    {settings.groupingSensitivity}
                  </span>
                </div>

                {/* 僅差グループ一括AI再判定ボタン（SPEC 4.4） */}
                {closeCallCount > 0 && (
                  <button
                    onClick={handleBatchAskGeminiForCloseCalls}
                    disabled={isBatchJudging}
                    className="px-3 py-1.5 rounded-xl bg-purple-600/20 hover:bg-purple-600/35 text-purple-200 border border-purple-500/40 text-xs font-semibold flex items-center gap-1.5 transition"
                  >
                    {isBatchJudging ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                    )}
                    <span>🤖 僅差({closeCallCount}件)を一括AI判定</span>
                  </button>
                )}
              </div>
            </div>

            {/* フィルタータブバー（SPEC 4.5.1） */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {[
                { id: 'all', label: `すべて (${groups.length})` },
                { id: 'close_call', label: `⚡ 僅差のみ (${closeCallCount})` },
                {
                  id: 'portrait',
                  label: `人物・ペット (${groups.filter((g) => !g.excluded && g.scene === 'portrait').length})`
                },
                {
                  id: 'food',
                  label: `料理・モノ (${groups.filter((g) => !g.excluded && g.scene === 'food').length})`
                },
                {
                  id: 'landscape',
                  label: `風景・建物 (${groups.filter((g) => !g.excluded && g.scene === 'landscape').length})`
                },
                {
                  id: 'document',
                  label: `資料・メモ (${groups.filter((g) => !g.excluded && g.scene === 'document').length})`
                },
                {
                  id: 'multi_selected',
                  label: `複数採用 (${groups.filter((g) => !g.excluded && g.selectedIds.length > 1).length})`
                },
                {
                  id: 'excluded',
                  label: `除外済み (${groups.filter((g) => g.excluded).length})`
                }
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setFilter(tab.id as FilterType)}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition border ${
                    filter === tab.id
                      ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/20'
                      : isDark
                      ? 'bg-[#181B22] hover:bg-gray-800 text-gray-300 border-gray-800'
                      : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ベストバウト一覧グリッド */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
                    className={`group/card relative rounded-2xl overflow-hidden border transition cursor-pointer flex flex-col ${
                      group.excluded
                        ? 'opacity-50 border-rose-900/40 bg-[#14161B]'
                        : isDark
                        ? 'bg-[#181B22] border-gray-800/90 hover:border-indigo-500/70 hover:shadow-xl hover:shadow-indigo-950/30'
                        : 'bg-white border-gray-200 hover:border-indigo-500 shadow-sm'
                    }`}
                  >
                    {/* サムネイル領域 */}
                    <div className="relative aspect-[3/2] bg-black overflow-hidden">
                      <img
                        src={primaryPhoto.thumbnailUrl}
                        alt={primaryPhoto.fileName}
                        className="w-full h-full object-cover group-hover/card:scale-[1.02] transition-transform duration-200"
                      />

                      {/* 左上：枚数バッジ & 僅差バッジ */}
                      <div className="absolute top-2.5 left-2.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`px-2.5 py-0.5 rounded-lg text-[11px] font-bold backdrop-blur-md border ${
                            group.photos.length > 1
                              ? 'bg-indigo-600/90 text-white border-indigo-400/40'
                              : 'bg-black/70 text-gray-200 border-white/15'
                          }`}
                        >
                          {group.photos.length > 1
                            ? `${group.photos.length}枚中 1位`
                            : '単独ショット'}
                        </span>

                        {group.isCloseCall && !group.excluded && (
                          <span className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-amber-500/90 text-black">
                            ⚡ 僅差 ({group.scoreDiff}点差)
                          </span>
                        )}

                        {isMulti && !group.excluded && (
                          <span className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-emerald-600/90 text-white flex items-center gap-1">
                            <Layers className="w-3 h-3" />
                            {group.selectedIds.length}枚採用
                          </span>
                        )}
                      </div>

                      {/* 右上：RAWバッジ & スコア */}
                      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                        {primaryPhoto.rawFileName && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/25 text-amber-200 border border-amber-400/40 backdrop-blur-md">
                            +RAW
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded-lg text-xs font-mono font-bold bg-black/75 text-indigo-300 border border-white/15 backdrop-blur-md">
                          {primaryPhoto.score.total}点
                        </span>
                      </div>

                      {/* ホバー時の「比較・等倍確認」ガイド */}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="px-3.5 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg">
                          <Eye className="w-3.5 h-3.5" />
                          {group.photos.length > 1
                            ? 'バウト比較・同期ズームを開く'
                            : '等倍ズーム・Exif詳細を開く'}
                        </span>
                      </div>

                      {/* AI判定中ローダー */}
                      {isBeingJudged && (
                        <div className="absolute inset-0 bg-purple-950/70 backdrop-blur-xs flex items-center justify-center">
                          <div className="flex items-center gap-2 text-xs font-bold text-purple-200">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Gemini AI 判定中...</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* カード下部情報 */}
                    <div className="p-3.5 flex-1 flex flex-col justify-between gap-2.5">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold truncate">
                            {primaryPhoto.fileName}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border shrink-0 ${sceneMeta.badgeClass}`}
                          >
                            {sceneMeta.shortLabel}
                          </span>
                        </div>

                        {group.geminiJudgment ? (
                          <p className="text-[11px] text-purple-300 line-clamp-2">
                            🤖 {group.geminiJudgment.reason}
                          </p>
                        ) : (
                          <p
                            className={`text-[11px] line-clamp-2 ${
                              isDark ? 'text-gray-400' : 'text-gray-600'
                            }`}
                          >
                            💡 {primaryPhoto.score.primaryReason}
                          </p>
                        )}
                      </div>

                      {/* 連写グループ内の候補ミニストリップ（クリックせずとも比較候補がわかり、直接ワンクリック切替も可能） */}
                      {group.photos.length > 1 && (
                        <div
                          className="pt-2 border-t border-gray-800/60 flex items-center justify-between gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center gap-1.5 overflow-x-auto">
                            {group.photos.slice(0, 5).map((p, idx) => {
                              const isChosen = !group.excluded && group.selectedIds.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  onClick={() => handleSelectSingleBest(group.id, p.id)}
                                  title={`#${idx + 1} ${p.fileName} (${p.score.total}点) を採用`}
                                  className={`relative w-9 h-9 rounded-lg overflow-hidden border-2 transition shrink-0 ${
                                    isChosen
                                      ? 'border-indigo-500 scale-105'
                                      : 'border-transparent opacity-60 hover:opacity-100'
                                  }`}
                                >
                                  <img
                                    src={p.thumbnailUrl}
                                    alt={p.fileName}
                                    className="w-full h-full object-cover"
                                  />
                                  {isChosen && (
                                    <span className="absolute bottom-0 right-0 bg-indigo-600 text-white p-0.5 rounded-tl">
                                      <Check className="w-2.5 h-2.5" />
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                            {group.photos.length > 5 && (
                              <span className="text-[10px] text-gray-400 pl-1">
                                +{group.photos.length - 5}
                              </span>
                            )}
                          </div>

                          <button
                            onClick={() => handleToggleExcludeGroup(group.id)}
                            title={group.excluded ? '除外を解除' : 'このグループを除外'}
                            className={`p-1.5 rounded-lg transition ${
                              group.excluded
                                ? 'bg-rose-600 text-white'
                                : 'text-gray-400 hover:text-rose-400 hover:bg-gray-800'
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

      {/* バウト2分割比較・同期ズームモーダル */}
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

      {/* 出力・クラウド転送モーダル */}
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

      {/* 設定モーダル */}
      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* アプリ内カメラ撮影モーダル */}
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
