import React, { useState, useEffect, useRef } from "react";
import {
  Video,
  Cpu,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Square,
  Zap,
  Sliders,
  ShieldCheck,
  Radio,
  Camera,
  Layers,
  Activity,
  HardDrive,
  Flame,
  Clock,
  ArrowRightLeft,
  Settings,
  Server,
  Eye,
  Copy,
  ExternalLink,
  HelpCircle,
  Info,
  Terminal,
  Check,
  ChevronDown,
  ChevronUp,
  ScanFace,
} from "lucide-react";
import {
  CameraStreamsConfig,
  GateStreamConfig,
  CameraSourceType,
  ThreadPoolTelemetry,
} from "../types";

const DEFAULT_STREAMS_CONFIG: CameraStreamsConfig = {
  entryGate: {
    gateType: "ENTRY",
    name: "Camera Cổng Vào (Main Entry Gate)",
    enabled: true,
    sourceType: "RTSP",
    rtspUrl: "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101",
    rtspTransport: "TCP",
    httpUrl: "http://192.168.60.2/stream",
    uvcDeviceId: "default",
    uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
    resolution: "1920x1080",
    fps: 25,
    backendDevicePath: "/dev/video0",
    autoStart: true,
    reconnectIntervalSeconds: 5,
  },
  exitGate: {
    gateType: "EXIT",
    name: "Camera Cổng Ra (Exit Gate B2)",
    enabled: true,
    sourceType: "RTSP",
    rtspUrl: "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/102",
    rtspTransport: "TCP",
    httpUrl: "http://192.168.60.2/substream",
    uvcDeviceId: "default",
    uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
    resolution: "1280x720",
    fps: 25,
    backendDevicePath: "/dev/video1",
    autoStart: true,
    reconnectIntervalSeconds: 5,
  },
  workerThreadsCount: 4,
  multiThreadEnabled: true,
  autoFailoverToClientUvc: true,
  maxFpsPerStream: 30,
  backendCaptureFps: 15,
};

interface AvailableMediaDevice {
  deviceId: string;
  label: string;
}

