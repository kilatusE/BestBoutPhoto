import React, { useEffect, useState } from 'react';
import {
  X,
  FolderOutput,
  HardDrive,
  CloudUpload,
  Share2,
  ShieldAlert,
  FileText,
  CheckCircle2,
  Loader2,
  Download
} from 'lucide-react';
import { AppSettings, PhotoGroup } from '../types';
import {
  downloadAsZip,
  downloadExcludedFilesList,
  getExcludedPhotos,
  getSelectedPhotos,
  requestGoogleDriveAccessToken,
  saveToLocalFolderDirect,
  shareViaWebShareApi,
  uploadToGoogleDrive
} from '../utils/exportEngine';
import { getMostFrequentDatePrefix } from '../utils/exifUtils';

interface ExportModalProps {
  isOpen: boolean;
  groups: PhotoGroup[];
  settings: AppSettings;
  onClose: () => void;
  onOpenSettings: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  groups,
  settings,
  onClose,
  onOpenSettings
}) => {
  const selectedPhotos = getSelectedPhotos(groups);
  const excludedPhotos = getExcludedPhotos(groups);
  const rawCount = selectedPhotos.filter((p) => Boolean(p.rawFile)).length;

  const [folderName, setFolderName] = useState('');
  const [stripGps, setStripGps] = useState(false);

  // ローカル保存設定
  const [localIncludeRaw, setLocalIncludeRaw] = useState(true);

  // Google Drive設定
  const [driveMaxDim, setDriveMaxDim] = useState(4096);
  const [driveQuality, setDriveQuality] = useState(0.88);
  const [driveIncludeRaw, setDriveIncludeRaw] = useState(false);

  // Amazon Photos設定
  const [amazonIncludeRaw, setAmazonIncludeRaw] = useState(true);

  // 進行状況・ステータス
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressInfo, setProgressInfo] = useState<{
    stage: string;
    current: number;
    total: number;
    fileName?: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const supportsDirectoryPicker =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const supportsWebShare =
    typeof navigator !== 'undefined' && 'share' in navigator && 'canShare' in navigator;

  useEffect(() => {
    if (isOpen && selectedPhotos.length > 0) {
      const prefix = getMostFrequentDatePrefix(selectedPhotos.map((p) => p.exif.timestamp));
      setFolderName((prev) => (prev && prev.startsWith(prefix.slice(0, 10)) ? prev : `${prefix}イベント`));
      setStatusMessage(null);
    }
  }, [isOpen, groups]);

  if (!isOpen) return null;

  const handleLocalDirectSave = async () => {
    if (selectedPhotos.length === 0) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const ok = await saveToLocalFolderDirect(
        selectedPhotos,
        folderName,
        { includeRaw: localIncludeRaw, stripGps },
        (info) => setProgressInfo(info)
      );
      if (!ok) {
        await downloadAsZip(
          selectedPhotos,
          folderName,
          { includeRaw: localIncludeRaw, stripGps },
          (info) => setProgressInfo(info)
        );
        setStatusMessage({
          type: 'success',
          text: `ブラウザが直接フォルダ書き込み非対応のため、ZIPファイル（${folderName}.zip）をダウンロードしました。`
        });
      } else {
        setStatusMessage({
          type: 'success',
          text: `指定フォルダ内に「${folderName}」を作成し、${selectedPhotos.length}枚（＋RAW）を直接保存しました！`
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage(null);
      } else {
        setStatusMessage({
          type: 'error',
          text: err instanceof Error ? err.message : '保存中にエラーが発生しました。'
        });
      }
    } finally {
      setIsProcessing(false);
      setProgressInfo(null);
    }
  };

  const handleLocalZipDownload = async () => {
    if (selectedPhotos.length === 0) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await downloadAsZip(
        selectedPhotos,
        folderName,
        { includeRaw: localIncludeRaw, stripGps },
        (info) => setProgressInfo(info)
      );
      setStatusMessage({
        type: 'success',
        text: `オリジナル画質のZIP（${folderName}.zip）を生成・ダウンロードしました！`
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'ZIP生成エラーが発生しました。'
      });
    } finally {
      setIsProcessing(false);
      setProgressInfo(null);
    }
  };

  const handleGoogleDriveUpload = async () => {
    if (selectedPhotos.length === 0) return;
    if (!settings.googleClientId.trim()) {
      setStatusMessage({
        type: 'error',
        text: 'Google Drive 転送には設定画面で「Google OAuth クライアントID」の登録が必要です。'
      });
      return;
    }

    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const token = await requestGoogleDriveAccessToken(settings.googleClientId);
      const res = await uploadToGoogleDrive(
        selectedPhotos,
        folderName,
        {
          accessToken: token,
          parentFolderId: settings.googleDriveParentFolderId,
          maxDimension: driveMaxDim,
          jpegQuality: driveQuality,
          includeRaw: driveIncludeRaw,
          stripGps
        },
        (info) => setProgressInfo(info)
      );
      setStatusMessage({
        type: 'success',
        text: `Google Drive にフォルダ「${folderName}」を作成し、${res.uploadedCount} ファイルを転送完了しました！`
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Google Drive アップロードに失敗しました。'
      });
    } finally {
      setIsProcessing(false);
      setProgressInfo(null);
    }
  };

  const handleAmazonPhotosExport = async (preferWebShare: boolean) => {
    if (selectedPhotos.length === 0) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      if (preferWebShare && supportsWebShare) {
        const shared = await shareViaWebShareApi(
          selectedPhotos,
          folderName,
          { includeRaw: amazonIncludeRaw, stripGps },
          (info) => setProgressInfo(info)
        );
        if (shared) {
          setStatusMessage({
            type: 'success',
            text: '共有シートから Amazon Photos 等への受け渡しが完了しました！'
          });
          return;
        }
      }

      await downloadAsZip(
        selectedPhotos,
        folderName,
        { includeRaw: amazonIncludeRaw, stripGps, zipSuffix: '_AmazonPhotos' },
        (info) => setProgressInfo(info)
      );
      setStatusMessage({
        type: 'success',
        text: `Amazon Photos 投入用の無変換オリジナルZIP（${folderName}_AmazonPhotos.zip）をダウンロードしました！`
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage(null);
      } else {
        setStatusMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Amazon Photos用出力でエラーが発生しました。'
        });
      }
    } finally {
      setIsProcessing(false);
      setProgressInfo(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl bg-[#181B20] border border-gray-700/80 shadow-2xl overflow-hidden my-6">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <FolderOutput className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base sm:text-lg font-bold text-white">
              ベストショット出力・クラウド転送 ({selectedPhotos.length}枚選出
              {rawCount > 0 ? ` / +RAW ${rawCount}枚` : ''})
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          {/* 1. イベントフォルダ名 & GPS保護スイッチ */}
          <div className="p-4 rounded-xl bg-[#12141A] border border-gray-800 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                出力イベントフォルダ名（最頻撮影日から自動入力・追記可）
              </label>
              <input
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="2026-11-23_イベント名"
                className="w-full px-3.5 py-2 rounded-xl bg-gray-900 border border-gray-700 text-white text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            <label className="flex items-center justify-between cursor-pointer pt-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-emerald-400" />
                <div>
                  <div className="text-xs font-semibold text-gray-200">
                    GPS位置情報を削除して出力（プライバシー保護）
                  </div>
                  <div className="text-[11px] text-gray-400">
                    撮影日時・カメラ・レンズ情報のExifは維持したままGPSタグのみ除去します
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={stripGps}
                onChange={(e) => setStripGps(e.target.checked)}
                className="w-4 h-4 accent-indigo-500 rounded"
              />
            </label>
          </div>

          {/* 進捗バー */}
          {isProcessing && progressInfo && (
            <div className="p-4 rounded-xl bg-indigo-950/50 border border-indigo-500/40 space-y-2">
              <div className="flex items-center justify-between text-xs text-indigo-200">
                <span className="flex items-center gap-2 font-semibold">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  {progressInfo.stage} ({progressInfo.fileName || ''})
                </span>
                <span className="font-mono">
                  {progressInfo.current} / {progressInfo.total}
                </span>
              </div>
              <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{
                    width: `${Math.round(
                      (progressInfo.current / Math.max(1, progressInfo.total)) * 100
                    )}%`
                  }}
                />
              </div>
            </div>
          )}

          {/* 完了・エラーメッセージ */}
          {statusMessage && (
            <div
              className={`p-3.5 rounded-xl border text-xs flex items-start gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-200'
                  : 'bg-rose-950/50 border-rose-500/40 text-rose-200'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">{statusMessage.text}</div>
            </div>
          )}

          {/* 2. ローカル保存カード */}
          <div className="p-4 rounded-xl bg-[#1F242D]/70 border border-gray-700/70 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-indigo-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">ローカル保存（オリジナル無変換）</h3>
                  <p className="text-[11px] text-gray-400">
                    元ファイル名を維持してPCフォルダ直接作成、または一括ZIPで保存
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localIncludeRaw}
                  onChange={(e) => setLocalIncludeRaw(e.target.checked)}
                  className="accent-indigo-500 rounded"
                />
                <span>RAW (.ARW) 同梱</span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              {supportsDirectoryPicker && (
                <button
                  onClick={handleLocalDirectSave}
                  disabled={isProcessing || selectedPhotos.length === 0}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-indigo-600/20"
                >
                  <HardDrive className="w-4 h-4" />
                  <span>保存先フォルダを選んで直接作成保存</span>
                </button>
              )}

              <button
                onClick={handleLocalZipDownload}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-100 text-xs font-semibold flex items-center gap-1.5 border border-gray-600"
              >
                <Download className="w-4 h-4" />
                <span>イベントフォルダ入りZIPでダウンロード</span>
              </button>
            </div>
          </div>

          {/* 3. Google Drive 転送カード */}
          <div className="p-4 rounded-xl bg-[#1F242D]/70 border border-gray-700/70 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CloudUpload className="w-5 h-5 text-sky-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Google Drive 転送（長辺4096px / Exif保持）
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    容量を節約（約2.5〜5MB/枚）しながら4K高精細＆Exif維持で親フォルダ配下へ直接転送
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={driveIncludeRaw}
                  onChange={(e) => setDriveIncludeRaw(e.target.checked)}
                  className="accent-sky-500 rounded"
                />
                <span>RAW (.ARW) も転送</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">出力サイズ</label>
                <select
                  value={driveMaxDim}
                  onChange={(e) => setDriveMaxDim(Number(e.target.value))}
                  className="w-full px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200"
                >
                  <option value={4096}>長辺 4096px (推奨・4K高画質)</option>
                  <option value={2560}>長辺 2560px (軽量・高速)</option>
                  <option value={0}>オリジナル解像度（無変換）</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">JPEG品質</label>
                <select
                  value={driveQuality}
                  onChange={(e) => setDriveQuality(Number(e.target.value))}
                  className="w-full px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200"
                >
                  <option value={0.88}>88%（推奨：画質と容量の最適バランス）</option>
                  <option value={0.94}>94%（高画質優先）</option>
                  <option value={0.8}>80%（容量節約優先）</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                onClick={handleGoogleDriveUpload}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-sky-600/20"
              >
                <CloudUpload className="w-4 h-4" />
                <span>Google Drive へ直接アップロード</span>
              </button>

              {!settings.googleClientId && (
                <button
                  onClick={onOpenSettings}
                  className="text-xs text-amber-300 hover:underline"
                >
                  ※ 初回のみ設定画面で Google Client ID を設定してください →
                </button>
              )}
            </div>
          </div>

          {/* 4. Amazon Photos 用カード */}
          <div className="p-4 rounded-xl bg-[#1F242D]/70 border border-gray-700/70 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Share2 className="w-5 h-5 text-amber-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Amazon Photos 用出力（Prime無制限劣化なし保存向け）
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    オリジナル画質＋RAW(.ARW)のまま、スマホ共有シートまたは投入用ZIPで出力
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={amazonIncludeRaw}
                  onChange={(e) => setAmazonIncludeRaw(e.target.checked)}
                  className="accent-amber-500 rounded"
                />
                <span>RAW (.ARW) 同梱</span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              {supportsWebShare && (
                <button
                  onClick={() => handleAmazonPhotosExport(true)}
                  disabled={isProcessing || selectedPhotos.length === 0}
                  className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <Share2 className="w-4 h-4" />
                  <span>スマホ共有シートで Amazon Photos アプリへ送る</span>
                </button>
              )}

              <button
                onClick={() => handleAmazonPhotosExport(false)}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-100 text-xs font-semibold flex items-center gap-1.5 border border-gray-600"
              >
                <Download className="w-4 h-4" />
                <span>Amazon Photos 投入用 オリジナルZIP出力</span>
              </button>
            </div>
          </div>

          {/* 5. 補助オプション: 除外（ボツ）写真リスト出力 */}
          <div className="pt-2 border-t border-gray-800 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-gray-400">
              選外（ボツ）となった写真: <span className="font-bold text-gray-200">{excludedPhotos.length}</span> 枚
            </div>
            <button
              onClick={() => downloadExcludedFilesList(groups, folderName)}
              disabled={excludedPhotos.length === 0}
              className="px-3 py-1.5 rounded-lg bg-gray-800/80 hover:bg-gray-700 disabled:opacity-40 text-gray-300 text-xs flex items-center gap-1.5 border border-gray-700"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>除外ファイル一覧 (excluded_files.txt) を出力</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
