/**
 * カメラやSDカードが手元にない状態でも即座に「連写グルーピング・目つぶり検出・RAWペアリング・同期ズーム比較」を
 * 体験・テストできるリアルな合成サンプル写真（Exif相当の時刻差・RAWファイル付き）を生成するユーティリティ
 */
export async function generateDemoPhotoFiles(): Promise<File[]> {
  const files: File[] = [];
  const baseTime = new Date(2026, 10, 23, 14, 20, 0).getTime();

  // 1. 人物ポートレート3連写（1枚目: 少し目つぶり、2枚目: 瞳バッチリ＆シャープ、3枚目: 少しブレ）+ RAW(.ARW)ペア
  const portraitVariants = [
    { name: 'DSC01001', eyeOpen: 0.15, blur: 0, offsetSec: 0, note: 'Blink' },
    { name: 'DSC01002', eyeOpen: 1.0, blur: 0, offsetSec: 0.4, note: 'Best Sharp' },
    { name: 'DSC01003', eyeOpen: 0.9, blur: 2.2, offsetSec: 0.8, note: 'Slight Motion Blur' }
  ];

  for (const v of portraitVariants) {
    const blob = await renderDemoCanvas(1600, 1066, v.blur, (ctx, w, h) => {
      // 背景ボケ風グラデーション
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#1e293b');
      grad.addColorStop(1, '#334155');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // 玉ボケ
      ctx.fillStyle = 'rgba(253, 224, 71, 0.12)';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.arc(200 + i * 170, 220 + (i % 3) * 180, 75, 0, Math.PI * 2);
        ctx.fill();
      }

      // 肩・服
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.92, 310, 230, 0, 0, Math.PI * 2);
      ctx.fill();

      // 顔（肌色 YCbCr領域にしっかり入るトーン）
      ctx.fillStyle = '#eab696';
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.47, 185, 225, 0, 0, Math.PI * 2);
      ctx.fill();

      // 髪
      ctx.fillStyle = '#1f1614';
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.36, 195, Math.PI, Math.PI * 2);
      ctx.fill();

      // 目（eyeOpenに応じた開閉と瞳のシャープなハイライト）
      const eyeY = h * 0.44;
      for (const side of [-1, 1]) {
        const eyeX = w / 2 + side * 68;
        ctx.strokeStyle = '#1f1614';
        ctx.lineWidth = 6;
        // 眉
        ctx.beginPath();
        ctx.arc(eyeX, eyeY - 26, 34, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();

        if (v.eyeOpen > 0.3) {
          // 白目
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(eyeX, eyeY, 28, 17 * v.eyeOpen, 0, 0, Math.PI * 2);
          ctx.fill();
          // 瞳（黒目＋キャッチライト）
          ctx.fillStyle = '#1e1b18';
          ctx.beginPath();
          ctx.arc(eyeX, eyeY, 13 * v.eyeOpen, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(eyeX - 4, eyeY - 4, 4.5, 0, Math.PI * 2);
          ctx.fill();
          // まつ毛輪郭エッジ
          ctx.strokeStyle = '#111827';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.ellipse(eyeX, eyeY, 28, 17 * v.eyeOpen, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // 目つぶり線
          ctx.strokeStyle = '#271c19';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(eyeX, eyeY - 4, 26, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        }
      }

      // 笑顔の口元
      ctx.strokeStyle = '#be5a4a';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.54, 48, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      // フォーカス確認用の細かいディテール文字列
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`α1 II 50MP Portrait Burst - ${v.name} (${v.note})`, 42, h - 36);
    });

    const ts = baseTime + v.offsetSec * 1000;
    files.push(new File([blob], `${v.name}.JPG`, { type: 'image/jpeg', lastModified: ts }));
    // ダミーRAWファイル (.ARW)
    const rawDummy = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x53, 0x4f, 0x4e, 0x59, 0x5f, 0x52, 0x41, 0x57]);
    files.push(new File([rawDummy], `${v.name}.ARW`, { type: 'application/octet-stream', lastModified: ts }));
  }

  // 2. 料理2連写（僅差バウト！ 1枚目: 鮮やか＆ピント良好、2枚目: わずかにピント差の接戦）
  const foodVariants = [
    { name: 'DSC01004', blur: 0, satBoost: 1.0, offsetSec: 45, note: 'Appetizing Sharp' },
    { name: 'DSC01005', blur: 0.4, satBoost: 0.94, offsetSec: 47, note: 'Close Runner-up' }
  ];

  for (const v of foodVariants) {
    const blob = await renderDemoCanvas(1600, 1066, v.blur, (ctx, w, h) => {
      // 木目テーブル背景
      ctx.fillStyle = '#451a03';
      ctx.fillRect(0, 0, w, h);

      // お皿
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 360, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 12;
      ctx.stroke();

      // 料理（暖色系のパスタ・ステーキ風ディテール）
      ctx.fillStyle = '#ea580c';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 255, 0, Math.PI * 2);
      ctx.fill();

      // 具材の細かいエッジ（ピント判定用）
      for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2;
        const r = 45 + (i % 5) * 42;
        const cx = w / 2 + Math.cos(angle) * r;
        const cy = h / 2 + Math.sin(angle) * r;
        ctx.fillStyle = i % 3 === 0 ? '#16a34a' : i % 2 === 0 ? '#facc15' : '#dc2626';
        ctx.beginPath();
        ctx.arc(cx, cy, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff7ed';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`Gourmet Shot - ${v.name} (${v.note})`, 42, h - 36);
    });

    const ts = baseTime + v.offsetSec * 1000;
    files.push(new File([blob], `${v.name}.JPG`, { type: 'image/jpeg', lastModified: ts }));
    const rawDummy = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x53, 0x4f, 0x4e, 0x59, 0x5f, 0x52, 0x41, 0x57]);
    files.push(new File([rawDummy], `${v.name}.ARW`, { type: 'application/octet-stream', lastModified: ts }));
  }

  // 3. 風景2連写（1枚目: 水平バッチリ＆シャープ、2枚目: 少し傾き＆微ブレ）
  const landscapeVariants = [
    { name: 'DSC01006', blur: 0, tiltDeg: 0, offsetSec: 120, note: 'Level Horizon' },
    { name: 'DSC01007', blur: 1.5, tiltDeg: 4.5, offsetSec: 123, note: 'Tilted & Soft' }
  ];

  for (const v of landscapeVariants) {
    const blob = await renderDemoCanvas(1600, 1066, v.blur, (ctx, w, h) => {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((v.tiltDeg * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);

      // 空
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.58);
      sky.addColorStop(0, '#0284c7');
      sky.addColorStop(1, '#bae6fd');
      ctx.fillStyle = sky;
      ctx.fillRect(-100, -100, w + 200, h * 0.68);

      // 山脈と水平線
      ctx.fillStyle = '#065f46';
      ctx.beginPath();
      ctx.moveTo(-100, h * 0.58);
      ctx.lineTo(w * 0.25, h * 0.32);
      ctx.lineTo(w * 0.52, h * 0.52);
      ctx.lineTo(w * 0.78, h * 0.28);
      ctx.lineTo(w + 100, h * 0.58);
      ctx.closePath();
      ctx.fill();

      // 湖面と建物の細かいグリッド線
      ctx.fillStyle = '#0369a1';
      ctx.fillRect(-100, h * 0.58, w + 200, h * 0.55);

      ctx.strokeStyle = '#e0f2fe';
      ctx.lineWidth = 3;
      for (let y = Math.floor(h * 0.6); y < h; y += 28) {
        ctx.beginPath();
        ctx.moveTo(100, y);
        ctx.lineTo(w - 100, y);
        ctx.stroke();
      }
      ctx.restore();

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`Mountain Landscape - ${v.name} (${v.note})`, 42, h - 36);
    });

    const ts = baseTime + v.offsetSec * 1000;
    files.push(new File([blob], `${v.name}.JPG`, { type: 'image/jpeg', lastModified: ts }));
  }

  // 4. 資料・ホワイトボードメモ（単独1枚）
  const docBlob = await renderDemoCanvas(1600, 1066, 0, (ctx, w, h) => {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 4;
    ctx.strokeRect(80, 70, w - 160, h - 140);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText('BestBout Photo 撮影イベント仕様メモ', 140, 170);

    ctx.font = '28px sans-serif';
    const lines = [
      '・α1 II 50MP 高速連写の写真からベストショットを自動選出',
      '・RAW (.ARW) と JPEG を自動ペアリングして一括出力',
      '・Google Drive へは長辺 4096px (JPEG 88%) でExif維持転送',
      '・Amazon Photos / ローカルにはオリジナル画質＋RAWで保存'
    ];
    lines.forEach((line, idx) => {
      ctx.fillText(line, 150, 280 + idx * 85);
    });
  });
  files.push(
    new File([docBlob], 'DSC01008.JPG', {
      type: 'image/jpeg',
      lastModified: baseTime + 240 * 1000
    })
  );

  return files;
}

function renderDemoCanvas(
  w: number,
  h: number,
  blurPx: number,
  drawFn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): Promise<Blob> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    if (blurPx > 0) {
      ctx.filter = `blur(${blurPx}px)`;
    }
    drawFn(ctx, w, h);
    ctx.filter = 'none';
    canvas.toBlob((b) => resolve(b || new Blob()), 'image/jpeg', 0.92);
  });
}
