import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // 相対パス './' にすることで、GitHub Pages のリポジトリ名（https://<user>.github.io/<repo>/）に依存せず動作
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'BestBout Photo - ベストショット選別＆転送',
        short_name: 'BestBout',
        description: '大量の写真から似た写真をグループ化し、ベストショットを選出・比較・Google Drive/Amazon Photosへ転送するブラウザ完結PWA',
        theme_color: '#0F1115',
        background_color: '#0F1115',
        display: 'standalone',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
      }
    })
  ]
});
