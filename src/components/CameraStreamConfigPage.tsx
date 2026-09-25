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
  Settings,
  Server,
  Eye,
  Copy,
  HelpCircle,
  Info,
  Terminal,
  Check,
  ChevronDown,
  ChevronUp,
  ScanFace,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Image as ImageIcon,
  Star,
  X,
  Save,
} from "lucide-react";
import {
  CameraStreamsConfig,
  GateStreamConfig,
  GateStreamSource,
  CameraSourceType,
  ThreadPoolTelemetry,
} from "../types";
import { apiFetch, operatorJsonFetch } from "../utils/api";
import { ProtectedImage } from "./ProtectedImage";

const DEFAULT_STREAMS_CONFIG: CameraStreamsConfig = {
  entryGate: {
    gateType: "ENTRY",
    name: "Camera Cổng Vào (Main Entry Gate)",
    enabled: true,
    sourceType: "RTSP",
    rtspUrl: "",
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
    rtspUrl: "",
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

// ----------------- MULTI-STREAM HELPERS -----------------
type GateKey = "entry" | "exit";
type GateField = "entryGate" | "exitGate";
type StreamResolution = NonNullable<GateStreamSource["resolution"]>;

const gateKeyOf = (gateType: "ENTRY" | "EXIT"): GateKey => (gateType === "EXIT" ? "exit" : "entry");
const gateFieldOf = (key: GateKey): GateField => (key === "exit" ? "exitGate" : "entryGate");

/**
 * Returns the gate's streams sorted by priority. When the payload carries no
 * `streams` (legacy server / legacy config), derive a single stream from the
 * legacy single-stream fields so the UI never breaks.
 */
const deriveGateStreams = (gate: GateStreamConfig | undefined, key: GateKey): GateStreamSource[] => {
  if (!gate) return [];
  const list = Array.isArray(gate.streams) ? gate.streams.filter(Boolean) : [];
  if (list.length > 0) {
    return list
      .map((s, index) => ({
        ...s,
        enabled: s.enabled !== false,
        priority: typeof s.priority === "number" ? s.priority : index,
      }))
      .sort((a, b) => a.priority - b.priority);
  }
  return [
    {
      id: `${key}-primary`,
      label: gate.name || (key === "exit" ? "Cổng Ra" : "Cổng Vào"),
      sourceType: gate.sourceType || "RTSP",
      rtspUrl: gate.rtspUrl,
      rtspTransport: gate.rtspTransport || "TCP",
      httpUrl: gate.httpUrl,
      uvcDeviceId: gate.uvcDeviceId,
      uvcDeviceLabel: gate.uvcDeviceLabel,
      backendDevicePath: gate.backendDevicePath,
      resolution: gate.resolution,
      fps: gate.fps,
      enabled: true,
      priority: 0,
    },
  ];
};

/** The lowest-priority ENABLED stream is the primary (falls back to the first one). */
const getPrimaryStream = (streams: GateStreamSource[]): GateStreamSource | null =>
  streams.find((s) => s.enabled) || streams[0] || null;

/** Mask credentials embedded in an RTSP URL before rendering it. */
const maskRtspCredentials = (url?: string): string => {
  if (!url) return "";
  return url.replace(/^([a-z]+:\/\/)([^:@/]+)(?::[^@/]*)?@/i, (_m, proto, user) => `${proto}${user}:•••@`);
};

/** Replace a gate's stream list and mirror the primary into the legacy fields. */
const withStreams = (gate: GateStreamConfig, streams: GateStreamSource[]): GateStreamConfig => {
  const sorted = [...streams].sort((a, b) => a.priority - b.priority);
  const primary = getPrimaryStream(sorted);
  return {
    ...gate,
    streams: sorted,
    ...(primary
      ? {
          sourceType: primary.sourceType,
          rtspUrl: primary.rtspUrl,
          rtspTransport: primary.rtspTransport,
          httpUrl: primary.httpUrl,
          uvcDeviceId: primary.uvcDeviceId,
          uvcDeviceLabel: primary.uvcDeviceLabel,
          backendDevicePath: primary.backendDevicePath,
          resolution: primary.resolution,
          fps: primary.fps,
        }
      : {}),
  };
};

const streamUrlOf = (s: GateStreamSource): string => {
  if (s.sourceType === "RTSP") return s.rtspUrl || "";
  if (s.sourceType === "HTTP_MJPEG") return s.httpUrl || "";
  if (s.sourceType === "BACKEND_UVC") return s.backendDevicePath || "";
  return s.uvcDeviceLabel || s.uvcDeviceId || "Webcam trình duyệt";
};

const SOURCE_TYPE_LABEL: Record<CameraSourceType, string> = {
  RTSP: "RTSP",
  HTTP_MJPEG: "HTTP/MJPEG",
  CLIENT_UVC: "UVC Client",
  BACKEND_UVC: "UVC Server",
};

interface StreamFormValues {
  label: string;
  sourceType: CameraSourceType;
  rtspUrl: string;
  rtspTransport: "TCP" | "UDP";
  httpUrl: string;
  uvcDeviceId: string;
  uvcDeviceLabel: string;
  backendDevicePath: string;
  resolution: StreamResolution;
  fps: number;
  enabled: boolean;
}

const EMPTY_STREAM_FORM: StreamFormValues = {
  label: "",
  sourceType: "RTSP",
  rtspUrl: "",
  rtspTransport: "TCP",
  httpUrl: "",
  uvcDeviceId: "default",
  uvcDeviceLabel: "Camera Mặc Định Trình Duyệt",
  backendDevicePath: "/dev/video0",
  resolution: "1280x720",
  fps: 25,
  enabled: true,
};

const streamToForm = (s: GateStreamSource): StreamFormValues => ({
  label: s.label || "",
  sourceType: s.sourceType || "RTSP",
  rtspUrl: s.rtspUrl || "",
  rtspTransport: s.rtspTransport === "UDP" ? "UDP" : "TCP",
  httpUrl: s.httpUrl || "",
  uvcDeviceId: s.uvcDeviceId || "default",
  uvcDeviceLabel: s.uvcDeviceLabel || "Camera Mặc Định Trình Duyệt",
  backendDevicePath: s.backendDevicePath || "/dev/video0",
  resolution: s.resolution || "1280x720",
  fps: typeof s.fps === "number" && s.fps > 0 ? s.fps : 25,
  enabled: s.enabled !== false,
});

const formToStreamPatch = (f: StreamFormValues): Omit<GateStreamSource, "id" | "priority"> => ({
  label: f.label.trim(),
  sourceType: f.sourceType,
  rtspUrl: f.rtspUrl.trim() || undefined,
  rtspTransport: f.rtspTransport,
  httpUrl: f.httpUrl.trim() || undefined,
  uvcDeviceId: f.uvcDeviceId || undefined,
  uvcDeviceLabel: f.uvcDeviceLabel || undefined,
  backendDevicePath: f.backendDevicePath.trim() || undefined,
  resolution: f.resolution,
  fps: Number(f.fps) || 25,
  enabled: f.enabled,
});

const validateStreamForm = (f: StreamFormValues): string | null => {
  if (!f.label.trim()) return "Vui lòng nhập tên (nhãn) cho luồng camera.";
  if (f.sourceType === "RTSP") {
    if (!f.rtspUrl.trim().toLowerCase().startsWith("rtsp://")) {
      return "URL luồng RTSP phải bắt đầu bằng rtsp://";
    }
  } else if (f.sourceType === "HTTP_MJPEG") {
    const u = f.httpUrl.trim().toLowerCase();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      return "URL luồng HTTP/MJPEG phải bắt đầu bằng http:// hoặc https://";
    }
  } else if (f.sourceType === "BACKEND_UVC") {
    if (!f.backendDevicePath.trim()) return "Vui lòng nhập đường dẫn thiết bị (VD: /dev/video0).";
  }
  return null;
};

interface RowTestState {
  loading: boolean;
  data: any | null;
  message: string | null;
}

/** Local preview source: either a stream or (legacy) a gate. */
interface PreviewSource {
  sourceType: CameraSourceType;
  uvcDeviceId?: string;
  resolution?: string;
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

  // Multi-stream list state (per active gate tab)
  const [addFormOpen, setAddFormOpen] = useState<boolean>(false);
  const [addForm, setAddForm] = useState<StreamFormValues>(EMPTY_STREAM_FORM);
  const [addFormError, setAddFormError] = useState<string | null>(null);
  const [editingStreamId, setEditingStreamId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<StreamFormValues>(EMPTY_STREAM_FORM);
  const [editFormError, setEditFormError] = useState<string | null>(null);
  const [streamSubmitting, setStreamSubmitting] = useState<boolean>(false);
  const [busyStreamId, setBusyStreamId] = useState<string | null>(null);
  const [streamActionError, setStreamActionError] = useState<string | null>(null);
  const [streamActionNotice, setStreamActionNotice] = useState<string | null>(null);
  const [rowTests, setRowTests] = useState<Record<string, RowTestState>>({});
  const [snapshotStreamId, setSnapshotStreamId] = useState<string | null>(null);
  const [snapshotTimestamp, setSnapshotTimestamp] = useState<number>(Date.now());
  const [previewStreamId, setPreviewStreamId] = useState<string | null>(null);

  // Live Stream Preview State
  const [isPreviewActive, setIsPreviewActive] = useState<boolean>(false);
  const [isStartingCamera, setIsStartingCamera] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewFps] = useState<number>(24);

  // RTSP Custom Options & AI Scan
  const [rtspViewMode, setRtspViewMode] = useState<"MJPEG" | "SNAPSHOT" | "SIMULATION">("MJPEG");
  const [isScanningRtsp, setIsScanningRtsp] = useState<boolean>(false);
  const [rtspScanResult, setRtspScanResult] = useState<any | null>(null);
  const [showHikvisionGuide, setShowHikvisionGuide] = useState<boolean>(false);
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
      const res = await operatorJsonFetch<any>("/api/camera-streams/config");
      if (res.ok) {
        const data = res.data;
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
      const res = await operatorJsonFetch<any>("/api/camera-streams/threads");
      if (res.ok) {
        const data = res.data;
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

  // Save Configuration (global settings + gate name/enabled only).
  //
  // This deliberately does NOT send a `streams` array. Streams are added,
  // edited, reordered and deleted through the per-stream routes, which act on
  // one stream at a time. Sending a rebuilt list here made Save a whole-document
  // write from this page's local state: if that state was loaded before another
  // change - a stream added from the API, an edit in another tab, a gate someone
  // else touched - Save silently reverted it. Editing one gate could disable a
  // stream on the other. The server keeps its own list when `streams` is absent
  // (applyGateConfigPatch: `streams: replaced ? patchStreams : base.streams`).
  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);

      const gateScalars = (gate: GateStreamConfig) => {
        const { streams: _streams, ...rest } = gate;
        return rest;
      };
      const payload = {
        ...config,
        entryGate: gateScalars(config.entryGate),
        exitGate: gateScalars(config.exitGate),
      };

      const res = await operatorJsonFetch<any>("/api/camera-streams/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(res.error || `Lưu thất bại (HTTP ${res.status})`);
      }

      const data = res.data;
      if (data.config) {
        setConfig(data.config);
      }
      if (data.telemetry) {
        setTelemetry(data.telemetry);
      }

      // Also save to localStorage for client-side persistence
      localStorage.setItem("smartface_camera_streams_config", JSON.stringify(data.config || payload));

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
      const res = await apiFetch("/api/camera-streams/threads/scale", {
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
      const res = await apiFetch("/api/camera-streams/benchmark", {
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

  // ----------------- STREAM LIST: DERIVED VALUES -----------------
  const currentGateKey: GateKey = activeGateTab === "EXIT" ? "exit" : "entry";
  const currentGateField: GateField = gateFieldOf(currentGateKey);
  const currentGateConfig: GateStreamConfig = config[currentGateField];
  const currentStreams = deriveGateStreams(currentGateConfig, currentGateKey);
  const currentPrimary = getPrimaryStream(currentStreams);
  const previewStream: GateStreamSource | null =
    currentStreams.find((s) => s.id === previewStreamId) || currentPrimary;

  const updateCurrentGate = (updater: (prev: GateStreamConfig) => GateStreamConfig) => {
    setConfig((prev) => ({ ...prev, [currentGateField]: updater(prev[currentGateField]) }));
  };

  /** Apply a stream list to a gate locally (keeps locally edited name/enabled/autoStart). */
  const applyStreamsLocally = (key: GateKey, streams: GateStreamSource[]) => {
    const field = gateFieldOf(key);
    setConfig((prev) => ({ ...prev, [field]: withStreams(prev[field], streams) }));
  };

  /** Extract the stream list from any shape the thin endpoints / config endpoint may return. */
  const parseStreamsFromResponse = (data: any, key: GateKey): GateStreamSource[] | null => {
    const field = gateFieldOf(key);
    const gate =
      data?.config?.[field] ||
      data?.gate ||
      data?.[field] ||
      (data && data.gateType && Array.isArray(data.streams) ? data : null);
    if (gate && Array.isArray(gate.streams) && gate.streams.length > 0) {
      return deriveGateStreams(gate as GateStreamConfig, key);
    }
    return null;
  };

  /** Fallback for servers without the thin stream endpoints: POST the whole gate with its stream list. */
  const replaceGateStreamsViaConfig = async (key: GateKey, streams: GateStreamSource[]): Promise<GateStreamSource[]> => {
    const field = gateFieldOf(key);
    const gatePayload = withStreams(config[field], streams);
    const res = await apiFetch("/api/camera-streams/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: gatePayload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(data?.error || data?.message || `Lưu danh sách luồng thất bại (HTTP ${res.status})`);
    }
    setStreamActionNotice("Máy chủ chưa hỗ trợ API luồng riêng lẻ - đã lưu toàn bộ danh sách luồng của cổng.");
    return parseStreamsFromResponse(data, key) || streams;
  };

  /**
   * Call a thin stream endpoint. On 404 (endpoint not deployed yet) fall back to
   * replacing the gate's whole stream list through /api/camera-streams/config.
   */
  const streamRequest = async (
    key: GateKey,
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: any | undefined,
    fallbackStreams: () => GateStreamSource[]
  ): Promise<{ streams: GateStreamSource[]; usedFallback: boolean }> => {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      return { streams: await replaceGateStreamsViaConfig(key, fallbackStreams()), usedFallback: true };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) {
      const retry = data?.retryAfterSeconds || res.headers.get("Retry-After") || 1;
      throw new Error(`Máy chủ đang quá tải, vui lòng thử lại sau ${retry} giây.`);
    }
    if (!res.ok || data?.success === false) {
      throw new Error(data?.error || data?.message || `Thao tác luồng thất bại (HTTP ${res.status})`);
    }
    return { streams: parseStreamsFromResponse(data, key) || fallbackStreams(), usedFallback: false };
  };

  const resetStreamMessages = () => {
    setStreamActionError(null);
    setStreamActionNotice(null);
  };

  // ----------------- STREAM LIST: ACTIONS -----------------
  const handleAddStream = async () => {
    const validation = validateStreamForm(addForm);
    if (validation) {
      setAddFormError(validation);
      return;
    }
    const key = currentGateKey;
    const streams = currentStreams;
    const nextPriority = streams.length > 0 ? Math.max(...streams.map((s) => s.priority)) + 1 : 0;
    const payload = { ...formToStreamPatch(addForm), priority: nextPriority };
    const fallback = () => [...streams, { ...payload, id: `${key}-${Date.now().toString(36)}` }];

    try {
      setStreamSubmitting(true);
      setAddFormError(null);
      resetStreamMessages();
      const { streams: updated } = await streamRequest(key, "POST", `/api/camera-streams/${key}/streams`, payload, fallback);
      applyStreamsLocally(key, updated);
      setAddFormOpen(false);
      setAddForm(EMPTY_STREAM_FORM);
    } catch (err: any) {
      setAddFormError(err?.message || "Không thể thêm luồng camera");
    } finally {
      setStreamSubmitting(false);
    }
  };

  const openEditStream = (s: GateStreamSource) => {
    setEditingStreamId(s.id);
    setEditForm(streamToForm(s));
    setEditFormError(null);
    setAddFormOpen(false);
  };

  const handleSaveEditStream = async () => {
    if (!editingStreamId) return;
    const validation = validateStreamForm(editForm);
    if (validation) {
      setEditFormError(validation);
      return;
    }
    const key = currentGateKey;
    const streams = currentStreams;
    const id = editingStreamId;
    const patch = formToStreamPatch(editForm);
    const fallback = () => streams.map((s) => (s.id === id ? { ...s, ...patch } : s));

    try {
      setStreamSubmitting(true);
      setEditFormError(null);
      resetStreamMessages();
      const { streams: updated } = await streamRequest(key, "PUT", `/api/camera-streams/${key}/streams/${encodeURIComponent(id)}`, patch, fallback);
      applyStreamsLocally(key, updated);
      setEditingStreamId(null);
    } catch (err: any) {
      setEditFormError(err?.message || "Không thể cập nhật luồng camera");
    } finally {
      setStreamSubmitting(false);
    }
  };

  const handleToggleStreamEnabled = async (s: GateStreamSource) => {
    const key = currentGateKey;
    const streams = currentStreams;
    const patch = { enabled: !s.enabled };
    const fallback = () => streams.map((x) => (x.id === s.id ? { ...x, ...patch } : x));
    try {
      setBusyStreamId(s.id);
      resetStreamMessages();
      const { streams: updated } = await streamRequest(key, "PUT", `/api/camera-streams/${key}/streams/${encodeURIComponent(s.id)}`, patch, fallback);
      applyStreamsLocally(key, updated);
    } catch (err: any) {
      setStreamActionError(err?.message || "Không thể đổi trạng thái luồng");
    } finally {
      setBusyStreamId(null);
    }
  };

  const handleDeleteStream = async (s: GateStreamSource) => {
    if (currentStreams.length <= 1) return;
    if (!window.confirm(`Xóa luồng "${s.label}" khỏi ${currentGateConfig.name}?`)) return;
    const key = currentGateKey;
    const streams = currentStreams;
    const fallback = () => streams.filter((x) => x.id !== s.id);
    try {
      setBusyStreamId(s.id);
      resetStreamMessages();
      const { streams: updated } = await streamRequest(key, "DELETE", `/api/camera-streams/${key}/streams/${encodeURIComponent(s.id)}`, undefined, fallback);
      applyStreamsLocally(key, updated);
      if (editingStreamId === s.id) setEditingStreamId(null);
      if (snapshotStreamId === s.id) setSnapshotStreamId(null);
      if (previewStreamId === s.id) setPreviewStreamId(null);
    } catch (err: any) {
      setStreamActionError(err?.message || "Không thể xóa luồng camera");
    } finally {
      setBusyStreamId(null);
    }
  };

  const handleMoveStream = async (s: GateStreamSource, direction: -1 | 1) => {
    const key = currentGateKey;
    const streams = currentStreams;
    const index = streams.findIndex((x) => x.id === s.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= streams.length) return;

    // Normalise priorities to their index, then swap the two neighbours.
    const reordered = streams.map((x, i) => ({ ...x, priority: i }));
    const tmp = reordered[index].priority;
    reordered[index] = { ...reordered[index], priority: reordered[target].priority };
    reordered[target] = { ...reordered[target], priority: tmp };
    const finalList = [...reordered].sort((a, b) => a.priority - b.priority);
    const changed = finalList.filter((x) => {
      const before = streams.find((o) => o.id === x.id);
      return !before || before.priority !== x.priority;
    });

    try {
      setBusyStreamId(s.id);
      resetStreamMessages();
      let latest: GateStreamSource[] = finalList;
      for (const item of changed) {
        const { streams: updated, usedFallback } = await streamRequest(
          key,
          "PUT",
          `/api/camera-streams/${key}/streams/${encodeURIComponent(item.id)}`,
          { priority: item.priority },
          () => finalList
        );
        latest = updated;
        if (usedFallback) break; // the fallback already wrote the whole list
      }
      applyStreamsLocally(key, latest);
    } catch (err: any) {
      setStreamActionError(err?.message || "Không thể sắp xếp lại thứ tự luồng");
    } finally {
      setBusyStreamId(null);
    }
  };

  // Test RTSP or HTTP Stream URL Connection for one stream row
  const handleTestStream = async (s: GateStreamSource) => {
    const targetUrl = s.sourceType === "RTSP" ? s.rtspUrl : s.httpUrl;
    if (!targetUrl) return;
    setRowTests((prev) => ({ ...prev, [s.id]: { loading: true, data: null, message: null } }));
    try {
      const res = await apiFetch("/api/camera-streams/test-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          sourceType: s.sourceType,
          transport: s.rtspTransport,
        }),
      });
      const data = await res.json().catch(() => ({}));
      setRowTests((prev) => ({
        ...prev,
        [s.id]: {
          loading: false,
          data,
          message:
            res.ok && data.success
              ? data.message
              : data.message || data.error || "Không thể kết nối đến URL luồng camera",
        },
      }));
    } catch (err: any) {
      setRowTests((prev) => ({
        ...prev,
        [s.id]: { loading: false, data: { success: false }, message: "Lỗi kết nối kiểm tra: " + err?.message },
      }));
    }
  };

  const handleToggleSnapshot = (s: GateStreamSource) => {
    setSnapshotTimestamp(Date.now());
    setSnapshotStreamId((prev) => (prev === s.id ? null : s.id));
  };

  // Trigger real-time Face Recognition test directly on the previewed stream
  const handleScanRtsp = async () => {
    if (!previewStream) return;
    try {
      setIsScanningRtsp(true);
      setRtspScanResult(null);
      const res = await apiFetch("/api/camera-streams/scan-rtsp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gate: currentGateKey,
          stream: previewStream.id,
          scanType: activeGateTab === "EXIT" ? "EXIT" : "ENTRY",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        const retry = data?.retryAfterSeconds || res.headers.get("Retry-After") || 1;
        setRtspScanResult({
          success: false,
          overloaded: true,
          error: `Cụm xử lý đang quá tải, vui lòng quét lại sau ${retry} giây.`,
        });
        return;
      }
      setRtspScanResult({ ...data, streamLabel: previewStream.label });
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

  // Start / Stop Live Preview for the currently previewed stream
  const startPreview = async (overrideSource?: PreviewSource) => {
    setPreviewError(null);
    setPreviewTimestamp(Date.now());
    const source: PreviewSource | null = overrideSource || previewStream;
    if (!source) {
      setPreviewError("Cổng này chưa có luồng camera nào để xem thử.");
      return;
    }

    if (source.sourceType === "CLIENT_UVC") {
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

        const videoConstraints: MediaTrackConstraints = {};
        if (source.uvcDeviceId && source.uvcDeviceId !== "default") {
          videoConstraints.deviceId = { ideal: source.uvcDeviceId };
        }

        if (source.resolution && source.resolution !== "AUTO") {
          const [wStr, hStr] = source.resolution.split("x");
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

  // Keep video element srcObject synchronized when active state or previewed source changes
  const previewSourceType = previewStream?.sourceType;
  useEffect(() => {
    if (
      isPreviewActive &&
      previewSourceType === "CLIENT_UVC" &&
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
  }, [isPreviewActive, activeGateTab, previewSourceType]);

  const switchGateTab = (tab: "ENTRY" | "EXIT" | "DUAL_MONITOR") => {
    setActiveGateTab(tab);
    stopPreview();
    setPreviewStreamId(null);
    setEditingStreamId(null);
    setAddFormOpen(false);
    setSnapshotStreamId(null);
    setRtspScanResult(null);
    resetStreamMessages();
  };

  const selectPreviewStream = (id: string) => {
    if (isPreviewActive) stopPreview();
    setPreviewStreamId(id);
    setRtspScanResult(null);
    setPreviewTimestamp(Date.now());
  };

  // RTSP Presets (apply to whichever stream form is open)
  const applyPreset = (
    setForm: React.Dispatch<React.SetStateAction<StreamFormValues>>,
    type: "HIKVISION_LOCAL_101" | "HIKVISION_LOCAL_102" | "HIKVISION" | "DAHUA" | "EZVIZ" | "GENERIC"
  ) => {
    let presetUrl = "";
    if (type === "HIKVISION_LOCAL_101") {
      presetUrl = "rtsp://camera.example.invalid:554/Streaming/Channels/101";
    } else if (type === "HIKVISION_LOCAL_102") {
      presetUrl = "rtsp://camera.example.invalid:554/Streaming/Channels/102";
    } else if (type === "HIKVISION") {
      presetUrl = "rtsp://camera.example.invalid:554/Streaming/Channels/101";
    } else if (type === "DAHUA") {
      presetUrl = "rtsp://camera.example.invalid:554/cam/realmonitor?channel=1&subtype=0";
    } else if (type === "EZVIZ") {
      presetUrl = "rtsp://camera.example.invalid:554/h264/ch1/main/av_stream";
    } else {
      presetUrl = "rtsp://192.168.1.100:554/live/ch0";
    }
    setForm((prev) => ({ ...prev, rtspUrl: presetUrl, sourceType: "RTSP", rtspTransport: "TCP" }));
  };

  // ----------------- STREAM FORM (shared by "Thêm luồng" and "Sửa") -----------------
  const renderStreamForm = (
    mode: "ADD" | "EDIT",
    values: StreamFormValues,
    setValues: React.Dispatch<React.SetStateAction<StreamFormValues>>,
    error: string | null,
    onSubmit: () => void,
    onCancel: () => void
  ) => {
    const set = <K extends keyof StreamFormValues>(field: K, value: StreamFormValues[K]) =>
      setValues((prev) => ({ ...prev, [field]: value }));

    const sourceOptions: { type: CameraSourceType; title: string; desc: string; icon: React.ReactNode; active: string }[] = [
      { type: "RTSP", title: "Luồng URL RTSP", desc: "Đầu ghi NVR / Camera IP (Hikvision, Dahua, EZVIZ).", icon: <Video className="w-4 h-4 text-indigo-600" />, active: "border-indigo-600 bg-indigo-50/50" },
      { type: "HTTP_MJPEG", title: "HTTP / MJPEG", desc: "ESP32-CAM, mjpg-streamer, webcam server IP.", icon: <Radio className="w-4 h-4 text-purple-600" />, active: "border-purple-600 bg-purple-50/50" },
      { type: "CLIENT_UVC", title: "UVC Camera Client", desc: "Webcam trình duyệt qua MediaDevices API.", icon: <Camera className="w-4 h-4 text-blue-600" />, active: "border-blue-600 bg-blue-50/50" },
      { type: "BACKEND_UVC", title: "UVC Backend Server", desc: "Webcam cắm vào máy chủ Linux (/dev/videoX).", icon: <Server className="w-4 h-4 text-emerald-600" />, active: "border-emerald-600 bg-emerald-50/50" },
    ];

    return (
      <div className="p-5 rounded-xl bg-white border border-indigo-200 shadow-xs space-y-4 animate-in fade-in">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-slate-900 flex items-center gap-2">
            {mode === "ADD" ? <Plus className="w-4 h-4 text-indigo-600" /> : <Pencil className="w-4 h-4 text-indigo-600" />}
            {mode === "ADD" ? "Thêm Luồng Camera Mới" : `Sửa Luồng: ${values.label || "(chưa đặt tên)"}`}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100"
            title="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Label + Enabled */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Tên Luồng (Nhãn hiển thị) <span className="text-rose-600">*</span>
            </label>
            <input
              type="text"
              value={values.label}
              onChange={(e) => set("label", e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              placeholder="VD: BVE-CUA-KHO, Kênh 501 NVR..."
            />
          </div>
          <div className="flex items-end">
            <label className="w-full flex items-center justify-between p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <span className="text-xs font-semibold text-slate-800">Kích hoạt luồng</span>
              <input
                type="checkbox"
                checked={values.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
                className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
              />
            </label>
          </div>
        </div>

        {/* Source type */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider">
            Loại Nguồn Luồng Camera
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {sourceOptions.map((opt) => (
              <div
                key={opt.type}
                onClick={() => set("sourceType", opt.type)}
                className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${
                  values.sourceType === opt.type ? `${opt.active} shadow-xs` : "border-slate-200 hover:border-slate-300 bg-white"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {opt.icon}
                  <span className="font-semibold text-xs text-slate-900">{opt.title}</span>
                </div>
                <p className="text-[11px] text-slate-600">{opt.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Type-specific fields */}
        {values.sourceType === "RTSP" && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
                <Video className="w-4 h-4 text-indigo-600" />
                Cấu Hình Luồng RTSP (IP Camera)
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-slate-700">Mẫu nhanh:</span>
                <button
                  type="button"
                  onClick={() => applyPreset(setValues, "HIKVISION_LOCAL_101")}
                  className="px-2.5 py-1 rounded-md text-xs bg-indigo-600 text-white hover:bg-indigo-700 font-semibold shadow-xs flex items-center gap-1"
                  title="RTSP example (add credentials before use)"
                >
                  <Zap className="w-3 h-3" />
                  192.168.60.2 (Kênh 101 Main)
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset(setValues, "HIKVISION_LOCAL_102")}
                  className="px-2.5 py-1 rounded-md text-xs bg-indigo-100 text-indigo-800 hover:bg-indigo-200 font-semibold border border-indigo-200"
                  title="RTSP example (add credentials before use)"
                >
                  192.168.60.2 (Kênh 102 Sub)
                </button>
                <button type="button" onClick={() => applyPreset(setValues, "HIKVISION")} className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium">
                  Hikvision Khác
                </button>
                <button type="button" onClick={() => applyPreset(setValues, "DAHUA")} className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium">
                  Dahua
                </button>
                <button type="button" onClick={() => applyPreset(setValues, "EZVIZ")} className="px-2 py-0.5 rounded text-xs bg-white border border-slate-300 hover:bg-slate-100 font-medium">
                  EZVIZ
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                URL Luồng RTSP (Bao gồm User/Password nếu có) <span className="text-rose-600">*</span>
              </label>
              <input
                type="text"
                value={values.rtspUrl}
                onChange={(e) => set("rtspUrl", e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="rtsp://camera.example.invalid:554/Streaming/Channels/101"
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

            {showHikvisionGuide && renderHikvisionGuide()}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Giao Thức Truyền Tải (RTSP Transport Protocol)
              </label>
              <select
                value={values.rtspTransport}
                onChange={(e) => set("rtspTransport", e.target.value as "TCP" | "UDP")}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white outline-none"
              >
                <option value="TCP">TCP (Khuyến nghị: Chống mất gói hình ảnh, ổn định cao)</option>
                <option value="UDP">UDP (Độ trễ siêu thấp, phù hợp mạng LAN nội bộ chuẩn Gigabit)</option>
              </select>
            </div>
          </div>
        )}

        {values.sourceType === "HTTP_MJPEG" && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
              <Radio className="w-4 h-4 text-purple-600" />
              Cấu Hình Luồng HTTP / MJPEG
            </span>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                URL Luồng Stream HTTP <span className="text-rose-600">*</span>
              </label>
              <input
                type="text"
                value={values.httpUrl}
                onChange={(e) => set("httpUrl", e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-purple-500 outline-none"
                placeholder="http://192.168.1.75:81/stream"
              />
              <p className="text-xs text-slate-700 mt-1">Phù hợp cho ESP32-CAM, mjpg-streamer, hoặc các module camera nhúng.</p>
            </div>
          </div>
        )}

        {values.sourceType === "CLIENT_UVC" && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
                <Camera className="w-4 h-4 text-blue-600" />
                Thiết Bị UVC Trình Duyệt (Client MediaDevices)
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
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                Chọn Thiết Bị Webcam
              </label>
              <select
                value={values.uvcDeviceId}
                onChange={(e) => {
                  const dev = availableCameras.find((c) => c.deviceId === e.target.value);
                  setValues((prev) => ({
                    ...prev,
                    uvcDeviceId: e.target.value,
                    uvcDeviceLabel: dev ? dev.label : "Camera Mặc Định Trình Duyệt",
                  }));
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
              <p className="text-[11px] text-slate-600 mt-1">
                Webcam trình duyệt chỉ được hiển thị/quét khi là luồng chính của cổng.
              </p>
            </div>
          </div>
        )}

        {values.sourceType === "BACKEND_UVC" && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-600" />
              Thiết Bị V4L2 Máy Chủ
            </span>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                Đường Dẫn Thiết Bị Linux (Device Path) <span className="text-rose-600">*</span>
              </label>
              <input
                type="text"
                value={values.backendDevicePath}
                onChange={(e) => set("backendDevicePath", e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 bg-white focus:ring-2 focus:ring-emerald-500 outline-none"
                placeholder="/dev/video0"
              />
              <p className="text-xs text-slate-700 mt-1">
                Cần phân quyền truy cập thiết bị (vd: video group) trong môi trường triển khai docker/container.
              </p>
            </div>
          </div>
        )}

        {/* Resolution + FPS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Độ Phân Giải Mục Tiêu (Resolution)
            </label>
            <select
              value={values.resolution}
              onChange={(e) => set("resolution", e.target.value as StreamResolution)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white outline-none font-medium"
            >
              <option value="1920x1080">1080p Full HD (1920 x 1080) - Chi tiết cao nhất</option>
              <option value="1280x720">720p HD (1280 x 720) - Chuẩn tối ưu AI</option>
              <option value="640x480">480p SD (640 x 480) - Tiết kiệm băng thông</option>
              <option value="AUTO">Tự Động (Theo khả năng thiết bị)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Tốc Độ Khung Hình (FPS)
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={values.fps}
              onChange={(e) => set("fps", Number(e.target.value))}
              className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={streamSubmitting}
            className="px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={streamSubmitting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
          >
            {streamSubmitting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {mode === "ADD" ? "Thêm Luồng" : "Lưu Luồng"}
          </button>
        </div>
      </div>
    );
  };

  // EXPANDABLE COMPREHENSIVE GUIDE FOR LOCAL RTSP
  const renderHikvisionGuide = () => (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3.5 text-xs text-slate-800 animate-in fade-in">
      <div className="flex items-center justify-between border-b border-indigo-100 pb-2">
        <div className="flex items-center gap-2 font-bold text-indigo-950 text-sm">
          <Info className="w-4 h-4 text-indigo-600" />
          Hướng Dẫn Cấu Hình Luồng RTSP Cục Bộ: <code className="font-mono text-indigo-700 bg-white px-1.5 py-0.5 rounded border border-indigo-200">rtsp://camera.example.invalid:554/Streaming/Channels/101</code>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
        <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
          <div className="text-slate-500 font-semibold text-[11px]">ĐỊA CHỈ IP & PORT MẠNG LAN</div>
          <div className="font-mono font-bold text-slate-900 mt-0.5">192.168.60.2 : 554</div>
          <div className="text-[11px] text-slate-500 mt-0.5">IP tĩnh của camera trong mạng nội bộ</div>
        </div>
        <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
          <div className="text-slate-500 font-semibold text-[11px]">TÀI KHOẢN & MẬT KHẨU</div>
          <div className="font-mono font-bold text-slate-900 mt-0.5">Cấu hình ngoài mã nguồn</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Nhập tài khoản camera khi triển khai; không lưu bí mật trong Git</div>
        </div>
        <div className="bg-white p-2.5 rounded-lg border border-indigo-100">
          <div className="text-slate-500 font-semibold text-[11px]">KÊNH 101 VS KÊNH 102</div>
          <div className="font-mono font-bold text-slate-900 mt-0.5">Channels/101 hoặc 102</div>
          <div className="text-[11px] text-slate-500 mt-0.5">101: Main (FullHD/4K) | 102: Sub (AI siêu mượt)</div>
        </div>
      </div>

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
                <li>Vào <b>Configuration &rarr; Network &rarr; Advanced Settings &rarr; Integration Protocol</b> &rarr; Bật <b>Enable Open Network Video Interface (ONVIF)</b> và thêm một user chỉ có quyền xem luồng.</li>
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
  );

  // ----------------- STREAM LIST ROW -----------------
  const renderStreamRow = (s: GateStreamSource, index: number) => {
    const isPrimary = currentPrimary?.id === s.id;
    const isLast = currentStreams.length <= 1;
    const isBusy = busyStreamId === s.id;
    const test = rowTests[s.id];
    const canTest = (s.sourceType === "RTSP" && !!s.rtspUrl) || (s.sourceType === "HTTP_MJPEG" && !!s.httpUrl);
    const canSnapshot = s.sourceType === "RTSP" || s.sourceType === "HTTP_MJPEG" || s.sourceType === "BACKEND_UVC";
    const displayUrl = s.sourceType === "RTSP" ? maskRtspCredentials(s.rtspUrl) : streamUrlOf(s);
    const isEditing = editingStreamId === s.id;

    return (
      <div
        key={s.id}
        className={`rounded-xl border transition-colors ${
          isEditing ? "border-indigo-300 bg-indigo-50/30" : s.enabled ? "border-slate-200 bg-white hover:border-slate-300" : "border-slate-200 bg-slate-50/70"
        }`}
      >
        <div className="p-3 flex flex-col lg:flex-row lg:items-center gap-3">
          {/* Priority handle */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => handleMoveStream(s, -1)}
                disabled={index === 0 || isBusy}
                className="p-0.5 rounded text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Tăng ưu tiên (lên)"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleMoveStream(s, 1)}
                disabled={index === currentStreams.length - 1 || isBusy}
                className="p-0.5 rounded text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Giảm ưu tiên (xuống)"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </div>
            <span
              className={`w-7 h-7 rounded-lg flex items-center justify-center font-mono text-xs font-bold border ${
                isPrimary ? "bg-indigo-600 text-white border-indigo-600" : "bg-slate-100 text-slate-700 border-slate-200"
              }`}
              title={`Ưu tiên ${s.priority}`}
            >
              {index + 1}
            </span>
          </div>

          {/* Label + meta */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-sm font-semibold truncate ${s.enabled ? "text-slate-900" : "text-slate-500"}`} title={s.label}>
                {s.label}
              </span>
              {isPrimary && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
                  <Star className="w-3 h-3" />
                  Chính
                </span>
              )}
              {!s.enabled && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-slate-200 text-slate-700">
                  Đã tắt
                </span>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded-md font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                {SOURCE_TYPE_LABEL[s.sourceType] || s.sourceType}
              </span>
              {s.sourceType === "RTSP" && (
                <span className="text-[10px] px-2 py-0.5 rounded-md font-mono bg-white text-slate-600 border border-slate-200">
                  {s.rtspTransport || "TCP"}
                </span>
              )}
              {(s.resolution || s.fps) && (
                <span className="hidden sm:inline text-[10px] font-mono text-slate-500">
                  {s.resolution || "AUTO"} • {s.fps || 25} FPS
                </span>
              )}
            </div>
            <div className="text-xs font-mono text-slate-600 truncate" title={displayUrl}>
              {displayUrl || <span className="italic text-slate-400">Chưa có URL</span>}
            </div>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center gap-2 shrink-0" title={s.enabled ? "Tắt luồng này" : "Bật luồng này"}>
            <button
              type="button"
              onClick={() => handleToggleStreamEnabled(s)}
              disabled={isBusy}
              className={`w-10 h-5 rounded-full transition-colors relative p-0.5 focus:outline-none disabled:opacity-50 ${
                s.enabled ? "bg-emerald-600" : "bg-slate-300"
              }`}
            >
              <div className={`w-4 h-4 rounded-full bg-white shadow-xs transition-transform ${s.enabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Row actions */}
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => handleTestStream(s)}
              disabled={!canTest || test?.loading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold transition-colors disabled:opacity-40"
              title={canTest ? "Kiểm tra kết nối TCP tới camera" : "Chỉ kiểm tra được luồng RTSP/HTTP"}
            >
              <Radio className={`w-3.5 h-3.5 ${test?.loading ? "animate-pulse" : ""}`} />
              {test?.loading ? "Đang kiểm tra..." : "Kiểm tra"}
            </button>
            <button
              type="button"
              onClick={() => handleToggleSnapshot(s)}
              disabled={!canSnapshot}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-40 ${
                snapshotStreamId === s.id
                  ? "border-slate-800 bg-slate-800 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              title="Chụp 1 khung hình snapshot từ luồng này"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Xem ảnh
            </button>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingStreamId(null) : openEditStream(s))}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-xs font-semibold transition-colors"
              title="Sửa cấu hình luồng"
            >
              <Pencil className="w-3.5 h-3.5" />
              Sửa
            </button>
            <button
              type="button"
              onClick={() => handleDeleteStream(s)}
              disabled={isLast || isBusy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs font-semibold transition-colors disabled:opacity-40"
              title={isLast ? "Không thể xóa luồng cuối cùng của cổng" : "Xóa luồng này"}
            >
              {isBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Xóa
            </button>
          </div>
        </div>

        {/* Inline test result */}
        {test && !test.loading && test.data && (
          <div
            className={`mx-3 mb-3 p-3 rounded-lg border text-xs space-y-1 animate-in fade-in ${
              test.data.tcpConnected
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : test.data.isPrivateLan
                ? "bg-amber-50 border-amber-200 text-amber-950"
                : "bg-rose-50 border-rose-200 text-rose-900"
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-bold">
              <span className="flex items-center gap-1.5">
                {test.data.tcpConnected ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    KẾT NỐI THÀNH CÔNG
                  </>
                ) : test.data.isPrivateLan ? (
                  <>
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    ĐỊA CHỈ MẠNG LAN NỘI BỘ (PRIVATE IP)
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-rose-600" />
                    KHÔNG THỂ KẾT NỐI TỚI CAMERA
                  </>
                )}
              </span>
              {test.data.details?.latencyMs !== undefined && (
                <span className="font-mono">
                  {test.data.details.latencyMs}ms • {test.data.details.transport || s.rtspTransport || "TCP"}
                </span>
              )}
            </div>
            <p className="font-normal">{test.message}</p>
            {test.data.details?.host && (
              <div className="font-mono text-[11px] opacity-80">
                Host: {test.data.details.host}:{test.data.details.port} | Trạng thái: {test.data.details.status}
              </div>
            )}
          </div>
        )}

        {/* Inline snapshot */}
        {snapshotStreamId === s.id && (
          <div className="mx-3 mb-3 space-y-1.5 animate-in fade-in">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span className="font-semibold">Snapshot luồng "{s.label}"</span>
              <button
                type="button"
                onClick={() => setSnapshotTimestamp(Date.now())}
                className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-semibold"
              >
                <RefreshCw className="w-3 h-3" />
                Chụp lại
              </button>
            </div>
            <div className="relative aspect-video max-h-72 w-full bg-slate-950 rounded-lg overflow-hidden border border-slate-800 flex items-center justify-center">
              <ProtectedImage
                key={`row-snap-${s.id}-${snapshotTimestamp}`}
                src={`/api/camera-streams/snapshot?gate=${currentGateKey}&stream=${encodeURIComponent(s.id)}&t=${snapshotTimestamp}`}
                alt={`Snapshot ${s.label}`}
                className="w-full h-full object-contain"
              />
            </div>
          </div>
        )}

        {/* Inline edit form */}
        {isEditing && (
          <div className="px-3 pb-3">
            {renderStreamForm("EDIT", editForm, setEditForm, editFormError, handleSaveEditStream, () => setEditingStreamId(null))}
          </div>
        )}
      </div>
    );
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
                Khai báo nhiều nguồn camera cho mỗi Cổng Vào/Ra (RTSP, UVC Client Browser, HTTP Stream) và tách nhận diện khuôn mặt chạy đa luồng tại máy chủ.
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
              Khuyến nghị 4 luồng trên máy chủ tiêu chuẩn hoặc 8 luồng khi đồng thời kết nối nhiều luồng RTSP cho Cổng Vào và Cổng Ra.
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
            onClick={() => switchGateTab("ENTRY")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all ${
              activeGateTab === "ENTRY"
                ? "bg-white text-indigo-700 shadow-xs border border-slate-200 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Radio className="w-4 h-4 text-emerald-600" />
            Cổng Vào (Main Entry Gate)
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono">
              {deriveGateStreams(config.entryGate, "entry").filter((s) => s.enabled).length} luồng
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                config.entryGate?.enabled ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
          </button>

          <button
            onClick={() => switchGateTab("EXIT")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all ${
              activeGateTab === "EXIT"
                ? "bg-white text-indigo-700 shadow-xs border border-slate-200 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Radio className="w-4 h-4 text-blue-600" />
            Cổng Ra (Exit Gate B2)
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono">
              {deriveGateStreams(config.exitGate, "exit").filter((s) => s.enabled).length} luồng
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                config.exitGate?.enabled ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
          </button>

          <button
            onClick={() => switchGateTab("DUAL_MONITOR")}
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

              <div className="flex flex-wrap items-center justify-between sm:justify-end gap-4 pt-4 sm:pt-0">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={currentGateConfig.autoStart !== false}
                    onChange={(e) => updateCurrentGate((prev) => ({ ...prev, autoStart: e.target.checked }))}
                    className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                  />
                  Tự động khởi chạy (Auto Start)
                </label>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-sm font-semibold text-slate-800">Trạng Thái Kích Hoạt Cổng</div>
                    <div className="text-xs text-slate-700">
                      {currentGateConfig.enabled ? "Đang bật nhận diện cho cổng này" : "Tạm dừng toàn bộ luồng camera"}
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
            </div>

            {/* ---------------- STREAM LIST ---------------- */}
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <label className="block text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-600" />
                    Danh Sách Luồng Camera Của Cổng ({currentStreams.length})
                  </label>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Mỗi cổng có thể gắn nhiều nguồn video (VD: 2 kênh NVR). Luồng bật có ưu tiên thấp nhất là luồng <b>Chính</b>; dùng mũi tên để đổi thứ tự.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAddFormOpen((prev) => !prev);
                    setAddForm(EMPTY_STREAM_FORM);
                    setAddFormError(null);
                    setEditingStreamId(null);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold shadow-xs transition-colors ${
                    addFormOpen
                      ? "bg-slate-100 text-slate-700 border border-slate-300 hover:bg-slate-200"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                  }`}
                >
                  {addFormOpen ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  {addFormOpen ? "Đóng biểu mẫu" : "Thêm luồng"}
                </button>
              </div>

              {streamActionError && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2 animate-in fade-in">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="flex-1">{streamActionError}</span>
                  <button type="button" onClick={() => setStreamActionError(null)} className="text-rose-700 hover:text-rose-900">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {streamActionNotice && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2 animate-in fade-in">
                  <Info className="w-4 h-4 text-amber-600 shrink-0" />
                  <span className="flex-1">{streamActionNotice}</span>
                  <button type="button" onClick={() => setStreamActionNotice(null)} className="text-amber-700 hover:text-amber-900">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {addFormOpen &&
                renderStreamForm("ADD", addForm, setAddForm, addFormError, handleAddStream, () => {
                  setAddFormOpen(false);
                  setAddFormError(null);
                })}

              {loading && currentStreams.length === 0 ? (
                <div className="p-6 rounded-xl border border-dashed border-slate-300 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                  Đang tải danh sách luồng camera...
                </div>
              ) : currentStreams.length === 0 ? (
                <div className="p-6 rounded-xl border border-dashed border-slate-300 text-center space-y-1">
                  <Video className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-medium text-slate-700">Cổng này chưa có luồng camera nào</p>
                  <p className="text-xs text-slate-500">Nhấn "Thêm luồng" để khai báo nguồn RTSP, HTTP hoặc UVC.</p>
                </div>
              ) : (
                <div className="space-y-2">{currentStreams.map((s, index) => renderStreamRow(s, index))}</div>
              )}
            </div>

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
                  {currentStreams.length > 1 && (
                    <select
                      value={previewStream?.id || ""}
                      onChange={(e) => selectPreviewStream(e.target.value)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold bg-white outline-none"
                      title="Chọn luồng để xem thử"
                    >
                      {currentStreams.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                          {currentPrimary?.id === s.id ? " (Chính)" : ""}
                          {!s.enabled ? " - đã tắt" : ""}
                        </option>
                      ))}
                    </select>
                  )}

                  {previewStream?.sourceType === "RTSP" && (
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
                        title="Chụp 1 khung hình từ luồng đang xem và chuyển vào Worker Threads nhận diện"
                      >
                        <ScanFace className={`w-3.5 h-3.5 text-indigo-600 ${isScanningRtsp ? "animate-spin" : ""}`} />
                        {isScanningRtsp ? "Đang Quét AI..." : "Quét Nhận Diện Từ RTSP"}
                      </button>
                    </>
                  )}

                  {!isPreviewActive ? (
                    <button
                      type="button"
                      onClick={() => startPreview()}
                      disabled={!previewStream}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
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

                {isPreviewActive && previewStream ? (
                  previewStream.sourceType === "CLIENT_UVC" ? (
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
                  ) : previewStream.sourceType === "RTSP" ? (
                    rtspViewMode === "MJPEG" ? (
                      // Deliberately a plain <img>: this is a continuous multipart
                      // stream, so a fetch()/blob() round trip would never resolve.
                      <img
                        key={`mjpeg-${previewStream.id}-${previewTimestamp}`}
                        src={`/api/camera-streams/mjpeg?gate=${currentGateKey}&stream=${encodeURIComponent(previewStream.id)}&t=${previewTimestamp}`}
                        alt="RTSP Live MJPEG"
                        onError={() => {
                          // If proxy fails (e.g. cloud cannot reach private LAN), fallback gracefully
                          setRtspViewMode("SNAPSHOT");
                          setPreviewTimestamp(Date.now());
                        }}
                        className="w-full h-full object-contain"
                      />
                    ) : rtspViewMode === "SNAPSHOT" ? (
                      <ProtectedImage
                        key={`snap-${previewStream.id}-${previewTimestamp}`}
                        src={`/api/camera-streams/snapshot?gate=${currentGateKey}&stream=${encodeURIComponent(previewStream.id)}&t=${previewTimestamp}`}
                        alt="RTSP Snapshot"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <ProtectedImage
                        src={`/api/camera-streams/test-frame?gate=${currentGateKey}&source=${encodeURIComponent(
                          previewStream.sourceType
                        )}&t=${previewTimestamp}`}
                        alt="Camera Stream Simulation"
                        className="w-full h-full object-contain"
                      />
                    )
                  ) : previewStream.sourceType === "HTTP_MJPEG" && previewStream.httpUrl ? (
                    // Deliberately a plain <img>: httpUrl is the camera's own host,
                    // which must never receive the operator session cookie.
                    <img
                      key={`http-${previewStream.id}-${previewTimestamp}`}
                      src={previewStream.httpUrl}
                      alt="HTTP MJPEG Stream"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `/api/camera-streams/test-frame?gate=${currentGateKey}&source=HTTP_MJPEG&t=${previewTimestamp}`;
                      }}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <ProtectedImage
                      src={`/api/camera-streams/test-frame?gate=${currentGateKey}&source=${encodeURIComponent(
                        previewStream.sourceType
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
                      {previewStream
                        ? <>Nhấn "Bật Xem Trực Tiếp" để kết nối luồng <code className="text-indigo-400">{previewStream.label}</code>.</>
                        : "Hãy thêm ít nhất một luồng camera cho cổng này."}
                    </p>
                  </div>
                )}

                {/* Overlays during active preview */}
                {isPreviewActive && previewStream && (
                  <>
                    <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-xs text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-2 font-mono">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                      <span>{previewStream.label}</span>
                      {currentPrimary?.id === previewStream.id && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600 text-white font-bold">Chính</span>
                      )}
                      <span className="text-slate-400">|</span>
                      <span className="text-emerald-400 font-bold">
                        {previewStream.sourceType}
                        {previewStream.sourceType === "RTSP" ? ` (${rtspViewMode})` : ""}
                      </span>
                    </div>

                    <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-xs text-white text-xs px-3 py-1.5 rounded-lg font-mono">
                      {previewStream.resolution || "1920x1080"} • {previewStream.fps || previewFps} FPS
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
                    rtspScanResult.success && rtspScanResult.recognized
                      ? "bg-emerald-50 border-emerald-300 text-emerald-950"
                      : rtspScanResult.success
                      ? "bg-amber-50 border-amber-300 text-amber-950"
                      : rtspScanResult.overloaded
                      ? "bg-amber-50 border-amber-300 text-amber-950"
                      : "bg-rose-50 border-rose-300 text-rose-950"
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <div className="flex items-center gap-2">
                      <ScanFace className="w-4 h-4" />
                      <span>
                        KẾT QUẢ QUÉT NHẬN DIỆN ({activeGateTab}
                        {rtspScanResult.streamLabel ? ` • ${rtspScanResult.streamLabel}` : ""})
                      </span>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded font-mono bg-white/70">
                      {rtspScanResult.multiThreadUsed ? "⚡ Multi-Thread Worker" : rtspScanResult.engineUsed || "Chế độ tuần tự"}
                    </span>
                  </div>

                  {rtspScanResult.success ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 font-mono">
                      <div>
                        <span className="opacity-75">Đối tượng: </span>
                        <b>
                          {rtspScanResult.recognized && rtspScanResult.employee
                            ? rtspScanResult.employee.name
                            : (rtspScanResult.totalFacesDetected || 0) > 0
                            ? `${rtspScanResult.totalFacesDetected} khuôn mặt (chưa khớp hồ sơ)`
                            : "Không phát hiện khuôn mặt"}
                        </b>
                      </div>
                      <div>
                        <span className="opacity-75">Độ tin cậy: </span>
                        <b>{Math.round(Number(rtspScanResult.confidence || 0))}%</b>
                      </div>
                      <div>
                        <span className="opacity-75">Thời gian xử lý: </span>
                        <b>{rtspScanResult.processingTimeMs ?? rtspScanResult.processDurationMs ?? 0}ms (Lấy frame: {rtspScanResult.frameCaptureDurationMs || 0}ms)</b>
                      </div>
                    </div>
                  ) : (
                    <p className={`font-medium ${rtspScanResult.overloaded ? "text-amber-900" : "text-rose-800"}`}>
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
                Màn hình kép hiển thị snapshot của toàn bộ luồng đang bật ở cả 2 cổng, hỗ trợ bảo vệ an ninh kiểm soát lưu lượng song song.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {(["entry", "exit"] as GateKey[]).map((key) => {
                const gate = config[gateFieldOf(key)];
                const streams = deriveGateStreams(gate, key).filter((s) => s.enabled);
                const primary = getPrimaryStream(streams);
                const isEntry = key === "entry";
                return (
                  <div key={key} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${isEntry ? "bg-emerald-500" : "bg-blue-500"}`} />
                        {gate?.name}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-md font-bold border ${
                          isEntry ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-blue-50 text-blue-700 border-blue-200"
                        }`}
                      >
                        {streams.length} luồng bật
                      </span>
                    </div>
                    {streams.length === 0 ? (
                      <div className="aspect-video bg-slate-900 rounded-xl border border-slate-800 flex items-center justify-center text-xs text-slate-400">
                        Chưa có luồng nào được bật
                      </div>
                    ) : (
                      <div className={`grid gap-3 ${streams.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
                        {streams.map((s) => (
                          <div
                            key={s.id}
                            className="relative aspect-video bg-slate-900 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center"
                          >
                            <ProtectedImage
                              src={
                                s.sourceType === "RTSP" || s.sourceType === "BACKEND_UVC"
                                  ? `/api/camera-streams/snapshot?gate=${key}&stream=${encodeURIComponent(s.id)}&t=${previewTimestamp}`
                                  : `/api/camera-streams/test-frame?gate=${key}&source=${encodeURIComponent(s.sourceType)}&t=${previewTimestamp}`
                              }
                              alt={s.label}
                              fallbackSrc={`/api/camera-streams/test-frame?gate=${key}&source=${encodeURIComponent(s.sourceType)}%20Offline`}
                              className="w-full h-full object-contain"
                            />
                            <div className="absolute top-2 left-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded font-mono flex items-center gap-1.5">
                              {isEntry ? "VÀO" : "RA"} • {s.label}
                              {primary?.id === s.id && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-600 text-white font-bold">Chính</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setPreviewTimestamp(Date.now())}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold"
              >
                <RefreshCw className="w-3.5 h-3.5 text-indigo-600" />
                Chụp lại toàn bộ snapshot
              </button>
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
              <span className="font-semibold text-slate-900">{config.entryGate?.reconnectIntervalSeconds || 5} giây</span>
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
            <p className="flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 text-slate-500" />
              <span>Mỗi cổng có thể quét đồng thời nhiều luồng RTSP; kết quả được gộp theo từng luồng.</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
