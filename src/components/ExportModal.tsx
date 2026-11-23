import React, { useEffect, useState } from 'react';
import {
  X,
  HardDrive,
  CloudUpload,
  Share2,
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

  const [localIncludeRaw, setLocalIncludeRaw] = useState(true);
  const [driveMaxDim, setDriveMaxDim] = useState(4096);
  const [driveQuality, setDriveQuality] = useState(0.88);
  const [driveIncludeRaw, setDriveIncludeRaw] = useState(false);
  const [amazonIncludeRaw, setAmazonIncludeRaw] = useState(true);

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
          text: `${folderName}.zip をダウンロードしました。`
        });
      } else {
        setStatusMessage({
          type: 'success',
          text: `「${folderName}」に ${selectedPhotos.length}枚を保存しました。`
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
        text: `${folderName}.zip をダウンロードしました。`
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
        text: '設定画面で Google クライアントID を入力してください。'
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
        text: `Google Drive の「${folderName}」へ ${res.uploadedCount} ファイルをアップロードしました。`
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
            text: '共有シートでの送信が完了しました。'
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
        text: `${folderName}_AmazonPhotos.zip をダウンロードしました。`
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage(null);
      } else {
        setStatusMessage({
          type: 'error',
          text: err instanceof Error ? err.message : '出力エラーが発生しました。'
        });
      }
    } finally {
      setIsProcessing(false);
      setProgressInfo(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 overflow-y-auto">
      <div className="w-full max-w-xl rounded-xl bg-[#181A1F] border border-gray-800 shadow-2xl overflow-hidden my-6">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">
            書き出し ({selectedPhotos.length}枚{rawCount > 0 ? ` / RAW ${rawCount}枚` : ''})
          </h2>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* フォルダ名 & GPS削除 */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">フォルダ名</label>
              <input
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="2026-11-23_イベント名"
                className="w-full px-3 py-2 rounded-lg bg-[#121316] border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>

            <label className="flex items-center justify-between cursor-pointer text-xs text-gray-300">
              <span>GPS位置情報を削除して書き出す</span>
              <input
                type="checkbox"
                checked={stripGps}
                onChange={(e) => setStripGps(e.target.checked)}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>
          </div>

          {isProcessing && progressInfo && (
            <div className="p-3.5 rounded-lg bg-gray-900 border border-gray-700 space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-200">
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  {progressInfo.stage}
                </span>
                <span className="font-mono">
                  {progressInfo.current} / {progressInfo.total}
                </span>
              </div>
              <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{
                    width: `${Math.round(
                      (progressInfo.current / Math.max(1, progressInfo.total)) * 100
                    )}%`
                  }}
                />
              </div>
            </div>
          )}

          {statusMessage && (
            <div
              className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-950/50 border-emerald-700/50 text-emerald-200'
                  : 'bg-rose-950/50 border-rose-700/50 text-rose-200'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">{statusMessage.text}</div>
            </div>
          )}

          {/* ローカル保存 */}
          <div className="p-4 rounded-xl bg-[#121316] border border-gray-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <HardDrive className="w-4 h-4 text-gray-400" />
                <span>ローカル保存</span>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localIncludeRaw}
                  onChange={(e) => setLocalIncludeRaw(e.target.checked)}
                  className="accent-blue-500 rounded"
                />
                <span>RAWを含める</span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              {supportsDirectoryPicker && (
                <button
                  onClick={handleLocalDirectSave}
                  disabled={isProcessing || selectedPhotos.length === 0}
                  className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>フォルダへ直接保存</span>
                </button>
              )}

              <button
                onClick={handleLocalZipDownload}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-3.5 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 text-xs font-medium flex items-center gap-1.5 border border-gray-700"
              >
                <Download className="w-3.5 h-3.5" />
                <span>ZIPでダウンロード</span>
              </button>
            </div>
          </div>

          {/* Google Drive */}
          <div className="p-4 rounded-xl bg-[#121316] border border-gray-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <CloudUpload className="w-4 h-4 text-gray-400" />
                <span>Google Drive</span>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={driveIncludeRaw}
                  onChange={(e) => setDriveIncludeRaw(e.target.checked)}
                  className="accent-blue-500 rounded"
                />
                <span>RAWを含める</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <select
                value={driveMaxDim}
                onChange={(e) => setDriveMaxDim(Number(e.target.value))}
                className="px-2.5 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200"
              >
                <option value={4096}>長辺 4096px</option>
                <option value={2560}>長辺 2560px</option>
                <option value={0}>オリジナルサイズ</option>
              </select>
              <select
                value={driveQuality}
                onChange={(e) => setDriveQuality(Number(e.target.value))}
                className="px-2.5 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200"
              >
                <option value={0.88}>画質 88% (標準)</option>
                <option value={0.94}>画質 94% (高画質)</option>
                <option value={0.8}>画質 80% (軽量)</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={handleGoogleDriveUpload}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-3.5 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-100 text-xs font-medium flex items-center gap-1.5 border border-gray-700"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>Google Drive へアップロード</span>
              </button>

              {!settings.googleClientId && (
                <button
                  onClick={onOpenSettings}
                  className="text-xs text-gray-400 hover:text-gray-200 underline"
                >
                  Google連携を設定
                </button>
              )}
            </div>
          </div>

          {/* Amazon Photos / スマホ共有 */}
          <div className="p-4 rounded-xl bg-[#121316] border border-gray-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Share2 className="w-4 h-4 text-gray-400" />
                <span>Amazon Photos / 共有</span>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={amazonIncludeRaw}
                  onChange={(e) => setAmazonIncludeRaw(e.target.checked)}
                  className="accent-blue-500 rounded"
                />
                <span>RAWを含める</span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              {supportsWebShare && (
                <button
                  onClick={() => handleAmazonPhotosExport(true)}
                  disabled={isProcessing || selectedPhotos.length === 0}
                  className="px-3.5 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-xs font-medium flex items-center gap-1.5 border border-gray-700"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>他のアプリへ共有</span>
                </button>
              )}

              <button
                onClick={() => handleAmazonPhotosExport(false)}
                disabled={isProcessing || selectedPhotos.length === 0}
                className="px-3.5 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 text-xs font-medium flex items-center gap-1.5 border border-gray-700"
              >
                <Download className="w-3.5 h-3.5" />
                <span>オリジナルZIP出力</span>
              </button>
            </div>
          </div>

          {/* 選外リスト */}
          {excludedPhotos.length > 0 && (
            <div className="pt-2 flex items-center justify-between text-xs text-gray-400">
              <span>不採用: {excludedPhotos.length}枚</span>
              <button
                onClick={() => downloadExcludedFilesList(groups, folderName)}
                className="hover:text-gray-200 flex items-center gap-1 underline"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>不採用ファイル名一覧 (.txt)</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
