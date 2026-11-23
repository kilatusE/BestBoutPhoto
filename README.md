# BestBout Photo

大量の撮影写真（高速連写・撮り直し・RAW+JPEG含む）から似た写真を自動グルーピングし、シーン（人物・料理・風景・資料）に応じた採点でベストショットを選出・同期ズーム比較し、ローカルフォルダや Google Drive / Amazon Photos へ出力できる **自分専用・維持費0円のブラウザ完結型Webアプリ（PWA）** です。

---

## 主な機能

1. **高速オンデバイス解析 & 50MP高画素機向けメモリ保護**
   - フルサイズ高画素機（Sony α1 II 50.1MP 等）の大量連写でもブラウザがクラッシュしない3段階メモリ管理（解析用1024pxサムネイル生成＆即解放、比較中の2枚のみフル解像度デコード、出力時1枚ずつストリーミング処理）。
   - **RAW + JPEG 自動ペアリング**：同名の `.JPG` と `.ARW` / `.CR3` / `.NEF` / `.DNG` 等を自動で紐付け、軽量なJPEGで比較して出力時にRAWをセット保存。
2. **リアルタイム類似グルーピング & シーン別自動採点**
   - Exif撮影日時 + 知覚ハッシュ (`dHash`) + カラーヒストグラム + 連写時間ボーナスにより自動グループ化。
   - **まとめ具合スライダー（厳しめ ⇔ ゆるめ）** を動かすと再デコードなしで瞬時に再グルーピング。
   - **シーン自動判別**（人物・ペット / 料理・モノ / 風景・建物 / 資料・メモ）と目つぶり・ピント・露出・水平の自動採点。
3. **2分割バウト比較 & 同期ズーム・キーボードショートカット**
   - マウスホイール・ドラッグによる2枚連動ズーム＆パン、`Fit ⇔ 等倍ズーム` ワンタッチ切替。
   - ショートカット：`[1]` 左を採用、`[2]` 右を採用、`[B]` 両方残す（複数採用）、`[Z / Space]` 等倍ズーム、`[X]` グループ除外、`[← / →]` 切替、`[Enter]` 確定。
4. **Gemini API オプション判定**
   - 自分の無料枠 Gemini API キーを設定画面（ブラウザの `localStorage` のみ）に入れることで、接戦（僅差）グループの一括AI判定や個別AI相談が可能。
5. **イベントフォルダ単位の出力・クラウド転送**
   - **ローカル保存**：File System Access API によるPCフォルダ直接作成保存（オリジナル画質＋RAW同梱）または高速ZIP出力。
   - **Google Drive 直接転送**：長辺 `4096px` / JPEG品質 `88%` にリサイズしつつ **Exif（撮影日時・カメラ・レンズ情報）を完全引き継ぎ** して指定親フォルダ配下にイベントフォルダを自動作成＆アップロード。
   - **Amazon Photos 用出力**：スマホの共有シート（Web Share API）連携またはオリジナル画質＋RAW同梱ZIP。
   - **プライバシー保護**：Exifを維持したままGPS位置情報タグのみを除去するスイッチを搭載。
   - **除外リスト出力**：ボツになったファイル名一覧を `excluded_files.txt` として出力可能。

---

## GitHub Pages での公開・運用手順（完全無料）

このリポジトリには GitHub Actions による自動デプロイ設定（[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)）と、どのリポジトリ名でも動作する相対パス設定（`base: './'`）が組み込まれています。

### 1. GitHub リポジトリへ Push する
```bash
git init
git add .
git commit -m "Initial commit: BestBout Photo PWA"
git branch -M main
git remote add origin https://github.com/kilatusE/BestBoutPhoto.git
git push -u origin main
```

### 2. GitHub Pages を有効化する
1. GitHub のリポジトリ画面（https://github.com/kilatusE/BestBoutPhoto/settings/pages）で **Settings** → 左メニューの **Pages** を開きます。
2. **Build and deployment** の **Source** を `Deploy from a branch` から **`GitHub Actions`** に変更します。
3. **Actions** タブを開き、`Deploy to GitHub Pages` ワークフローが完了すると、`https://kilatuse.github.io/BestBoutPhoto/` でアプリが公開されます。
4. スマホやPCでこのURLを開き、「ホーム画面に追加（アプリをインストール）」すると、外出先やオフライン環境でもネイティブアプリのように利用できます。

---

## ローカルでの開発・起動

```bash
npm install
npm run dev
```
