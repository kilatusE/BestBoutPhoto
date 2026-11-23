import React from 'react';
import { X, Settings, Key, Cloud, Sliders, Sun, Moon } from 'lucide-react';
import { AppSettings } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  settings: AppSettings;
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onUpdateSettings,
  onClose
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 overflow-y-auto">
      <div className="w-full max-w-xl rounded-2xl bg-[#181B20] border border-gray-700/80 shadow-2xl overflow-hidden my-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2 text-white font-bold">
            <Settings className="w-5 h-5 text-indigo-400" />
            <span>アプリ設定（ブラウザ内 localStorage にのみ保存）</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto text-sm">
          {/* 1. 基本・テーマ・RAWペアリング */}
          <div className="p-4 rounded-xl bg-[#12141A] border border-gray-800 space-y-3">
            <div className="flex items-center gap-2 font-semibold text-gray-200 text-xs uppercase tracking-wider">
              <Sliders className="w-4 h-4 text-indigo-400" />
              <span>基本動作・RAW設定</span>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-gray-200">UIテーマ切り替え</div>
                <div className="text-[11px] text-gray-400">
                  写真の色味・ピントが見やすいダークモードを推奨
                </div>
              </div>
              <button
                onClick={() =>
                  onUpdateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
                }
                className="px-3 py-1.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-semibold flex items-center gap-1.5 border border-gray-700"
              >
                {settings.theme === 'dark' ? (
                  <>
                    <Moon className="w-3.5 h-3.5 text-indigo-400" />
                    <span>ダークモード</span>
                  </>
                ) : (
                  <>
                    <Sun className="w-3.5 h-3.5 text-amber-400" />
                    <span>ライトモード</span>
                  </>
                )}
              </button>
            </div>

            <label className="flex items-center justify-between cursor-pointer pt-2 border-t border-gray-800/80">
              <div>
                <div className="text-xs font-semibold text-gray-200">
                  RAW + JPEG 自動ペアリング（Sony .ARW / .CR3 / .NEF / .DNG 等）
                </div>
                <div className="text-[11px] text-gray-400">
                  同名ファイルを自動紐付けし、軽量なJPEGで比較して出力時にRAWをセット保存します
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.pairRaw}
                onChange={(e) => onUpdateSettings({ pairRaw: e.target.checked })}
                className="w-4 h-4 accent-indigo-500 rounded"
              />
            </label>

            <div className="pt-2 border-t border-gray-800/80">
              <div className="flex justify-between text-xs mb-1">
                <span className="font-semibold text-gray-200">僅差（接戦）バッジのスコア差しきい値</span>
                <span className="font-mono text-amber-300">{settings.closeCallThreshold} 点未満</span>
              </div>
              <input
                type="range"
                min={1}
                max={15}
                step={0.5}
                value={settings.closeCallThreshold}
                onChange={(e) => onUpdateSettings({ closeCallThreshold: Number(e.target.value) })}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>

          {/* 2. Gemini API キー設定 */}
          <div className="p-4 rounded-xl bg-[#12141A] border border-gray-800 space-y-3">
            <div className="flex items-center gap-2 font-semibold text-purple-300 text-xs uppercase tracking-wider">
              <Key className="w-4 h-4 text-purple-400" />
              <span>Gemini API オプション設定（接戦グループのAI相談用）</span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Google AI Studio で取得した無料の Gemini API キーを入力すると、バウト比較画面の「🤖 AIに相談」や一覧の「僅差グループ一括AI再判定」が利用できます（※キーはお使いのブラウザ内にのみ保存されます）。
            </p>
            <div>
              <label className="block text-xs text-gray-300 mb-1">Gemini API Key</label>
              <input
                type="password"
                value={settings.geminiApiKey}
                onChange={(e) => onUpdateSettings({ geminiApiKey: e.target.value })}
                placeholder="AIzaSy..."
                className="w-full px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-white text-xs font-mono focus:outline-none focus:border-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-300 mb-1">使用モデル</label>
              <select
                value={settings.geminiModel}
                onChange={(e) => onUpdateSettings({ geminiModel: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-white text-xs"
              >
                <option value="gemini-2.5-flash">gemini-2.5-flash（推奨：高速・無料枠が広い）</option>
                <option value="gemini-2.5-pro">gemini-2.5-pro（高精度）</option>
                <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              </select>
            </div>
          </div>

          {/* 3. Google Drive OAuth 設定 */}
          <div className="p-4 rounded-xl bg-[#12141A] border border-gray-800 space-y-3">
            <div className="flex items-center gap-2 font-semibold text-sky-300 text-xs uppercase tracking-wider">
              <Cloud className="w-4 h-4 text-sky-400" />
              <span>Google Drive 直接転送設定（OAuth 2.0）</span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Google Cloud Console で OAuth 2.0 クライアントID（種類: ウェブアプリケーション）を作成し、「承認済みの JavaScript 生成元」に GitHub Pages の URL（例: <code>https://あなたのID.github.io</code>）と <code>http://localhost:5173</code> を登録してください。同意画面は「テスト」のままで自分専用・審査なし・無料で利用できます。
            </p>
            <div>
              <label className="block text-xs text-gray-300 mb-1">
                Google OAuth クライアント ID
              </label>
              <input
                type="text"
                value={settings.googleClientId}
                onChange={(e) => onUpdateSettings({ googleClientId: e.target.value })}
                placeholder="1234567890-abcdefg.apps.googleusercontent.com"
                className="w-full px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-white text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-300 mb-1">
                保存先の親フォルダID（省略時はマイドライブ直下にイベントフォルダを作成）
              </label>
              <input
                type="text"
                value={settings.googleDriveParentFolderId}
                onChange={(e) => onUpdateSettings({ googleDriveParentFolderId: e.target.value })}
                placeholder="Google Drive フォルダURL末尾のID（任意）"
                className="w-full px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-white text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs"
            >
              保存して閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
