import React from 'react';
import { X, Sun, Moon, Trash2 } from 'lucide-react';
import { AppSettings } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  settings: AppSettings;
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  onClearCredentials: () => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onUpdateSettings,
  onClearCredentials,
  onClose
}) => {
  if (!isOpen) return null;

  const hasSavedKeys = Boolean(
    settings.geminiApiKey.trim() ||
      settings.googleClientId.trim() ||
      settings.googleDriveParentFolderId.trim()
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 overflow-y-auto">
      <div className="w-full max-w-md rounded-xl bg-[#181A1F] border border-gray-800 shadow-2xl overflow-hidden my-6">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <span className="text-sm font-semibold text-white">設定</span>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto text-xs">
          {/* 基本設定 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-gray-200">テーマ</span>
              <button
                onClick={() =>
                  onUpdateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
                }
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 flex items-center gap-1.5 border border-gray-700"
              >
                {settings.theme === 'dark' ? (
                  <>
                    <Moon className="w-3.5 h-3.5" />
                    <span>ダーク</span>
                  </>
                ) : (
                  <>
                    <Sun className="w-3.5 h-3.5" />
                    <span>ライト</span>
                  </>
                )}
              </button>
            </div>

            <label className="flex items-center justify-between cursor-pointer pt-2 border-t border-gray-800">
              <span className="text-gray-200">同名のRAWとJPEGを自動でまとめる</span>
              <input
                type="checkbox"
                checked={settings.pairRaw}
                onChange={(e) => onUpdateSettings({ pairRaw: e.target.checked })}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>

            <div className="pt-2 border-t border-gray-800">
              <div className="flex justify-between mb-1">
                <span className="text-gray-200">僅差判定のスコア差</span>
                <span className="font-mono text-gray-400">{settings.closeCallThreshold}点未満</span>
              </div>
              <input
                type="range"
                min={1}
                max={15}
                step={0.5}
                value={settings.closeCallThreshold}
                onChange={(e) => onUpdateSettings({ closeCallThreshold: Number(e.target.value) })}
                className="w-full accent-blue-500"
              />
            </div>
          </div>

          {/* Gemini API */}
          <div className="pt-4 border-t border-gray-800 space-y-2.5">
            <div className="font-medium text-gray-200">Gemini API (AI判定用・任意)</div>
            <div>
              <label className="block text-gray-400 mb-1">API キー</label>
              <input
                type="password"
                autoComplete="off"
                value={settings.geminiApiKey}
                onChange={(e) => onUpdateSettings({ geminiApiKey: e.target.value })}
                placeholder="AIzaSy..."
                className="w-full px-3 py-1.5 rounded-lg bg-[#121316] border border-gray-700 text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-gray-400 mb-1">モデル</label>
              <select
                value={settings.geminiModel}
                onChange={(e) => onUpdateSettings({ geminiModel: e.target.value })}
                className="w-full px-3 py-1.5 rounded-lg bg-[#121316] border border-gray-700 text-white"
              >
                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              </select>
            </div>
          </div>

          {/* Google Drive */}
          <div className="pt-4 border-t border-gray-800 space-y-2.5">
            <div className="font-medium text-gray-200">Google Drive 連携 (任意)</div>
            <div>
              <label className="block text-gray-400 mb-1">OAuth クライアント ID</label>
              <input
                type="text"
                autoComplete="off"
                value={settings.googleClientId}
                onChange={(e) => onUpdateSettings({ googleClientId: e.target.value })}
                placeholder="xxxx.apps.googleusercontent.com"
                className="w-full px-3 py-1.5 rounded-lg bg-[#121316] border border-gray-700 text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-gray-400 mb-1">
                保存先の親フォルダID（空欄でマイドライブ直下）
              </label>
              <input
                type="text"
                autoComplete="off"
                value={settings.googleDriveParentFolderId}
                onChange={(e) => onUpdateSettings({ googleDriveParentFolderId: e.target.value })}
                placeholder="フォルダID"
                className="w-full px-3 py-1.5 rounded-lg bg-[#121316] border border-gray-700 text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-800">
            {hasSavedKeys ? (
              <button
                onClick={onClearCredentials}
                className="px-3 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900/70 text-rose-300 border border-rose-800/50 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>保存済みキーを消去</span>
              </button>
            ) : (
              <span />
            )}

            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
