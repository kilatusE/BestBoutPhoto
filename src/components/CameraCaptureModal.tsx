import React, { useEffect, useRef, useState } from 'react';
import { Camera, X, Zap, Check, RefreshCw } from 'lucide-react';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCaptureFiles: (files: File[]) => void;
}

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  onCaptureFiles
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [capturedFiles, setCapturedFiles] = useState<File[]>([]);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isBursting, setIsBursting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      stopStream();
      return;
    }
    startCamera(facingMode);
    return () => stopStream();
  }, [isOpen, facingMode]);

  const startCamera = async (mode: 'environment' | 'user') => {
    stopStream();
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `カメラにアクセスできませんでした: ${err.message}`
          : 'カメラの起動に失敗しました。ブラウザのカメラ権限を確認してください。'
      );
    }
  };

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const captureSingleFrame = async (seqIndex?: number): Promise<File | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
    );
    if (!blob) return null;

    const now = Date.now();
    const suffix = seqIndex !== undefined ? `_${seqIndex}` : '';
    const fileName = `CAM_${now}${suffix}.JPG`;
    return new File([blob], fileName, { type: 'image/jpeg', lastModified: now });
  };

  const handleSingleShot = async () => {
    const file = await captureSingleFrame();
    if (file) {
      setCapturedFiles((prev) => [...prev, file]);
    }
  };

  const handleBurstShot = async () => {
    if (isBursting) return;
    setIsBursting(true);
    const newFiles: File[] = [];
    for (let i = 1; i <= 4; i++) {
      const f = await captureSingleFrame(i);
      if (f) newFiles.push(f);
      await new Promise((r) => setTimeout(r, 220));
    }
    setCapturedFiles((prev) => [...prev, ...newFiles]);
    setIsBursting(false);
  };

  const handleComplete = () => {
    if (capturedFiles.length > 0) {
      onCaptureFiles(capturedFiles);
      setCapturedFiles([]);
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-3">
      <div className="relative w-full max-w-2xl rounded-2xl bg-[#181B20] border border-gray-700/70 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2 text-white font-semibold">
            <Camera className="w-5 h-5 text-indigo-400" />
            <span>アプリ内カメラ撮影（単写 / 4連写バウト用）</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative bg-black aspect-video flex items-center justify-center overflow-hidden">
          {errorMsg ? (
            <div className="text-center p-6 text-rose-400 text-sm">{errorMsg}</div>
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
            />
          )}

          {isBursting && (
            <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-amber-500 text-black font-bold text-xs animate-pulse flex items-center gap-1">
              <Zap className="w-3.5 h-3.5" />
              高速4連写中...
            </div>
          )}

          <button
            onClick={() => setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'))}
            className="absolute top-3 right-3 px-3 py-1.5 rounded-lg bg-black/60 hover:bg-black/80 text-white text-xs flex items-center gap-1.5 border border-white/15"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            カメラ切替
          </button>
        </div>

        <div className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#12151A]">
          <div className="text-sm text-gray-300">
            撮影済み: <span className="font-bold text-indigo-400">{capturedFiles.length}</span> 枚
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleSingleShot}
              disabled={Boolean(errorMsg) || isBursting}
              className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white font-medium text-sm flex items-center gap-1.5 border border-gray-600"
            >
              <Camera className="w-4 h-4" />
              1枚撮影
            </button>

            <button
              onClick={handleBurstShot}
              disabled={Boolean(errorMsg) || isBursting}
              className="px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 font-semibold text-sm flex items-center gap-1.5 border border-amber-500/40"
            >
              <Zap className="w-4 h-4" />
              4連写撮影
            </button>

            <button
              onClick={handleComplete}
              disabled={capturedFiles.length === 0}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold text-sm flex items-center gap-1.5 shadow-lg shadow-indigo-600/30"
            >
              <Check className="w-4 h-4" />
              取り込んで解析 ({capturedFiles.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
