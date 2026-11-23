import { Zip, ZipPassThrough } from 'fflate';
import { PhotoGroup, PhotoItem } from '../types';
import { copyAndProcessJpegExif } from './exifUtils';
import { sanitizeFileName, sanitizeFolderName } from './securityUtils';

export interface ProgressCallback {
  (info: { stage: string; current: number; total: number; fileName?: string }): void;
}

export function getSelectedPhotos(groups: PhotoGroup[]): PhotoItem[] {
  const result: PhotoItem[] = [];
  for (const g of groups) {
    if (g.excluded) continue;
    const selectedSet = new Set(g.selectedIds);
    for (const p of g.photos) {
      if (selectedSet.has(p.id)) {
        result.push(p);
      }
    }
  }
  return result;
}

export function getExcludedPhotos(groups: PhotoGroup[]): PhotoItem[] {
  const result: PhotoItem[] = [];
  for (const g of groups) {
    if (g.excluded) {
      result.push(...g.photos);
      continue;
    }
    const selectedSet = new Set(g.selectedIds);
    for (const p of g.photos) {
      if (!selectedSet.has(p.id)) {
        result.push(p);
      }
    }
  }
  return result;
}

export async function preparePhotoBlob(
  photo: PhotoItem,
  options: {
    maxDimension: number;
    jpegQuality: number;
    stripGps: boolean;
  }
): Promise<Blob> {
  const isJpeg =
    photo.file.type === 'image/jpeg' ||
    photo.fileName.toLowerCase().endsWith('.jpg') ||
    photo.fileName.toLowerCase().endsWith('.jpeg');

  if (options.maxDimension <= 0) {
    if (options.stripGps && isJpeg) {
      return copyAndProcessJpegExif(photo.file, photo.file, {
        stripGps: true,
        resetOrientation: false
      });
    }
    return photo.file;
  }

  let width = 0;
  let height = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(photo.file);
    width = bitmap.width;
    height = bitmap.height;

    if (Math.max(width, height) <= options.maxDimension && !options.stripGps && isJpeg) {
      bitmap.close();
      return photo.file;
    }

    const scale = Math.min(1, options.maxDimension / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();
  } else {
    const url = URL.createObjectURL(photo.file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    URL.revokeObjectURL(url);
    width = img.naturalWidth || img.width;
    height = img.naturalHeight || img.height;
    const scale = Math.min(1, options.maxDimension / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.drawImage(img, 0, 0, targetW, targetH);
  }

  const resizedBlob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b || photo.file), 'image/jpeg', options.jpegQuality);
  });

  canvas.width = 0;
  canvas.height = 0;

  if (isJpeg) {
    return copyAndProcessJpegExif(photo.file, resizedBlob, {
      stripGps: options.stripGps,
      resetOrientation: true
    });
  }

  return resizedBlob;
}

export async function saveToLocalFolderDirect(
  photos: PhotoItem[],
  folderName: string,
  options: { includeRaw: boolean; stripGps: boolean },
  onProgress?: ProgressCallback
): Promise<boolean> {
  const win = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
  };

  if (typeof win.showDirectoryPicker !== 'function') {
    return false;
  }

  const rootDirHandle = await win.showDirectoryPicker({ mode: 'readwrite' });
  const safeFolderName = sanitizeFolderName(folderName);
  const eventDirHandle = await rootDirHandle.getDirectoryHandle(safeFolderName, { create: true });

  const totalSteps = photos.reduce((acc, p) => acc + 1 + (options.includeRaw && p.rawFile ? 1 : 0), 0);
  let currentStep = 0;

  for (const photo of photos) {
    currentStep++;
    const safeImgName = sanitizeFileName(photo.fileName);
    onProgress?.({
      stage: 'ローカルフォルダへ保存中',
      current: currentStep,
      total: totalSteps,
      fileName: safeImgName
    });

    const outBlob = await preparePhotoBlob(photo, {
      maxDimension: 0,
      jpegQuality: 1,
      stripGps: options.stripGps
    });

    const fileHandle = await eventDirHandle.getFileHandle(safeImgName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(outBlob);
    await writable.close();

    if (options.includeRaw && photo.rawFile && photo.rawFileName) {
      currentStep++;
      const safeRawName = sanitizeFileName(photo.rawFileName, 'raw.arw');
      onProgress?.({
        stage: 'RAWファイルを保存中',
        current: currentStep,
        total: totalSteps,
        fileName: safeRawName
      });
      const rawHandle = await eventDirHandle.getFileHandle(safeRawName, { create: true });
      const rawWritable = await rawHandle.createWritable();
      await rawWritable.write(photo.rawFile);
      await rawWritable.close();
    }
  }

  return true;
}

