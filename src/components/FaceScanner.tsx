import React, { useState, useRef, useEffect } from "react";
import {
  Camera,
  CameraOff,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Scan,
  ShieldCheck,
  Zap,
  Upload,
  UserX,
  Sparkles,
  KeyRound,
  DoorOpen,
  Users,
  Timer,
  Eye,
  Send,
} from "lucide-react";
import {
  Employee,
  FaceRecognitionResult,
  ScanType,
  SmartLockState,
  DetectedFace,
} from "../types";
import { soundEffects } from "../utils/audio";
import { safeJsonFetch, compressImage } from "../utils/api";

interface FaceScannerProps {
  employees: Employee[];
  lockState: SmartLockState;
  onRecognitionComplete: (result: FaceRecognitionResult) => void;
  onTriggerManualUnlock: () => void;
}

export const FaceScanner: React.FC<FaceScannerProps> = ({
  employees,
  lockState,
  onRecognitionComplete,
  onTriggerManualUnlock,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [streamActive, setStreamActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanType, setScanType] = useState<ScanType>("ENTRY");
  const [lastResult, setLastResult] = useState<FaceRecognitionResult | null>(null);
  const [scanMode, setScanMode] = useState<"OFF" | "FAST" | "TURBO">("OFF");
  const [capturedSnapshot, setCapturedSnapshot] = useState<string | null>(null);
  const [activeFaces, setActiveFaces] = useState<DetectedFace[]>([]);
  const [lastLatencyMs, setLastLatencyMs] = useState<number>(140);

  // Initialize webcam
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "user",
          },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
          setStreamActive(true);
        }
      } else {
        setCameraError("Trình duyệt không hỗ trợ WebRTC Camera");
      }
    } catch (err: any) {
      console.warn("Camera access warning:", err);
      setCameraError(
        "Không thể truy cập camera trực tiếp. Bạn có thể sử dụng tính năng Tải Ảnh hoặc nhấn các nút Thử Nghiệm Nhanh Đa Nhân Viên bên dưới."
      );
      setStreamActive(false);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
      setStreamActive(false);
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  // Capture frame as base64 string optimized for fast AI processing
  const captureFrame = (): string | null => {
    if (!videoRef.current) return null;
    const video = videoRef.current;

    const canvas = canvasRef.current || document.createElement("canvas");
    // Optimize resolution for high-speed AI transmission
    canvas.width = 640;
    canvas.height = 480;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  };

  // Perform AI Face Recognition (Full-frame multi-face & high-speed)
  const handleScan = async (overrideBase64?: string, testEmployeeId?: string) => {
    if (isScanning) return;
    setIsScanning(true);
    const clientStartTime = Date.now();

    let imageToSend = overrideBase64;
    if (!imageToSend) {
      if (streamActive) {
        imageToSend = captureFrame() || undefined;
      }
    }

    // Fallback image if camera inactive and no override
    if (!imageToSend && employees.length > 0) {
      imageToSend = employees[0].photoUrl;
    }

    if (!imageToSend) {
      setIsScanning(false);
      return;
    }

    setCapturedSnapshot(imageToSend);

    try {
      const response = await safeJsonFetch<FaceRecognitionResult>(
        "/api/recognize-face",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: imageToSend,
            scanType,
            testEmployeeId,
          }),
        }
      );

      if (!response.ok || !response.data) {
        console.warn("Lỗi nhận diện khuôn mặt:", response.error);
        return;
      }

      const data = response.data;
      const latency = Date.now() - clientStartTime;
      setLastLatencyMs(data.processingTimeMs || latency);

      setLastResult(data);
      if (data.detectedFaces && data.detectedFaces.length > 0) {
        setActiveFaces(data.detectedFaces);
      } else {
        setActiveFaces([]);
      }

      onRecognitionComplete(data);

      if (data.recognized) {
        soundEffects.playSuccess();
      } else {
        soundEffects.playDenied();
      }
    } catch (err) {
      console.error("Lỗi gửi dữ liệu nhận diện khuôn mặt:", err);
    } finally {
      setIsScanning(false);
    }
  };

  // High-speed auto-scan loop
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (scanMode !== "OFF" && streamActive && !isScanning) {
      const intervalMs = scanMode === "TURBO" ? 1600 : 3000;
      timer = setInterval(() => {
        handleScan();
      }, intervalMs);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [scanMode, streamActive, isScanning]);

  // Handle local file upload for testing (with image compression to prevent 413 Payload Too Large)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressed = await compressImage(file, 720, 720, 0.82);
      handleScan(compressed);
    } catch (err) {
      console.error("Lỗi nén ảnh tải lên:", err);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Full-Frame Biometric Viewport & Live Scanner */}
      <div className="lg:col-span-8 space-y-4">
        {/* Main Camera Viewport Card */}
        <div className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 shadow-xl relative">
          {/* Top Camera Header Bar */}
          <div className="p-3 bg-slate-950/90 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  streamActive ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                }`}
              />
              <span className="font-mono font-bold text-slate-200">
                CAMERA TOÀN CẢNH ĐA MỤC TIÊU
              </span>
              <span className="px-2 py-0.5 rounded-md bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold flex items-center gap-1">
                <Eye className="w-3 h-3 text-indigo-400" />
                Không giới hạn ô quét
              </span>
            </div>

            {/* Entry / Exit Mode Toggle & Speed Badge */}
            <div className="flex items-center gap-2">
              {/* Speed latency pill */}
              <div className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300 font-mono text-[11px]">
                <Timer className="w-3 h-3 text-amber-400" />
                <span>Tốc độ:</span>
                <span className="text-emerald-400 font-bold">{lastLatencyMs}ms</span>
              </div>

              {/* Webhook Status pill */}
              <div
                className="hidden md:flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-950/70 border border-indigo-500/30 text-indigo-300 text-[11px] font-medium"
                title="Tự động POST webhook vào https://chat-room.eton.vn khi mở cửa"
              >
                <Send className="w-3 h-3 text-indigo-400 animate-pulse" />
                <span>Webhook Eton: Bật</span>
              </div>

              {/* Mode Toggle */}
              <div className="flex items-center bg-black/50 backdrop-blur-md rounded-lg p-0.5 border border-white/10">
                <button
                  id="btn-mode-entry"
                  onClick={() => setScanType("ENTRY")}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                    scanType === "ENTRY"
                      ? "bg-emerald-500 text-white shadow-xs"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Vào (Check-in)
                </button>
                <button
                  id="btn-mode-exit"
                  onClick={() => setScanType("EXIT")}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                    scanType === "EXIT"
                      ? "bg-blue-500 text-white shadow-xs"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Ra (Check-out)
                </button>
              </div>
            </div>
          </div>

          {/* Panoramic Biometric Viewport */}
          <div className="relative aspect-4/3 w-full bg-slate-950 flex items-center justify-center overflow-hidden">
            {/* Live Camera Video (Full Frame View) */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover transform -scale-x-100 ${
                !streamActive ? "hidden" : "block"
              }`}
            />

            {/* Hidden canvas for fast capture */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Fallback View when Camera is inactive */}
            {!streamActive && (
              <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 space-y-4 max-w-md z-10">
                <div className="w-16 h-16 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-400">
                  <CameraOff className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-white font-medium text-base mb-1">
                    Camera Chưa Sẵn Sàng
                  </h3>
                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    {cameraError ||
                      "Vui lòng cho phép quyền truy cập camera, hoặc tải ảnh lên / bấm nút thử nghiệm đa nhân viên phía dưới."}
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    <button
                      id="btn-retry-camera"
                      onClick={startCamera}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Thử Lại Camera
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Full-Frame Panoramic Scanning Guidelines */}
            <div className="absolute inset-0 pointer-events-none z-10">
              {/* Outer Viewport Corner Targets (Replaces narrow scan box) */}
              <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-indigo-400/80" />
              <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-indigo-400/80" />
              <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-indigo-400/80" />
              <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-indigo-400/80" />

              {/* Full-Width Panoramic Laser Sweep Scan Animation */}
              {isScanning && (
                <div className="absolute left-0 right-0 h-1.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_20px_#22d3ee] animate-[bounce_1.4s_infinite]" />
              )}

              {/* Top Detection Status Banner */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-black/75 backdrop-blur-md border border-white/15 text-xs font-mono text-slate-200 shadow-lg">
                {isScanning ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                    <span className="text-cyan-300 font-bold">AI ĐANG QUÉT TOÀN BỘ KHUNG HÌNH...</span>
                  </>
                ) : activeFaces.length > 0 ? (
                  <>
                    <Users className="w-3.5 h-3.5 text-emerald-400" />
                    <span>
                      Phát hiện{" "}
                      <strong className="text-emerald-400 font-bold">
                        {activeFaces.length} người
                      </strong>{" "}
                      ({activeFaces.filter((f) => f.recognized).length} nhân viên hợp lệ)
                    </span>
                  </>
                ) : (
                  <>
                    <Scan className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-slate-300">
                      Sẵn sàng nhận diện nhiều người đồng thời
                    </span>
                  </>
                )}
              </div>

              {/* Dynamic Bounding Boxes for Multiple Faces Across Entire Frame */}
              {activeFaces.map((face, index) => {
                // box2d: [ymin, xmin, ymax, xmax] normalized 0-1000
                const [ymin, xmin, ymax, xmax] = face.box2d;
                const topPct = Math.max(0, Math.min(100, ymin / 10));
                const heightPct = Math.max(10, Math.min(100 - topPct, (ymax - ymin) / 10));

                // Video is mirrored (-scale-x-100), adjust horizontal coordinates
                const leftPct = streamActive
                  ? Math.max(0, Math.min(100, (1000 - xmax) / 10))
                  : Math.max(0, Math.min(100, xmin / 10));
                const widthPct = Math.max(10, Math.min(100 - leftPct, (xmax - xmin) / 10));

                const isAuth = face.recognized;

                return (
                  <div
                    key={face.id || index}
                    className={`absolute rounded-xl border-2 transition-all duration-300 pointer-events-none ${
                      isAuth
                        ? "border-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.6)] bg-emerald-500/10"
                        : "border-rose-400 shadow-[0_0_20px_rgba(244,63,94,0.6)] bg-rose-500/10"
                    }`}
                    style={{
                      top: `${topPct}%`,
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      height: `${heightPct}%`,
                    }}
                  >
                    {/* Bounding Box Corner Reticles */}
                    <div
                      className={`absolute -top-1 -left-1 w-3.5 h-3.5 border-t-3 border-l-3 rounded-tl-sm ${
                        isAuth ? "border-emerald-300" : "border-rose-300"
                      }`}
                    />
                    <div
                      className={`absolute -top-1 -right-1 w-3.5 h-3.5 border-t-3 border-r-3 rounded-tr-sm ${
                        isAuth ? "border-emerald-300" : "border-rose-300"
                      }`}
                    />
                    <div
                      className={`absolute -bottom-1 -left-1 w-3.5 h-3.5 border-b-3 border-l-3 rounded-bl-sm ${
                        isAuth ? "border-emerald-300" : "border-rose-300"
                      }`}
                    />
                    <div
                      className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 border-b-3 border-r-3 rounded-br-sm ${
                        isAuth ? "border-emerald-300" : "border-rose-300"
                      }`}
                    />

                    {/* Floating Info Tag on Top of Face */}
                    <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap z-20">
                      <span
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold font-mono tracking-wide border shadow-md flex items-center gap-1.5 ${
                          isAuth
                            ? "bg-emerald-950/90 text-emerald-300 border-emerald-500/60"
                            : "bg-rose-950/90 text-rose-300 border-rose-500/60"
                        }`}
                      >
                        {isAuth ? (
                          <>
                            <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                            <span>
                              {face.employeeName || "Nhân viên"} ({face.confidence}%)
                            </span>
                          </>
                        ) : (
                          <>
                            <UserX className="w-3 h-3 text-rose-400 shrink-0" />
                            <span>Chưa đăng ký</span>
                          </>
                        )}
                      </span>
                    </div>

                    {/* Bottom Department / Code Tag */}
                    {isAuth && face.employeeCode && (
                      <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap z-20">
                        <span className="px-2 py-0.5 rounded bg-slate-900/90 text-[10px] font-mono text-slate-300 border border-slate-700">
                          {face.employeeCode} • Sống: {face.livenessScore}%
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Smart Lock Open Notification Pill at Bottom of Viewport */}
            {!lockState.isLocked && (
              <div className="absolute bottom-4 left-4 right-4 z-20 bg-emerald-600/95 backdrop-blur-md text-white px-4 py-2.5 rounded-xl border border-emerald-400/40 shadow-xl flex items-center justify-between animate-in fade-in slide-in-from-bottom duration-300">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/20 flex items-center justify-center">
                    <DoorOpen className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-emerald-100">
                      Khóa Cửa Đã Mở Tự Động Qua API
                    </p>
                    <p className="text-sm font-bold truncate max-w-xs sm:max-w-md">
                      {lockState.lastActionBy || "Nhân viên hợp lệ"}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-emerald-100 block">Tự khóa sau</span>
                  <span className="font-mono font-bold text-lg leading-tight">
                    {lockState.remainingRelockSeconds}s
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Scanner Bottom Action Controls */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {/* Primary Scan Button */}
              <button
                id="btn-trigger-scan"
                disabled={isScanning}
                onClick={() => handleScan()}
                className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-md shadow-indigo-500/20 flex items-center gap-2 transition active:scale-95 cursor-pointer"
              >
                {isScanning ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Đang Quét AI Toàn Cảnh...</span>
                  </>
                ) : (
                  <>
                    <Scan className="w-4 h-4" />
                    <span>Quét Toàn Khung Hình</span>
                  </>
                )}
              </button>

              {/* Upload Photo Button */}
              <label
                id="label-upload-photo"
                className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-sm font-medium border border-slate-700 flex items-center gap-2 cursor-pointer transition"
              >
                <Upload className="w-4 h-4" />
                <span className="hidden sm:inline">Tải Ảnh</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              {/* Speed Mode Selector (Tăng tốc độ nhận diện) */}
              <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-1 text-xs">
                <button
                  id="btn-speed-off"
                  onClick={() => setScanMode("OFF")}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                    scanMode === "OFF"
                      ? "bg-slate-800 text-white font-semibold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Thủ Công
                </button>
                <button
                  id="btn-speed-fast"
                  onClick={() => setScanMode("FAST")}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1 cursor-pointer ${
                    scanMode === "FAST"
                      ? "bg-blue-600 text-white font-semibold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Zap className="w-3 h-3" /> Nhanh (3s)
                </button>
                <button
                  id="btn-speed-turbo"
                  onClick={() => setScanMode("TURBO")}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1 cursor-pointer ${
                    scanMode === "TURBO"
                      ? "bg-amber-500 text-slate-950 font-bold shadow-sm"
                      : "text-slate-400 hover:text-amber-400"
                  }`}
                >
                  <Zap className="w-3 h-3 fill-current" /> Siêu Tốc (1.5s)
                </button>
              </div>
            </div>

            {/* Manual Emergency Unlock Trigger */}
            <button
              id="btn-manual-unlock"
              onClick={onTriggerManualUnlock}
              className="px-3.5 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white rounded-xl text-xs font-medium border border-slate-800 flex items-center gap-2 transition cursor-pointer"
              title="Kích hoạt lệnh mở khóa trực tiếp qua API Smart Lock"
            >
              <KeyRound className="w-3.5 h-3.5 text-amber-400" />
              <span>Mở Khóa API Thủ Công</span>
            </button>
          </div>
        </div>

        {/* Multi-Person Quick Simulation Shortcuts */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              <h4 className="text-sm font-bold text-slate-800">
                Thử Nghiệm Nhận Diện Đa Nhân Viên (1 Chạm)
              </h4>
            </div>
            <span className="text-xs text-slate-500">
              Kiểm tra nhận diện nhiều người đồng thời trong khung hình
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {/* Multi-Face Test 1: 2 Employees Together */}
            <button
              id="btn-test-multi-employees"
              disabled={isScanning}
              onClick={() =>
                handleScan(
                  "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=640&auto=format&fit=crop&q=80",
                  "MULTI_EMPLOYEES"
                )
              }
              className="flex items-center gap-2.5 p-2.5 rounded-xl border-2 border-indigo-300 bg-indigo-50/60 hover:bg-indigo-100/70 hover:border-indigo-500 transition text-left group cursor-pointer"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center shrink-0">
                <Users className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-indigo-950 truncate">
                  Nhóm 2 Nhân Viên
                </p>
                <p className="text-[11px] text-indigo-700 truncate">
                  Minh &amp; Phương cùng vào
                </p>
                <span className="inline-block px-1.5 py-0.2 rounded text-[10px] bg-emerald-100 text-emerald-800 font-bold">
                  Đồng thời mở cửa
                </span>
              </div>
            </button>

            {/* Multi-Face Test 2: 1 Registered Employee + 1 Stranger */}
            <button
              id="btn-test-multi-mixed"
              disabled={isScanning}
              onClick={() =>
                handleScan(
                  "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=640&auto=format&fit=crop&q=80",
                  "MULTI_MIXED"
                )
              }
              className="flex items-center gap-2.5 p-2.5 rounded-xl border-2 border-amber-300 bg-amber-50/50 hover:bg-amber-100/60 hover:border-amber-500 transition text-left group cursor-pointer"
            >
              <div className="w-10 h-10 rounded-lg bg-amber-600 text-white flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-amber-950 truncate">
                  Nhân Viên + Người Lạ
                </p>
                <p className="text-[11px] text-amber-700 truncate">
                  1 Hợp lệ &amp; 1 Khách lạ
                </p>
                <span className="inline-block px-1.5 py-0.2 rounded text-[10px] bg-amber-200 text-amber-900 font-bold">
                  Phân loại riêng
                </span>
              </div>
            </button>

            {/* Single Employee Quick Test */}
            {employees.length > 0 && (
              <button
                id={`btn-test-employee-${employees[0].id}`}
                disabled={isScanning}
                onClick={() => handleScan(employees[0].photoUrl, employees[0].id)}
                className="flex items-center gap-2.5 p-2.5 rounded-xl border border-slate-200 hover:border-indigo-400 hover:bg-slate-50 transition text-left group cursor-pointer"
              >
                <img
                  src={employees[0].photoUrl}
                  alt={employees[0].name}
                  className="w-10 h-10 rounded-lg object-cover border border-slate-200 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-800 truncate">
                    {employees[0].name}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500">
                    {employees[0].employeeCode}
                  </p>
                  <span className="inline-block px-1.5 py-0.2 rounded text-[10px] bg-slate-100 text-slate-700 font-medium">
                    1 Nhân viên
                  </span>
                </div>
              </button>
            )}

            {/* Test Unknown Stranger */}
            <button
              id="btn-test-stranger"
              disabled={isScanning}
              onClick={() =>
                handleScan(
                  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&auto=format&fit=crop&q=80",
                  "UNKNOWN_VISITOR"
                )
              }
              className="flex items-center gap-2.5 p-2.5 rounded-xl border border-rose-200 hover:border-rose-400 hover:bg-rose-50/50 transition text-left group bg-rose-50/30 cursor-pointer"
            >
              <div className="w-10 h-10 rounded-lg bg-rose-100 border border-rose-200 flex items-center justify-center text-rose-600 font-bold text-xs shrink-0">
                <UserX className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-rose-900 truncate">
                  Người Lạ Chưa Đăng Ký
                </p>
                <p className="text-[11px] text-rose-600">Từ chối mở chốt</p>
                <span className="inline-block px-1.5 py-0.2 rounded text-[10px] bg-rose-100 text-rose-800 font-medium">
                  Báo động
                </span>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Right Column: AI Analysis Result & Multi-Person Telemetry */}
      <div className="lg:col-span-4 space-y-4">
        {/* Latest Scan Result Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600" />
              <h3 className="text-sm font-bold text-slate-900">
                Kết Quả Đối Soát Đa Mục Tiêu
              </h3>
            </div>
            {lastResult && (
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                  lastResult.recognized
                    ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                    : "bg-rose-100 text-rose-800 border border-rose-200"
                }`}
              >
                {lastResult.recognized ? "ĐÃ MỞ KHÓA" : "TỪ CHỐI"}
              </span>
            )}
          </div>

          {lastResult ? (
            <div className="space-y-4">
              {/* Snapshot with Face Count Badge */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                {capturedSnapshot && (
                  <div className="relative shrink-0">
                    <img
                      src={capturedSnapshot}
                      alt="Captured Face"
                      className="w-16 h-16 rounded-lg object-cover border border-slate-300"
                    />
                    <span className="absolute -bottom-1.5 -right-1.5 bg-indigo-600 text-white p-0.5 rounded-full">
                      <Scan className="w-3 h-3" />
                    </span>
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800 font-bold text-[11px]">
                      {lastResult.totalFacesDetected || activeFaces.length || 1} khuôn mặt
                    </span>
                    <span className="text-[11px] font-mono text-slate-500">
                      ⏱️ {lastLatencyMs}ms
                    </span>
                  </div>
                  <p className="text-xs font-bold text-slate-800 line-clamp-2">
                    {lastResult.message}
                  </p>
                </div>
              </div>

              {/* Multi-Face Itemized Breakdown List */}
              {lastResult.detectedFaces && lastResult.detectedFaces.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Chi Tiết Từng Người Trong Khung Hình
                  </h4>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {lastResult.detectedFaces.map((f, i) => (
                      <div
                        key={f.id || i}
                        className={`p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                          f.recognized
                            ? "bg-emerald-50/80 border-emerald-200 text-emerald-950"
                            : "bg-rose-50/80 border-rose-200 text-rose-950"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {f.recognized ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                          ) : (
                            <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <p className="font-bold truncate">
                              {f.employeeName || "Khách chưa đăng ký"}
                            </p>
                            <p className="text-[11px] opacity-75">
                              {f.employeeCode ? `${f.employeeCode} • ` : ""}
                              Khớp: {f.confidence}%
                            </p>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                            f.recognized
                              ? "bg-emerald-200 text-emerald-900"
                              : "bg-rose-200 text-rose-900"
                          }`}
                        >
                          {f.recognized ? "Hợp Lệ" : "Từ Chối"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Confidence & Liveness Gauges */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-[11px] text-slate-500 font-medium block mb-1">
                    Độ Trùng Khớp AI
                  </span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-bold font-mono text-slate-900">
                      {lastResult.confidence}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        lastResult.confidence >= 70 ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                      style={{ width: `${Math.min(lastResult.confidence, 100)}%` }}
                    />
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-[11px] text-slate-500 font-medium block mb-1">
                    Độ Sống Thật (Liveness)
                  </span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-bold font-mono text-slate-900">
                      {lastResult.livenessScore}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full"
                      style={{ width: `${Math.min(lastResult.livenessScore, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-slate-400">
              <Scan className="w-10 h-10 mx-auto mb-2 opacity-40 animate-pulse" />
              <p className="text-xs">
                Chưa có dữ liệu quét. Nhấn &quot;Quét Toàn Khung Hình&quot; hoặc chọn mẫu thử nghiệm đa nhân viên.
              </p>
            </div>
          )}
        </div>

        {/* API Telemetry & Smart Lock Quick Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Trạng Thái Kết Nối Khóa Cửa
            </h4>
            <span
              className={`w-2 h-2 rounded-full ${
                lockState.status === "ONLINE" ? "bg-emerald-500" : "bg-rose-500"
              }`}
            />
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Cửa Kiểm Soát:</span>
              <span className="font-medium text-slate-800">{lockState.doorName}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Giao Thức Khóa:</span>
              <span className="font-mono text-indigo-600 font-semibold">REST API / Zigbee 3.0</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Thời Gian Xử Lý:</span>
              <span className="font-mono text-emerald-600 font-bold">~{lastLatencyMs}ms (Siêu tốc)</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Pin Khóa Thông Minh:</span>
              <span className="font-medium text-emerald-600">{lockState.batteryLevel}%</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-500">Lần Mở Gần Nhất:</span>
              <span className="text-slate-700 truncate max-w-[170px]">
                {lockState.lastActionBy}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