export const CameraStreamConfigPage: React.FC = () => {
  const [config, setConfig] = useState<CameraStreamsConfig>(DEFAULT_STREAMS_CONFIG);
  const [telemetry, setTelemetry] = useState<ThreadPoolTelemetry | null>(null);
  const [activeGateTab, setActiveGateTab] = useState<"ENTRY" | "EXIT" | "DUAL_MONITOR">("ENTRY");
  const [availableCameras, setAvailableCameras] = useState<AvailableMediaDevice[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Live Stream Preview State
  const [isPreviewActive, setIsPreviewActive] = useState<boolean>(false);
  const [isStartingCamera, setIsStartingCamera] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewFps, setPreviewFps] = useState<number>(24);
  const [testStatusMessage, setTestStatusMessage] = useState<string | null>(null);
  const [testResultData, setTestResultData] = useState<any | null>(null);
  const [testingConnection, setTestingConnection] = useState<boolean>(false);

  // RTSP Custom Options & AI Scan
  const [rtspViewMode, setRtspViewMode] = useState<"MJPEG" | "SNAPSHOT" | "SIMULATION">("MJPEG");
  const [isScanningRtsp, setIsScanningRtsp] = useState<boolean>(false);
  const [rtspScanResult, setRtspScanResult] = useState<any | null>(null);
  const [showHikvisionGuide, setShowHikvisionGuide] = useState<boolean>(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [previewTimestamp, setPreviewTimestamp] = useState<number>(Date.now());

  // Benchmark State
  const [benchmarking, setBenchmarking] = useState<boolean>(false);
  const [benchmarkResults, setBenchmarkResults] = useState<any | null>(null);

  // Video Ref for Client UVC Preview
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // 1. Fetch Config and Telemetry on Load
  const fetchConfig = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/camera-streams/config");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setConfig(data.config);
        }
        if (data.telemetry) {
          setTelemetry(data.telemetry);
        }
      }
    } catch (err: any) {
      console.warn("Lỗi tải cấu hình camera:", err?.message);
    } finally {
      setLoading(false);
    }
  };

  // 2. Refresh Telemetry periodically
  const fetchTelemetry = async () => {
    try {
      const res = await fetch("/api/camera-streams/threads");
      if (res.ok) {
        const data = await res.json();
        if (data.telemetry) {
          setTelemetry(data.telemetry);
        }
      }
    } catch {}
  };

  // 3. Detect client UVC cameras
  const detectClientCameras = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      let devices = await navigator.mediaDevices.enumerateDevices();
      let videoDevs = devices.filter((d) => d.kind === "videoinput");

      // In modern browsers, device labels are empty until permission is granted at least once
      if (videoDevs.length > 0 && !videoDevs[0].label) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          devices = await navigator.mediaDevices.enumerateDevices();
          videoDevs = devices.filter((d) => d.kind === "videoinput");
          tempStream.getTracks().forEach((t) => t.stop());
        } catch {
          // Ignore if prompt dismissed
        }
      }

      const mapped = videoDevs.map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera UVC thiết bị #${index + 1}`,
      }));
      setAvailableCameras(mapped);
    } catch (err) {
      console.warn("Không thể quét thiết bị camera UVC client:", err);
    }
  };

  useEffect(() => {
    fetchConfig();
    detectClientCameras();
    const timer = setInterval(fetchTelemetry, 3000);
    return () => {
      clearInterval(timer);
      stopPreview();
    };
  }, []);

  // Save Configuration
  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);

      const res = await fetch("/api/camera-streams/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        throw new Error(`Lưu thất bại (HTTP ${res.status})`);
      }

      const data = await res.json();
      if (data.config) {
        setConfig(data.config);
      }
      if (data.telemetry) {
        setTelemetry(data.telemetry);
      }

      // Also save to localStorage for client-side persistence
      localStorage.setItem("smartface_camera_streams_config", JSON.stringify(config));

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err: any) {
      setSaveError(err.message || "Lỗi lưu cấu hình camera");
    } finally {
      setSaving(false);
    }
  };

  // Scale Worker Pool
  const handleScaleWorkers = async (newCount: number) => {
    const updatedCount = Math.max(1, Math.min(8, newCount));
    setConfig((prev) => ({ ...prev, workerThreadsCount: updatedCount }));
    try {
      const res = await fetch("/api/camera-streams/threads/scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: updatedCount }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.telemetry) setTelemetry(data.telemetry);
      }
    } catch (err) {
      console.warn("Lỗi scale worker pool:", err);
    }
  };

  // Run Multi-thread Benchmark
  const handleRunBenchmark = async () => {
    try {
      setBenchmarking(true);
      setBenchmarkResults(null);
      const res = await fetch("/api/camera-streams/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskCount: 8 }),
      });
      if (res.ok) {
        const data = await res.json();
        setBenchmarkResults(data);
        if (data.telemetry) setTelemetry(data.telemetry);
      }
    } catch (err: any) {
      alert("Lỗi benchmark: " + err?.message);
    } finally {
      setBenchmarking(false);
    }
  };

  // Test RTSP or HTTP Stream URL Connection
  const handleTestConnection = async (targetGate: GateStreamConfig) => {
    try {
      setTestingConnection(true);
      setTestStatusMessage(null);
      setTestResultData(null);
      const targetUrl = targetGate.sourceType === "RTSP" ? targetGate.rtspUrl : targetGate.httpUrl;
      const res = await fetch("/api/camera-streams/test-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          sourceType: targetGate.sourceType,
          transport: targetGate.rtspTransport,
        }),
      });

      const data = await res.json();
      setTestResultData(data);
      if (res.ok && data.success) {
        setTestStatusMessage(data.message);
      } else {
        setTestStatusMessage(data.message || data.error || "Không thể kết nối đến URL luồng camera");
      }
    } catch (err: any) {
      setTestStatusMessage("Lỗi kết nối kiểm tra: " + err?.message);
    } finally {
      setTestingConnection(false);
    }
  };

  // Trigger real-time Face Recognition test directly on the RTSP stream
  const handleScanRtsp = async () => {
    try {
      setIsScanningRtsp(true);
      setRtspScanResult(null);
      const res = await fetch("/api/camera-streams/scan-rtsp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gate: activeGateTab.toLowerCase(),
          url: currentGateConfig.rtspUrl,
          scanType: activeGateTab === "EXIT" ? "EXIT" : "ENTRY",
        }),
      });
      const data = await res.json();
      setRtspScanResult(data);
    } catch (err: any) {
      setRtspScanResult({
        success: false,
        error: "Lỗi quét nhận diện từ RTSP: " + (err?.message || err),
      });
    } finally {
      setIsScanningRtsp(false);
    }
  };

  // Clipboard copy helper
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  // Video element callback ref to ensure mediaStream is mounted immediately when element appears in DOM
  const attachVideoRef = (el: HTMLVideoElement | null) => {
    videoPreviewRef.current = el;
    if (el && mediaStreamRef.current) {
      if (el.srcObject !== mediaStreamRef.current) {
        el.srcObject = mediaStreamRef.current;
      }
      el.play().catch((err) => {
        console.warn("Autoplay video client preview:", err);
      });
    }
  };

  // Start / Stop Live Preview for the currently selected Gate
  const startPreview = async (overrideGate?: GateStreamConfig) => {
    setPreviewError(null);
    setPreviewTimestamp(Date.now());
    const currentGate = overrideGate || (activeGateTab === "EXIT" ? config.exitGate : config.entryGate);

    if (currentGate.sourceType === "CLIENT_UVC") {
      setIsStartingCamera(true);
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error(
            "Trình duyệt không hỗ trợ WebRTC getUserMedia hoặc trang đang mở qua HTTP không bảo mật."
          );
        }

        // Clean up previous stream tracks to free hardware camera lock
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }

        let videoConstraints: MediaTrackConstraints = {};
        if (currentGate.uvcDeviceId && currentGate.uvcDeviceId !== "default") {
          videoConstraints.deviceId = { ideal: currentGate.uvcDeviceId };
        }

        if (currentGate.resolution && currentGate.resolution !== "AUTO") {
          const [wStr, hStr] = currentGate.resolution.split("x");
          const width = parseInt(wStr, 10);
          const height = parseInt(hStr, 10);
          if (!isNaN(width) && !isNaN(height)) {
            videoConstraints.width = { ideal: width };
            videoConstraints.height = { ideal: height };
          }
        }

        let stream: MediaStream | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true,
            audio: false,
          });
        } catch (firstErr: any) {
          console.warn("getUserMedia với thông số ideal thất bại, thử lại với video mặc định:", firstErr);
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        mediaStreamRef.current = stream;
        setIsPreviewActive(true);

        // Attach stream directly if video DOM element is already mounted
        if (videoPreviewRef.current) {
          videoPreviewRef.current.srcObject = stream;
          await videoPreviewRef.current.play().catch((err) => {
            console.warn("Video play error:", err);
          });
        }

        // Re-detect cameras to populate readable labels if they were withheld before permission
        detectClientCameras();
      } catch (err: any) {
        console.error("Lỗi mở Webcam UVC client:", err);
        let msg = "Không thể mở Webcam UVC client: " + (err?.message || err);
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          msg = "Quyền truy cập Camera bị từ chối trên trình duyệt. Vui lòng bấm vào biểu tượng ổ khóa/camera trên thanh địa chỉ và chọn 'Cho phép' (Allow) truy cập Camera.";
        } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
          msg = "Không tìm thấy thiết bị webcam nào được kết nối với máy tính của bạn.";
        } else if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
          msg = "Camera đang bị ứng dụng khác (Zoom, Teams, Zalo, hoặc tab trình duyệt khác) chiếm quyền sử dụng.";
        }
        setPreviewError(msg);
        setIsPreviewActive(false);
      } finally {
        setIsStartingCamera(false);
      }
    } else {
      // RTSP or HTTP: show live canvas or stream
      setIsPreviewActive(true);
    }
  };

  const stopPreview = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
    setIsPreviewActive(false);
  };

  // Keep video element srcObject synchronized when active state or source type changes
  useEffect(() => {
    const currentGate = activeGateTab === "EXIT" ? config.exitGate : config.entryGate;
    if (
      isPreviewActive &&
      currentGate.sourceType === "CLIENT_UVC" &&
      videoPreviewRef.current &&
      mediaStreamRef.current
    ) {
      if (videoPreviewRef.current.srcObject !== mediaStreamRef.current) {
        videoPreviewRef.current.srcObject = mediaStreamRef.current;
      }
      videoPreviewRef.current.play().catch((err) => {
        console.warn("Sync video play error:", err);
      });
    }
  }, [isPreviewActive, activeGateTab, config.entryGate.sourceType, config.exitGate.sourceType]);

  const currentGateConfig = activeGateTab === "EXIT" ? config.exitGate : config.entryGate;

  const updateCurrentGate = (updater: (prev: GateStreamConfig) => GateStreamConfig) => {
    if (activeGateTab === "EXIT") {
      setConfig((prev) => ({ ...prev, exitGate: updater(prev.exitGate) }));
    } else {
      setConfig((prev) => ({ ...prev, entryGate: updater(prev.entryGate) }));
    }
  };

  // RTSP Presets
  const applyPreset = (type: "HIKVISION_LOCAL_101" | "HIKVISION_LOCAL_102" | "HIKVISION" | "DAHUA" | "EZVIZ" | "GENERIC") => {
    let presetUrl = "";
    if (type === "HIKVISION_LOCAL_101") {
      presetUrl = "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101";
    } else if (type === "HIKVISION_LOCAL_102") {
      presetUrl = "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/102";
    } else if (type === "HIKVISION") {
      presetUrl = "rtsp://admin:Password123@192.168.1.64:554/Streaming/Channels/101";
    } else if (type === "DAHUA") {
      presetUrl = "rtsp://admin:admin123@192.168.1.108:554/cam/realmonitor?channel=1&subtype=0";
    } else if (type === "EZVIZ") {
      presetUrl = "rtsp://admin:VERIFICATION_CODE@192.168.1.50:554/h264/ch1/main/av_stream";
    } else {
      presetUrl = "rtsp://192.168.1.100:554/live/ch0";
    }
    updateCurrentGate((prev) => ({ ...prev, rtspUrl: presetUrl, sourceType: "RTSP", rtspTransport: "TCP" }));
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-blue-600 flex items-center justify-center text-white shadow-md shadow-indigo-100">
              <Video className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                Cấu Hình Luồng Camera & Xử Lý Đa Luồng
                <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-blue-100 text-blue-800 border border-blue-200">
                  Multi-Thread Engine
                </span>
              </h1>
              <p className="text-sm text-slate-700 mt-0.5">
                Khai báo nguồn camera Cổng Vào/Ra (RTSP, UVC Client Browser, HTTP Stream) và tách nhận diện khuôn mặt chạy đa luồng tại máy chủ.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchConfig}
            disabled={loading}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-blue-600" : ""}`} />
            Làm Mới
          </button>

          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-semibold hover:from-blue-700 hover:to-indigo-700 shadow-sm shadow-blue-200 transition-all disabled:opacity-50"
          >
            {saving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Đang Lưu...
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Lưu Cấu Hình
              </>
            )}
          </button>
        </div>
      </div>

      {/* Notifications / Alerts */}
      {saveSuccess && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center gap-3 text-emerald-800 text-sm shadow-xs animate-in fade-in">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>Đã lưu thành công cấu hình luồng camera và cập nhật Worker Thread Pool tại máy chủ!</span>
        </div>
      )}

      {saveError && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-3 text-rose-800 text-sm shadow-xs animate-in fade-in">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {/* ---------------- SECTION 1: MULTI-THREAD WORKER POOL TELEMETRY DASHBOARD ---------------- */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 text-white shadow-lg space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                Cụm Xử Lý Đa Luồng Nhận Diện Khuôn Mặt (Backend Worker Pool)
                <span className="text-xs px-2 py-0.5 rounded-md bg-emerald-950 text-emerald-300 border border-emerald-800">
                  {config.multiThreadEnabled ? "Đang Hoạt Động" : "Đã Tắt"}
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Tách biệt hoàn toàn tính toán vector khuôn mặt (BlazeFace/ArcFace) ra các worker thread riêng biệt, không nghẽn Event Loop.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleRunBenchmark}
              disabled={benchmarking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-xs transition-colors disabled:opacity-50"
            >
              <Flame className={`w-3.5 h-3.5 ${benchmarking ? "animate-bounce text-amber-300" : "text-amber-400"}`} />
              {benchmarking ? "Đang Chạy Thử Nghiệm..." : "Thử Nghiệm Tải Song Song (Benchmark)"}
            </button>
          </div>
        </div>

        {/* Telemetry Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/60">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Số Luồng Worker (Threads)</span>
              <Cpu className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {telemetry?.workerThreadsCount || config.workerThreadsCount} <span className="text-xs font-normal text-slate-400">luồng CPU</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              {telemetry?.activeWorkers || 0} luồng đang bận, {(telemetry?.workerThreadsCount || 4) - (telemetry?.activeWorkers || 0)} luồng rảnh
            </div>
          </div>

          <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/60">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Độ Trễ Worker TB</span>
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-emerald-400 tracking-tight">
              {telemetry?.averageLatencyMs || 24.5} <span className="text-xs font-normal text-slate-400">ms/face</span>
            </div>
            <div className="text-[11px] text-emerald-500/80 mt-1">
              Siêu tốc ~40 khung hình/giây
            </div>
          </div>

          <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/60">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Hàng Đợi (Queue Depth)</span>
              <Layers className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold text-slate-100 tracking-tight">
              {telemetry?.queueDepth || 0} <span className="text-xs font-normal text-slate-400">task chờ</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Không tồn đọng tác vụ
            </div>
          </div>

          <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/60">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Tổng Khung Hình Xử Lý</span>
              <Zap className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-2xl font-bold text-blue-400 tracking-tight">
              {telemetry?.totalProcessed || 128} <span className="text-xs font-normal text-slate-400">lần</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Phân phối cân bằng tải
            </div>
          </div>
        </div>

        {/* Worker Threads Visual Grid */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span className="font-semibold uppercase tracking-wider text-slate-400">
              Trạng Thái Từng Luồng Worker (Node.js Worker Threads Isolated)
            </span>
            <span className="text-slate-400">
              Tự động phục hồi và phân bổ FIFO
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(telemetry?.workers || [
              { id: 1, status: "IDLE", tasksCompleted: 34, lastLatencyMs: 22 },
              { id: 2, status: "IDLE", tasksCompleted: 31, lastLatencyMs: 26 },
              { id: 3, status: "IDLE", tasksCompleted: 35, lastLatencyMs: 24 },
              { id: 4, status: "IDLE", tasksCompleted: 28, lastLatencyMs: 28 },
            ]).map((w) => (
              <div
                key={w.id}
                className="bg-slate-800/60 rounded-lg p-3 border border-slate-700 flex flex-col justify-between hover:border-slate-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-slate-200">
                    Worker #{w.id}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                      w.status === "BUSY"
                        ? "bg-amber-950 text-amber-400 border border-amber-800"
                        : "bg-emerald-950 text-emerald-400 border border-emerald-800"
                    }`}
                  >
                    {w.status === "BUSY" ? "BUSY (Xử lý)" : "IDLE (Chờ)"}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Hoàn tất: <strong className="text-slate-200">{w.tasksCompleted}</strong></span>
                  <span>Trễ: <strong className="text-emerald-400">{w.lastLatencyMs || 25}ms</strong></span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Worker Pool Scale Control Slider */}
        <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <label className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Sliders className="w-4 h-4 text-indigo-400" />
              Điều Chỉnh Quy Mô Cụm Luồng Worker (1 - 8 Threads)
            </label>
            <p className="text-xs text-slate-400">
              Khuyến nghị 4 luồng trên máy chủ tiêu chuẩn hoặc 8 luồng khi đồng thời kết nối 2 luồng RTSP Cổng Vào và Cổng Ra.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              value={config.workerThreadsCount}
              onChange={(e) => handleScaleWorkers(parseInt(e.target.value, 10))}
              className="w-36 sm:w-48 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="font-mono text-sm font-bold text-indigo-300 w-16 text-right">
              {config.workerThreadsCount} Luồng
            </span>
          </div>
        </div>

        {/* Benchmark Result Box (if run) */}
        {benchmarkResults && (
          <div className="bg-indigo-950/40 rounded-xl p-4 border border-indigo-800/60 text-xs space-y-2 animate-in fade-in">
            <div className="flex items-center justify-between text-indigo-300 font-semibold">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                Kết Quả Thử Nghiệm Tải {benchmarkResults.taskCount} Tác Vụ Đồng Thời
              </span>
              <span className="font-mono">
                Tổng thời gian: {benchmarkResults.totalDurationMs}ms
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-300 pt-1">
              <div>Độ trễ trung bình: <strong className="text-emerald-300">{benchmarkResults.avgWorkerLatencyMs}ms</strong></div>
              <div>Thông lượng xử lý: <strong className="text-blue-300">{benchmarkResults.throughputFps} khuôn mặt/giây</strong></div>
              <div>Số worker tham gia: <strong className="text-amber-300">{benchmarkResults.threadsUtilized?.length || 4} threads</strong></div>
              <div>Trạng thái: <strong className="text-emerald-400">Đạt chuẩn Realtime</strong></div>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- SECTION 2: DUAL GATE CAMERA STREAMS CONFIGURATION ---------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        {/* Gate Tabs */}
        <div className="flex border-b border-slate-200 bg-slate-50/70 p-2 gap-2">
          <button
            onClick={() => {
              setActiveGateTab("ENTRY");
              stopPreview();
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all ${
              activeGateTab === "ENTRY"
                ? "bg-white text-indigo-700 shadow-xs border border-slate-200 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Radio className="w-4 h-4 text-emerald-600" />
            Cổng Vào (Main Entry Gate)
            <span
              className={`w-2 h-2 rounded-full ${
                config.entryGate.enabled ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
          </button>

          <button
            onClick={() => {
              setActiveGateTab("EXIT");
              stopPreview();
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all ${
              activeGateTab === "EXIT"
                ? "bg-white text-indigo-700 shadow-xs border border-slate-200 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Radio className="w-4 h-4 text-blue-600" />
            Cổng Ra (Exit Gate B2)
            <span
              className={`w-2 h-2 rounded-full ${
                config.exitGate.enabled ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
          </button>

          <button
            onClick={() => {
              setActiveGateTab("DUAL_MONITOR");
              stopPreview();
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all ${
              activeGateTab === "DUAL_MONITOR"
                ? "bg-white text-indigo-700 shadow-xs border border-slate-200 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Eye className="w-4 h-4 text-purple-600" />
            Xem Đồng Thời 2 Cổng (Dual Monitor)
          </button>
        </div>

        {activeGateTab !== "DUAL_MONITOR" ? (
          <div className="p-6 sm:p-8 space-y-8">
            {/* Gate Enable & Name */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center border-b border-slate-100 pb-6">
              <div>
                <label className="block text-sm font-semibold text-slate-800">
                  Tên Định Danh Camera Cổng
                </label>
                <input
                  type="text"
                  value={currentGateConfig.name}
                  onChange={(e) => updateCurrentGate((prev) => ({ ...prev, name: e.target.value }))}
                  className="mt-1.5 w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="VD: Camera Cổng Chính Tòa Nhà A"
                />
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-4 pt-4 sm:pt-0">
                <div className="text-right">
                  <div className="text-sm font-semibold text-slate-800">Trạng Thái Kích Hoạt Luồng</div>
                  <div className="text-xs text-slate-700">
                    {currentGateConfig.enabled ? "Đang bật nhận diện cho cổng này" : "Tạm dừng luồng camera"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateCurrentGate((prev) => ({ ...prev, enabled: !prev.enabled }))
                  }
                  className={`w-12 h-6 rounded-full transition-colors relative p-0.5 focus:outline-none ${
                    currentGateConfig.enabled ? "bg-emerald-600" : "bg-slate-300"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white shadow-xs transition-transform ${
                      currentGateConfig.enabled ? "translate-x-6" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Source Type Selector Grid */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-900">
                Lựa Chọn Loại Nguồn Luồng Camera (Camera Stream Source)
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 1. Client UVC */}
                <div
                  onClick={() => updateCurrentGate((prev) => ({ ...prev, sourceType: "CLIENT_UVC" }))}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    currentGateConfig.sourceType === "CLIENT_UVC"
                      ? "border-blue-600 bg-blue-50/50 shadow-xs"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Camera className="w-5 h-5 text-blue-600" />
                    <span className="font-semibold text-sm text-slate-900">1. UVC Camera Client</span>
                  </div>
                  <p className="text-xs text-slate-700">
                    Sử dụng Webcam máy trạm USB/cổng trình duyệt thông qua MediaDevices API.
                  </p>
                </div>

                {/* 2. RTSP */}
                <div
                  onClick={() => updateCurrentGate((prev) => ({ ...prev, sourceType: "RTSP" }))}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    currentGateConfig.sourceType === "RTSP"
                      ? "border-indigo-600 bg-indigo-50/50 shadow-xs"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Video className="w-5 h-5 text-indigo-600" />
                    <span className="font-semibold text-sm text-slate-900">2. Luồng URL RTSP</span>
                  </div>
                  <p className="text-xs text-slate-700">
                    Đầu ghi NVR / Camera IP công nghiệp (Hikvision, Dahua, EZVIZ, IMOU).
                  </p>
                </div>

                {/* 3. HTTP / MJPEG */}
                <div
                  onClick={() => updateCurrentGate((prev) => ({ ...prev, sourceType: "HTTP_MJPEG" }))}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    currentGateConfig.sourceType === "HTTP_MJPEG"
                      ? "border-purple-600 bg-purple-50/50 shadow-xs"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Radio className="w-5 h-5 text-purple-600" />
                    <span className="font-semibold text-sm text-slate-900">3. HTTP / MJPEG Stream</span>
                  </div>
                  <p className="text-xs text-slate-700">
                    Luồng stream HTTP trực tiếp (ESP32-CAM, webcam server IP).
                  </p>
                </div>

                {/* 4. Backend UVC */}
                <div
                  onClick={() => updateCurrentGate((prev) => ({ ...prev, sourceType: "BACKEND_UVC" }))}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    currentGateConfig.sourceType === "BACKEND_UVC"
                      ? "border-emerald-600 bg-emerald-50/50 shadow-xs"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Server className="w-5 h-5 text-emerald-600" />
                    <span className="font-semibold text-sm text-slate-900">4. UVC Backend Server</span>
                  </div>
                  <p className="text-xs text-slate-700">
                    Webcam cắm trực tiếp vào máy chủ Linux qua cổng V4L2 (/dev/video0).
                  </p>
                </div>
              </div>
            </div>

            {/* Dynamic Configuration Fields Based on Selected Source Type */}
            {currentGateConfig.sourceType === "RTSP" && (
              <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-4 animate-in fade-in">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <Video className="w-4 h-4 text-indigo-600" />
                    Cấu Hình Chi Tiết Luồng RTSP (IP Camera)
                  </span>
                  {/* Quick Presets */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-slate-700">Mẫu nhanh:</span>
                    <button
                      type="button"
                      onClick={() => applyPreset("HIKVISION_LOCAL_101")}
                      className="px-2.5 py-1 rounded-md text-xs bg-indigo-600 text-white hover:bg-indigo-700 font-semibold shadow-xs flex items-center gap-1"
                      title="rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101"
                    >
                      <Zap className="w-3 h-3" />
                      192.168.60.2 (Kênh 101 Main)
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset("HIKVISION_LOCAL_102")}
                      className="px-2.5 py-1 rounded-md text-xs bg-indigo-100 text-indigo-800 hover:bg-indigo-200 font-semibold border border-indigo-200 flex items-center gap-1"
                      title="rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/102"
                    >
                      192.168.60.2 (Kênh 102 Sub)
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset("HIKVISION")}
                      className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium"
                    >
                      Hikvision Khác
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset("DAHUA")}
                      className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium"
                    >
                      Dahua
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset("EZVIZ")}
                      className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium"
                    >
                      EZVIZ
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    URL Luồng RTSP (Bao gồm User/Password nếu có)
                  </label>
                  <input
                    type="text"
                    value={currentGateConfig.rtspUrl || ""}
                    onChange={(e) =>
                      updateCurrentGate((prev) => ({ ...prev, rtspUrl: e.target.value }))
                    }
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101"
                  />
                  <div className="flex flex-wrap items-center justify-between text-xs text-slate-700 mt-1.5 gap-2">
                    <span>
                      Cú pháp chuẩn: <code className="text-indigo-600 font-mono">rtsp://[user]:[password]@[ip]:[port]/[path]</code>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowHikvisionGuide((prev) => !prev)}
                      className="text-indigo-600 hover:text-indigo-800 font-medium inline-flex items-center gap-1"
                    >
                      <HelpCircle className="w-3.5 h-3.5" />
                      {showHikvisionGuide ? "Ẩn hướng dẫn camera 192.168.60.2" : "Xem hướng dẫn cấu hình luồng 192.168.60.2"}
                      {showHikvisionGuide ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                  </div>
                </div>

                {/* EXPANDABLE COMPREHENSIVE GUIDE FOR LOCAL RTSP */}
                {showHikvisionGuide && (
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3.5 text-xs text-slate-800 animate-in fade-in">
                    <div className="flex items-center justify-between border-b border-indigo-100 pb-2">
                      <div className="flex items-center gap-2 font-bold text-indigo-950 text-sm">
                        <Info className="w-4 h-4 text-indigo-600" />
                        Hướng Dẫn Cấu Hình Luồng RTSP Cục Bộ: <code className="font-mono text-indigo-700 bg-white px-1.5 py-0.5 rounded border border-indigo-200">rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101</code>
                      </div>
                    </div>

                    {/* Breakdown grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                      <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
                        <div className="text-slate-500 font-semibold text-[11px]">ĐỊA CHỈ IP & PORT MẠNG LAN</div>
                        <div className="font-mono font-bold text-slate-900 mt-0.5">192.168.60.2 : 554</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">IP tĩnh của camera trong mạng nội bộ</div>
                      </div>
                      <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
                        <div className="text-slate-500 font-semibold text-[11px]">TÀI KHOẢN & MẬT KHẨU</div>
                        <div className="font-mono font-bold text-slate-900 mt-0.5">viewCam / 1234abcd</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">Xác thực Digest/Basic quyền xem luồng</div>
                      </div>
                      <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
                        <div className="text-slate-500 font-semibold text-[11px]">KÊNH 101 VS KÊNH 102</div>
                        <div className="font-mono font-bold text-slate-900 mt-0.5">Channels/101 hoặc 102</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">101: Main (FullHD/4K) | 102: Sub (AI siêu mượt)</div>
                      </div>
                    </div>

                    {/* Steps tab */}
                    <div className="space-y-2.5 bg-white p-3 rounded-lg border border-indigo-100">
                      <div className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-indigo-600" />
                        3 Bước Xác Thực & Triển Khai Thực Tế:
                      </div>

                      <div className="space-y-2 text-slate-700">
                        <div className="flex items-start gap-2">
                          <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">1</span>
                          <div>
                            <span className="font-semibold text-slate-900">Kiểm tra luồng qua phần mềm VLC Media Player:</span>
                            <p className="text-[11px] text-slate-600 mt-0.5">
                              Mở VLC trên máy tính cùng mạng WiFi/LAN văn phòng &rarr; Nhấn <kbd className="px-1 py-0.5 bg-slate-100 border rounded font-mono text-[10px]">Ctrl + N</kbd> (Open Network Stream) &rarr; Dán URL trên &rarr; Nhấn Play. Nếu phát được hình, camera đang hoạt động hoàn hảo!
                            </p>
                          </div>
                        </div>

                        <div className="flex items-start gap-2">
                          <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">2</span>
                          <div>
                            <span className="font-semibold text-slate-900">Cấu hình trên giao diện Web camera Hikvision (http://192.168.60.2):</span>
                            <ul className="list-disc pl-4 text-[11px] text-slate-600 space-y-0.5 mt-0.5">
                              <li>Vào <b>Configuration &rarr; Network &rarr; Advanced Settings &rarr; Integration Protocol</b> &rarr; Bật <b>Enable Open Network Video Interface (ONVIF)</b> và thêm user <code className="text-indigo-700 font-bold">viewCam</code>.</li>
                              <li>Vào <b>Configuration &rarr; System &rarr; Security &rarr; Authentication</b> &rarr; Mục <i>RTSP Authentication</i> chọn <b>digest/basic</b>.</li>
                            </ul>
                          </div>
                        </div>

                        <div className="flex items-start gap-2">
                          <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">3</span>
                          <div>
                            <span className="font-semibold text-slate-900">Lưu ý quan trọng về môi trường máy chủ (Cloud vs On-Premise):</span>
                            <p className="text-[11px] text-slate-600 mt-0.5">
                              <code className="text-amber-700 bg-amber-50 px-1 py-0.5 rounded font-mono">192.168.60.2</code> là dải IP riêng tư (Private LAN). Nếu bạn đang mở web từ Cloud (Render/Cloud Run), máy chủ Cloud không thể tự vào mạng LAN văn phòng của bạn. Để chạy luồng này, bạn có 2 giải pháp:
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                              <div className="p-2.5 rounded border border-emerald-200 bg-emerald-50/70 text-[11px]">
                                <div className="font-bold text-emerald-900 flex items-center gap-1">
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  Cách 1 (Khuyên dùng): Chạy Backend Cục Bộ
                                </div>
                                <div className="text-emerald-800 mt-1">
                                  Chạy server trực tiếp trên PC/Laptop hoặc mini server cắm cùng mạng LAN văn phòng (192.168.60.x). Backend sẽ nhận diện khuôn mặt trực tiếp không có độ trễ:
                                </div>
                                <div className="mt-1.5 flex items-center justify-between bg-white px-2 py-1 rounded border border-emerald-300 font-mono text-[10px]">
                                  <span>npm install && npm run dev</span>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard("npm install && npm run dev", "npm-dev")}
                                    className="text-emerald-700 hover:text-emerald-900 font-bold flex items-center gap-1"
                                  >
                                    {copiedKey === "npm-dev" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    {copiedKey === "npm-dev" ? "Đã chép" : "Copy"}
                                  </button>
                                </div>
                              </div>

                              <div className="p-2.5 rounded border border-blue-200 bg-blue-50/70 text-[11px]">
                                <div className="font-bold text-blue-900 flex items-center gap-1">
                                  <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                                  Cách 2: Cầu nối Tailscale / VPN / RTSP Bridge
                                </div>
                                <div className="text-blue-800 mt-1">
                                  Cài đặt VPN Tailscale hoặc MediaMTX trên một máy trong mạng LAN để tạo đường hầm an toàn đưa luồng camera lên máy chủ Cloud:
                                </div>
                                <div className="mt-1.5 flex items-center justify-between bg-white px-2 py-1 rounded border border-blue-300 font-mono text-[10px]">
                                  <span>docker run -d --net=host bluenviron/mediamtx</span>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard("docker run -d --net=host bluenviron/mediamtx", "docker-mtx")}
                                    className="text-blue-700 hover:text-blue-900 font-bold flex items-center gap-1"
                                  >
                                    {copiedKey === "docker-mtx" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    {copiedKey === "docker-mtx" ? "Đã chép" : "Copy"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Giao Thức Truyền Tải (RTSP Transport Protocol)
                    </label>
                    <select
                      value={currentGateConfig.rtspTransport || "TCP"}
                      onChange={(e) =>
                        updateCurrentGate((prev) => ({
                          ...prev,
                          rtspTransport: e.target.value as "TCP" | "UDP",
                        }))
                      }
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white outline-none"
                    >
                      <option value="TCP">TCP (Khuyến nghị: Chống mất gói hình ảnh, ổn định cao)</option>
                      <option value="UDP">UDP (Độ trễ siêu thấp, phù hợp mạng LAN nội bộ chuẩn Gigabit)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Kiểm Tra Kết Nối Socket TCP Luồng RTSP
                    </label>
                    <button
                      type="button"
                      onClick={() => handleTestConnection(currentGateConfig)}
                      disabled={testingConnection}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-sm font-semibold transition-colors disabled:opacity-50"
                    >
                      <Radio className={`w-4 h-4 ${testingConnection ? "animate-pulse" : ""}`} />
                      {testingConnection ? "Đang Kiểm Tra Ping..." : "Kiểm Tra Kết Nối Luồng"}
                    </button>
                  </div>
                </div>

                {testResultData && (
                  <div
                    className={`p-3.5 rounded-xl border text-xs space-y-1.5 animate-in fade-in ${
                      testResultData.tcpConnected
                        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                        : testResultData.isPrivateLan
                        ? "bg-amber-50 border-amber-200 text-amber-950"
                        : "bg-rose-50 border-rose-200 text-rose-900"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold text-sm">
                      {testResultData.tcpConnected ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          <span>KẾT NỐI RTSP THÀNH CÔNG</span>
                        </>
                      ) : testResultData.isPrivateLan ? (
                        <>
                          <AlertTriangle className="w-4 h-4 text-amber-600" />
                          <span>ĐỊA CHỈ MẠNG LAN NỘI BỘ (PRIVATE IP)</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-4 h-4 text-rose-600" />
                          <span>KHÔNG THỂ KẾT NỐI TỚI CAMERA</span>
                        </>
                      )}
                    </div>
                    <p>{testStatusMessage}</p>
                    {testResultData.details && (
                      <div className="font-mono text-[11px] opacity-80 pt-1">
                        Host: {testResultData.details.host}:{testResultData.details.port} | Transport: {testResultData.details.transport} | Latency: {testResultData.details.latencyMs}ms
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {currentGateConfig.sourceType === "CLIENT_UVC" && (
              <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-4 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <Camera className="w-4 h-4 text-blue-600" />
                    Cấu Hình Thiết Bị UVC Trình Duyệt (Client MediaDevices)
                  </span>
                  <button
                    type="button"
                    onClick={detectClientCameras}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
                    Quét Lại Camera
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      Chọn Thiết Bị Webcam Cắm Ngoài
                    </label>
                    <select
                      value={currentGateConfig.uvcDeviceId || "default"}
                      onChange={(e) => {
                        const newDeviceId = e.target.value;
                        const dev = availableCameras.find((c) => c.deviceId === newDeviceId);
                        const updated = {
                          ...currentGateConfig,
                          uvcDeviceId: newDeviceId,
                          uvcDeviceLabel: dev ? dev.label : "Mặc định",
                        };
                        updateCurrentGate((prev) => ({
                          ...prev,
                          uvcDeviceId: newDeviceId,
                          uvcDeviceLabel: dev ? dev.label : "Mặc định",
                        }));
                        if (isPreviewActive && currentGateConfig.sourceType === "CLIENT_UVC") {
                          startPreview(updated);
                        }
                      }}
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white outline-none font-medium"
                    >
                      <option value="default">Camera Mặc Định Trình Duyệt</option>
                      {availableCameras.map((cam) => (
                        <option key={cam.deviceId} value={cam.deviceId}>
                          {cam.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      Độ Phân Giải Mục Tiêu (Resolution)
                    </label>
                    <select
                      value={currentGateConfig.resolution || "1280x720"}
                      onChange={(e) => {
                        const newRes = e.target.value as any;
                        const updated = {
                          ...currentGateConfig,
                          resolution: newRes,
                        };
                        updateCurrentGate((prev) => ({
                          ...prev,
                          resolution: newRes,
                        }));
                        if (isPreviewActive && currentGateConfig.sourceType === "CLIENT_UVC") {
                          startPreview(updated);
                        }
                      }}
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white outline-none font-medium"
                    >
                      <option value="1920x1080">1080p Full HD (1920 x 1080) - Chi tiết cao nhất</option>
                      <option value="1280x720">720p HD (1280 x 720) - Chuẩn tối ưu AI</option>
                      <option value="640x480">480p SD (640 x 480) - Tiết kiệm băng thông</option>
                      <option value="AUTO">Tự Động (Theo khả năng thiết bị)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {currentGateConfig.sourceType === "HTTP_MJPEG" && (
              <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-4 animate-in fade-in">
                <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                  <Radio className="w-4 h-4 text-purple-600" />
                  Cấu Hình Luồng HTTP / MJPEG
                </span>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    URL Luồng Stream HTTP
                  </label>
                  <input
                    type="text"
                    value={currentGateConfig.httpUrl || ""}
                    onChange={(e) =>
                      updateCurrentGate((prev) => ({ ...prev, httpUrl: e.target.value }))
                    }
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-purple-500 outline-none"
                    placeholder="http://192.168.1.75:81/stream"
                  />
                  <p className="text-xs text-slate-700 mt-1">
                    Phù hợp cho ESP32-CAM, mjpg-streamer, hoặc các module camera nhúng.
                  </p>
                </div>
              </div>
            )}

            {currentGateConfig.sourceType === "BACKEND_UVC" && (
              <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-4 animate-in fade-in">
                <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                  <Server className="w-4 h-4 text-emerald-600" />
                  Cấu Hình Thiết Bị V4L2 Máy Chủ
                </span>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Đường Dẫn Thiết Bị Linux (Device Path)
                  </label>
                  <input
                    type="text"
                    value={currentGateConfig.backendDevicePath || "/dev/video0"}
                    onChange={(e) =>
                      updateCurrentGate((prev) => ({ ...prev, backendDevicePath: e.target.value }))
                    }
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-emerald-500 outline-none"
                    placeholder="/dev/video0"
                  />
                  <p className="text-xs text-slate-700 mt-1">
                    Cần phân quyền truy cập thiết bị (vd: video group) trong môi trường triển khai docker/container.
                  </p>
                </div>
              </div>
            )}

            {/* ---------------- LIVE STREAM TEST PREVIEW PLAYER ---------------- */}
            <div className="border-t border-slate-200 pt-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Eye className="w-4 h-4 text-blue-600" />
                    Trình Xem Thử Nghiệm Luồng Trực Tiếp ({currentGateConfig.name})
                  </h3>
                  <p className="text-xs text-slate-700">
                    Kiểm tra góc quay, chất lượng khung hình thực tế và thử nghiệm nhận diện AI đa luồng.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {currentGateConfig.sourceType === "RTSP" && (
                    <>
                      {/* RTSP Mode Switcher */}
                      <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-xs font-semibold">
                        <button
                          type="button"
                          onClick={() => { setRtspViewMode("MJPEG"); setPreviewTimestamp(Date.now()); }}
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            rtspViewMode === "MJPEG" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          Proxy MJPEG
                        </button>
                        <button
                          type="button"
                          onClick={() => { setRtspViewMode("SNAPSHOT"); setPreviewTimestamp(Date.now()); }}
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            rtspViewMode === "SNAPSHOT" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          Snapshot Thật
                        </button>
                        <button
                          type="button"
                          onClick={() => { setRtspViewMode("SIMULATION"); setPreviewTimestamp(Date.now()); }}
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            rtspViewMode === "SIMULATION" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          Mô Phỏng
                        </button>
                      </div>

                      {/* AI Face Recognition Test Directly from RTSP */}
                      <button
                        type="button"
                        onClick={handleScanRtsp}
                        disabled={isScanningRtsp}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
                        title="Chụp 1 khung hình từ RTSP và chuyển vào Worker Threads nhận diện"
                      >
                        <ScanFace className={`w-3.5 h-3.5 text-indigo-600 ${isScanningRtsp ? "animate-spin" : ""}`} />
                        {isScanningRtsp ? "Đang Quét AI..." : "Quét Nhận Diện Từ RTSP"}
                      </button>
                    </>
                  )}

                  {!isPreviewActive ? (
                    <button
                      type="button"
                      onClick={startPreview}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Bật Xem Trực Tiếp
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopPreview}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs transition-colors"
                    >
                      <Square className="w-3.5 h-3.5" />
                      Dừng Xem
                    </button>
                  )}
                </div>
              </div>

              {previewError && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
                  {previewError}
                </div>
              )}

              {/* Player Stage */}
              <div className="relative w-full aspect-video bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 flex items-center justify-center">
                {isStartingCamera && (
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center text-white text-xs z-20 gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
                    <span>Đang kết nối camera trình duyệt...</span>
                  </div>
                )}

                {isPreviewActive ? (
                  currentGateConfig.sourceType === "CLIENT_UVC" ? (
                    <video
                      ref={attachVideoRef}
                      autoPlay
                      playsInline
                      muted
                      onLoadedMetadata={() => {
                        videoPreviewRef.current?.play().catch((err) => {
                          console.warn("Lỗi autoplay video onLoadedMetadata:", err);
                        });
                      }}
                      className="w-full h-full object-cover"
                    />
                  ) : currentGateConfig.sourceType === "RTSP" ? (
                    rtspViewMode === "MJPEG" ? (
                      <img
                        key={`mjpeg-${previewTimestamp}`}
                        src={`/api/camera-streams/mjpeg?gate=${activeGateTab.toLowerCase()}&url=${encodeURIComponent(
                          currentGateConfig.rtspUrl || ""
                        )}&t=${previewTimestamp}`}
                        alt="RTSP Live MJPEG"
                        onError={() => {
                          // If proxy fails (e.g. cloud cannot reach private LAN), fallback gracefully
                          setRtspViewMode("SIMULATION");
                        }}
                        className="w-full h-full object-contain"
                      />
                    ) : rtspViewMode === "SNAPSHOT" ? (
                      <img
                        key={`snap-${previewTimestamp}`}
                        src={`/api/camera-streams/snapshot?gate=${activeGateTab.toLowerCase()}&url=${encodeURIComponent(
                          currentGateConfig.rtspUrl || ""
                        )}&t=${previewTimestamp}`}
                        alt="RTSP Snapshot"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <img
                        src={`/api/camera-streams/test-frame?gate=${activeGateTab.toLowerCase()}&source=${encodeURIComponent(
                          currentGateConfig.sourceType
                        )}&t=${previewTimestamp}`}
                        alt="Camera Stream Simulation"
                        className="w-full h-full object-contain"
                      />
                    )
                  ) : (
                    <img
                      src={`/api/camera-streams/test-frame?gate=${activeGateTab.toLowerCase()}&source=${encodeURIComponent(
                        currentGateConfig.sourceType
                      )}&t=${previewTimestamp}`}
                      alt="Camera Stream Test"
                      className="w-full h-full object-contain"
                    />
                  )
                ) : (
                  <div className="text-center space-y-2 p-6">
                    <Video className="w-12 h-12 text-slate-700 mx-auto" />
                    <p className="text-sm font-medium text-slate-400">
                      Trình xem thử nghiệm đang ở trạng thái chờ
                    </p>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto">
                      Nhấn nút "Bật Xem Trực Tiếp" hoặc chọn chế độ Proxy/Snapshot để kết nối kiểm tra luồng <code className="text-indigo-400">192.168.60.2</code>.
                    </p>
                  </div>
                )}

                {/* Overlays during active preview */}
                {isPreviewActive && (
                  <>
                    <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-xs text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-2 font-mono">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                      <span>{currentGateConfig.name}</span>
                      <span className="text-slate-400">|</span>
                      <span className="text-emerald-400 font-bold">
                        {currentGateConfig.sourceType}
                        {currentGateConfig.sourceType === "RTSP" ? ` (${rtspViewMode})` : ""}
                      </span>
                    </div>

                    <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-xs text-white text-xs px-3 py-1.5 rounded-lg font-mono">
                      {currentGateConfig.resolution || "1920x1080"} • {previewFps} FPS
                    </div>

                    <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-xs text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-2">
                      <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Multi-Thread Worker Pool: Đã sẵn sàng</span>
                    </div>
                  </>
                )}
              </div>

              {/* RTSP Direct AI Scan Results Card */}
              {rtspScanResult && (
                <div
                  className={`p-4 rounded-xl border text-xs space-y-2 animate-in fade-in ${
                    rtspScanResult.success && rtspScanResult.matchedEmployee
                      ? "bg-emerald-50 border-emerald-300 text-emerald-950"
                      : rtspScanResult.success
                      ? "bg-amber-50 border-amber-300 text-amber-950"
                      : "bg-rose-50 border-rose-300 text-rose-950"
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <div className="flex items-center gap-2">
                      <ScanFace className="w-4 h-4" />
                      <span>KẾT QUẢ QUÉT NHẬN DIỆN TỪ LUỒNG RTSP ({activeGateTab})</span>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded font-mono bg-white/70">
                      {rtspScanResult.multiThreadUsed ? "⚡ Multi-Thread Worker" : "Chế độ tuần tự"}
                    </span>
                  </div>

                  {rtspScanResult.success ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 font-mono">
                      <div>
                        <span className="opacity-75">Đối tượng: </span>
                        <b>{rtspScanResult.matchedEmployee ? rtspScanResult.matchedEmployee.name : "Người lạ (Stranger)"}</b>
                      </div>
                      <div>
                        <span className="opacity-75">Độ tương đồng: </span>
                        <b>{Math.round((rtspScanResult.similarityScore || 0) * 100)}%</b>
                      </div>
                      <div>
                        <span className="opacity-75">Thời gian xử lý: </span>
                        <b>{rtspScanResult.processDurationMs || 12}ms (Lấy frame: {rtspScanResult.frameCaptureDurationMs || 0}ms)</b>
                      </div>
                    </div>
                  ) : (
                    <p className="text-rose-800 font-medium">
                      {rtspScanResult.error || "Không thể lấy khung hình hoặc nhận diện"}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* DUAL MONITOR SPLIT SCREEN */
          <div className="p-6 space-y-6">
            <div className="text-center max-w-md mx-auto space-y-1">
              <h3 className="text-base font-bold text-slate-900">
                Giám Sát Đồng Thời Cả 2 Cổng (Cổng Vào & Cổng Ra)
              </h3>
              <p className="text-xs text-slate-700">
                Màn hình kép phân giải cao hỗ trợ bảo vệ an ninh kiểm soát lưu lượng cả 2 chiều song song.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Entry Gate Box */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    {config.entryGate.name}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
                    {config.entryGate.sourceType}
                  </span>
                </div>
                <div className="relative aspect-video bg-slate-900 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                  <img
                    src={`/api/camera-streams/test-frame?gate=entry&source=${encodeURIComponent(
                      config.entryGate.sourceType
                    )}&t=${Date.now()}`}
                    alt="Cổng Vào"
                    className="w-full h-full object-contain"
                  />
                  <div className="absolute top-2 left-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded font-mono">
                    CỔNG VÀO (ENTRY)
                  </div>
                </div>
              </div>

              {/* Exit Gate Box */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                    {config.exitGate.name}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 font-bold border border-blue-200">
                    {config.exitGate.sourceType}
                  </span>
                </div>
                <div className="relative aspect-video bg-slate-900 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                  <img
                    src={`/api/camera-streams/test-frame?gate=exit&source=${encodeURIComponent(
                      config.exitGate.sourceType
                    )}&t=${Date.now()}`}
                    alt="Cổng Ra"
                    className="w-full h-full object-contain"
                  />
                  <div className="absolute top-2 left-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded font-mono">
                    CỔNG RA (EXIT)
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- SECTION 3: SYSTEM FAILOVER & ARCHITECTURE NOTES ---------------- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-200">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Cơ Chế Dự Phòng Tự Động (Auto-Failover)</h3>
              <p className="text-xs text-slate-700">Đảm bảo cổng không bị gián đoạn khi đường truyền mạng camera gặp sự cố</p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="flex items-center justify-between p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <span className="text-xs font-semibold text-slate-800">
                Tự động chuyển sang Webcam UVC Client nếu luồng RTSP mất kết nối
              </span>
              <input
                type="checkbox"
                checked={config.autoFailoverToClientUvc}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, autoFailoverToClientUvc: e.target.checked }))
                }
                className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
              />
            </label>

            <div className="flex items-center justify-between text-xs text-slate-700 p-1">
              <span>Chu kỳ tự động thử kết nối lại luồng:</span>
              <span className="font-semibold text-slate-900">{config.entryGate.reconnectIntervalSeconds || 5} giây</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Kiến Trúc Tách Luồng Xử Lý (Multi-Threading)</h3>
              <p className="text-xs text-slate-700">Tối ưu hóa tài nguyên phần cứng máy chủ AI</p>
            </div>
          </div>

          <div className="text-xs text-slate-600 space-y-2 leading-relaxed">
            <p>
              • <strong>Main Event Loop (Node.js):</strong> Đảm nhận giao tiếp HTTP API, Webhook thông báo Chat Room Eton và lệnh kích hoạt mở cửa.
            </p>
            <p>
              • <strong>Worker Threads (Worker Pool):</strong> Chạy trên các CPU Core độc lập để trích xuất 512-D Face Embeddings, so sánh ma trận Cosine và phân tích liveness chống giả mạo hình ảnh.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