export async function downloadAsZip(
  photos: PhotoItem[],
  folderName: string,
  options: { includeRaw: boolean; stripGps: boolean; zipSuffix?: string },
  onProgress?: ProgressCallback
): Promise<void> {
  const safeFolder = sanitizeFolderName(folderName);
  const chunks: Uint8Array[] = [];

  const zip = new Zip((err, data, final) => {
    if (err) throw err;
    chunks.push(data);
    if (final) {
      const zipBlob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      const zipFileName = `${safeFolder}${options.zipSuffix || ''}.zip`;
      triggerBlobDownload(zipBlob, zipFileName);
    }
  });

  const totalSteps = photos.reduce((acc, p) => acc + 1 + (options.includeRaw && p.rawFile ? 1 : 0), 0);
  let currentStep = 0;
  const usedEntryNames = new Set<string>();

  for (const photo of photos) {
    currentStep++;
    const safeImgName = deduplicateFileName(sanitizeFileName(photo.fileName), usedEntryNames);
    onProgress?.({
      stage: 'ZIP生成中',
      current: currentStep,
      total: totalSteps,
      fileName: safeImgName
    });

    const outBlob = await preparePhotoBlob(photo, {
      maxDimension: 0,
      jpegQuality: 1,
      stripGps: options.stripGps
    });
    const bytes = new Uint8Array(await outBlob.arrayBuffer());
    const entry = new ZipPassThrough(`${safeFolder}/${safeImgName}`);
    zip.add(entry);
    entry.push(bytes, true);

    if (options.includeRaw && photo.rawFile && photo.rawFileName) {
      currentStep++;
      const safeRawName = deduplicateFileName(
        sanitizeFileName(photo.rawFileName, 'raw.arw'),
        usedEntryNames
      );
      onProgress?.({
        stage: 'RAWファイルをZIPに追加中',
        current: currentStep,
        total: totalSteps,
        fileName: safeRawName
      });
      const rawBytes = new Uint8Array(await photo.rawFile.arrayBuffer());
      const rawEntry = new ZipPassThrough(`${safeFolder}/${safeRawName}`);
      zip.add(rawEntry);
      rawEntry.push(rawBytes, true);
    }
  }

  zip.end();
}

function deduplicateFileName(name: string, used: Set<string>): string {
  let candidate = name;
  let counter = 1;
  while (used.has(candidate.toLowerCase())) {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
      candidate = `${name.slice(0, dotIdx)}_${counter}${name.slice(dotIdx)}`;
    } else {
      candidate = `${name}_${counter}`;
    }
    counter++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function shareViaWebShareApi(
  photos: PhotoItem[],
  folderName: string,
  options: { includeRaw: boolean; stripGps: boolean },
  onProgress?: ProgressCallback
): Promise<boolean> {
  if (!navigator.share || !navigator.canShare) {
    return false;
  }

  const shareFiles: File[] = [];
  let idx = 0;
  for (const photo of photos) {
    idx++;
    const safeImgName = sanitizeFileName(photo.fileName);
    onProgress?.({
      stage: '共有用ファイルを準備中',
      current: idx,
      total: photos.length,
      fileName: safeImgName
    });

    const blob = await preparePhotoBlob(photo, {
      maxDimension: 0,
      jpegQuality: 1,
      stripGps: options.stripGps
    });
    shareFiles.push(new File([blob], safeImgName, { type: photo.file.type || 'image/jpeg' }));

    if (options.includeRaw && photo.rawFile && photo.rawFileName) {
      shareFiles.push(photo.rawFile);
    }
  }

  if (!navigator.canShare({ files: shareFiles })) {
    return false;
  }

  await navigator.share({
    title: sanitizeFolderName(folderName),
    text: `${sanitizeFolderName(folderName)} (${shareFiles.length}ファイル)`,
    files: shareFiles
  });
  return true;
}

export function requestGoogleDriveAccessToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const g = (window as unknown as {
      google?: {
        accounts?: {
          oauth2?: {
            initTokenClient: (config: {
              client_id: string;
              scope: string;
              callback: (resp: { access_token?: string; error?: string }) => void;
              error_callback?: (err: { message?: string }) => void;
            }) => { requestAccessToken: () => void };
          };
        };
      };
    }).google;

    if (!g?.accounts?.oauth2) {
      reject(new Error('Google認証スクリプトが読み込まれていません。通信環境を確認してください。'));
      return;
    }

    const tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(`Google認証エラー: ${resp.error || 'トークン取得失敗'}`));
          return;
        }
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        reject(new Error(`Google認証がキャンセルされました (${err?.message || ''})`));
      }
    });

    tokenClient.requestAccessToken();
  });
}

export async function uploadToGoogleDrive(
  photos: PhotoItem[],
  folderName: string,
  options: {
    accessToken: string;
    parentFolderId?: string;
    maxDimension: number;
    jpegQuality: number;
    includeRaw: boolean;
    stripGps: boolean;
  },
  onProgress?: ProgressCallback
): Promise<{ folderId: string; uploadedCount: number }> {
  const safeFolderName = sanitizeFolderName(folderName);

  onProgress?.({
    stage: 'Google Drive にフォルダを作成中...',
    current: 0,
    total: photos.length
  });

  const folderMeta: Record<string, unknown> = {
    name: safeFolderName,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (options.parentFolderId && options.parentFolderId.trim()) {
    folderMeta.parents = [options.parentFolderId.trim()];
  }

  const folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(folderMeta)
  });

  if (!folderRes.ok) {
    const errText = await folderRes.text();
    throw new Error(`Google Drive フォルダ作成失敗 (${folderRes.status}): ${errText.slice(0, 180)}`);
  }

  const folderData = await folderRes.json();
  const targetFolderId: string = folderData.id;

  const totalSteps = photos.reduce((acc, p) => acc + 1 + (options.includeRaw && p.rawFile ? 1 : 0), 0);
  let currentStep = 0;

  for (const photo of photos) {
    currentStep++;
    const safeImgName = sanitizeFileName(photo.fileName);
    onProgress?.({
      stage: 'Google Drive へアップロード中',
      current: currentStep,
      total: totalSteps,
      fileName: safeImgName
    });

    const outBlob = await preparePhotoBlob(photo, {
      maxDimension: options.maxDimension,
      jpegQuality: options.jpegQuality,
      stripGps: options.stripGps
    });

    await uploadSingleFileToDrive(
      options.accessToken,
      targetFolderId,
      safeImgName,
      outBlob
    );

    if (options.includeRaw && photo.rawFile && photo.rawFileName) {
      currentStep++;
      const safeRawName = sanitizeFileName(photo.rawFileName, 'raw.arw');
      onProgress?.({
        stage: 'RAWファイルをアップロード中',
        current: currentStep,
        total: totalSteps,
        fileName: safeRawName
      });

      await uploadSingleFileToDrive(
        options.accessToken,
        targetFolderId,
        safeRawName,
        photo.rawFile
      );
    }
  }

  return { folderId: targetFolderId, uploadedCount: currentStep };
}

async function uploadSingleFileToDrive(
  accessToken: string,
  parentId: string,
  fileName: string,
  blob: Blob
): Promise<void> {
  const metadata = {
    name: fileName,
    parents: [parentId]
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: form
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`"${fileName}" のアップロード失敗 (${res.status}): ${errText.slice(0, 180)}`);
  }
}

export function downloadExcludedFilesList(groups: PhotoGroup[], folderName: string): void {
  const excludedPhotos = getExcludedPhotos(groups);
  const safeFolder = sanitizeFolderName(folderName);
  const lines: string[] = [
    `# BestBout Photo 不採用ファイル一覧 - ${safeFolder}`,
    `# 生成日時: ${new Date().toLocaleString('ja-JP')}`,
    `# 枚数: ${excludedPhotos.length} 枚`,
    ''
  ];

  for (const p of excludedPhotos) {
    lines.push(sanitizeFileName(p.fileName));
    if (p.rawFileName) {
      lines.push(sanitizeFileName(p.rawFileName));
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  triggerBlobDownload(blob, `excluded_files_${safeFolder}.txt`);
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFileName(fileName, 'download.zip');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
