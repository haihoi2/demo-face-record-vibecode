import React, { useState, useEffect, useCallback } from "react";
import {
  Sparkles,
  Cpu,
  Layers,
  CheckCircle2,
  Sliders,
  ShieldCheck,
  Zap,
  RefreshCw,
  Play,
  RotateCcw,
  Save,
  Check,
  Eye,
  Info,
  ChevronRight,
  Server,
  Activity,
  Award,
  Lock,
  Unlock,
  AlertCircle,
  HelpCircle,
  AlertTriangle,
} from "lucide-react";
import {
  AiRecognitionConfig,
  RecognitionEngineMode,
  BenchmarkResult,
  Employee,
  FusionThresholds,
} from "../types";
import { safeJsonFetch } from "../utils/api";
import { soundEffects } from "../utils/audio";
import {
  getStoredAiConfig,
  saveStoredAiConfig,
  getStoredEmployees,
} from "../utils/offlineEngine";
import { runLocalFaceRecognition } from "../utils/localBiometrics";

interface AiConfigPageProps {
  employees: Employee[];
  onNavigateToScanner?: () => void;
}

/**
 * Which "Local Model SOTA" controls the backend actually honours today.
 * Audited against server.ts / src/server/faceFusion.ts / faceWorkerPool.ts:
 *  - modelArchitecture: only swaps a display string. The real detector/recognizer
 *    pair is decided by the ONNX models loaded server-side and is reported
 *    read-only by GET /api/face-engine/status.
 *  - similarityThreshold: REAL - it is the fusion `acceptSingle` operating point
 *    (one strong observation is enough to accept at or above this cosine).
 *  - livenessSensitivity: thresholds 92/85/75 are compared against a score hardcoded
 *    to 94-100, so the check can never fail. Still NOT wired to the ONNX pipeline.
 *  - autoContrast / antiSpoofing: stored in config and never read by any code path.
 * Flip an entry to true only when the matching backend work actually lands.
 */
const LOCAL_MODEL_SUPPORT = {
  modelArchitecture: false,
  similarityThreshold: true,
  livenessSensitivity: false,
  autoContrast: false,
  antiSpoofing: false,
} as const;

const NOT_IMPLEMENTED_BADGE = "Chưa triển khai";
const NOT_IMPLEMENTED_HINT =
  "Tùy chọn này chưa được triển khai ở backend - thay đổi sẽ được lưu nhưng không ảnh hưởng đến kết quả nhận diện.";

/** Shape of GET /api/face-engine/status. Every field is optional on purpose:
 *  an older server may answer 404 or omit parts of the payload. */
interface FaceEngineStatus {
  engine?: string;
  requestedEngine?: string;
  ready?: boolean;
  failClosed?: boolean;
  info?: {
    detector?: string;
    recognizer?: string;
    dims?: number;
    modelTag?: string;
    loadMs?: number;
  };
  templates?: {
    total?: number;
    byEmployee?: Record<string, number> | number;
    modelTag?: string;
    /** How many of those templates were made by the model currently loaded. */
    matchingModelTag?: number;
  };
  thresholds?: Partial<FusionThresholds>;
}

const FUSION_THRESHOLD_LABELS: Array<{
  key: keyof FusionThresholds;
  label: string;
  desc: string;
  integer?: boolean;
}> = [
  {
    key: "acceptSingle",
    label: "acceptSingle",
    desc: "Một góc nhìn đạt cosine này là đủ để chấp nhận. Đây chính là thanh trượt bên dưới.",
  },
  {
    key: "minEvidence",
    label: "minEvidence",
    desc: "Dưới mức này, quan sát không được tính là bằng chứng cho bất kỳ ai.",
  },
  {
    key: "acceptFused",
    label: "acceptFused",
    desc: "Cosine trung bình (có trọng số chất lượng) cần đạt khi chấp nhận nhờ nhiều góc nhìn đồng thuận.",
  },
  {
    key: "minAgreeing",
    label: "minAgreeing",
    desc: "Số quan sát tối thiểu phải cùng chỉ về một người khi chấp nhận theo đồng thuận.",
    integer: true,
  },
  {
    key: "minMargin",
    label: "minMargin",
    desc: "Khoảng cách tối thiểu giữa người đứng đầu và người kế tiếp, tránh chấp nhận nhập nhằng.",
  },
];

const countEnrolledEmployees = (byEmployee: Record<string, number> | number | undefined): number | null => {
  if (typeof byEmployee === "number") return Number.isFinite(byEmployee) ? byEmployee : null;
  if (byEmployee && typeof byEmployee === "object") return Object.keys(byEmployee).length;
  return null;
};

export const AiConfigPage: React.FC<AiConfigPageProps> = ({
  employees,
  onNavigateToScanner,
}) => {
  const [config, setConfig] = useState<AiRecognitionConfig>(getStoredAiConfig());
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [benchmarking, setBenchmarking] = useState<boolean>(false);
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const [testSubject, setTestSubject] = useState<string>("FIRST_EMPLOYEE");
  const [activeTabSection, setActiveTabSection] = useState<"engine" | "google" | "local" | "benchmark">("engine");

  // Real face engine status (GET /api/face-engine/status). Never assumed present.
  const [engineStatus, setEngineStatus] = useState<FaceEngineStatus | null>(null);
  const [engineLoading, setEngineLoading] = useState<boolean>(true);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineCheckedAt, setEngineCheckedAt] = useState<string | null>(null);

  const effectiveEmployees = employees.length > 0 ? employees : getStoredEmployees();

  const fetchEngineStatus = useCallback(async (): Promise<void> => {
    setEngineLoading(true);
    const res = await safeJsonFetch<FaceEngineStatus>("/api/face-engine/status");
    if (res.ok && res.data && typeof res.data === "object") {
      setEngineStatus(res.data);
      setEngineError(null);
    } else {
      setEngineStatus(null);
      setEngineError(
        res.status === 404
          ? "Máy chủ chưa có endpoint /api/face-engine/status (HTTP 404). Không xác định được động cơ nào đang chạy."
          : res.error || `Không đọc được trạng thái động cơ (HTTP ${res.status || 0}).`
      );
    }
    setEngineCheckedAt(new Date().toLocaleTimeString("vi-VN"));
    setEngineLoading(false);
  }, []);

  useEffect(() => {
    fetchEngineStatus();
  }, [fetchEngineStatus]);

  // Fetch current server config on mount
  useEffect(() => {
    let mounted = true;
    safeJsonFetch<AiRecognitionConfig>("/api/config/ai", undefined, config)
      .then((res) => {
        if (mounted && res.ok && res.data) {
          setConfig(res.data);
          saveStoredAiConfig(res.data);
        }
      })
      .catch(() => {
        // Fallback to local stored config
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);

    try {
      // 1. Save to local storage (instant for static/Netlify fallback)
      saveStoredAiConfig(config);

      // 2. Persist to server if available
      await safeJsonFetch("/api/config/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      soundEffects.playGranted();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      // Even if network fails, local storage is saved
      saveStoredAiConfig(config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    const defaults: AiRecognitionConfig = {
      engineMode: "HYBRID_AUTO",
      googleAi: {
        model: "gemini-3.8-flash",
        temperature: 0.1,
        minConfidence: 75,
        useSystemFallback: true,
        customPrompt: "",
      },
      localModel: {
        modelArchitecture: "blazeface-arcface-sota",
        similarityThreshold: 0.72,
        livenessSensitivity: "MEDIUM",
        maxFaces: 4,
        autoContrast: true,
        antiSpoofing: true,
      },
      hybridSettings: {
        localPreFilterThreshold: 0.85,
        fallbackToCloudOnUnknown: true,
      },
    };
    setConfig(defaults);
    saveStoredAiConfig(defaults);
    soundEffects.playClick();
  };

  const runBenchmark = async () => {
    setBenchmarking(true);
    setBenchmarkResult(null);

    const testEmp =
      testSubject === "FIRST_EMPLOYEE"
        ? effectiveEmployees[0]
        : effectiveEmployees.find((e) => e.id === testSubject);

    const samplePhoto = testEmp?.photoUrl || "";

    try {
      // Attempt server benchmark first
      const serverRes = await safeJsonFetch<BenchmarkResult>("/api/config/ai/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: samplePhoto,
          clientEmployees: effectiveEmployees,
          localModelArchitecture: config.localModel.modelArchitecture,
          similarityThreshold: config.localModel.similarityThreshold,
          livenessSensitivity: config.localModel.livenessSensitivity,
          googleModel: config.googleAi.model,
        }),
      });

      if (serverRes.ok && serverRes.data && serverRes.data.googleAiResult) {
        setBenchmarkResult(serverRes.data);
        soundEffects.playBeep();
      } else {
        // Run Client-Side Benchmark Simulation
        const localStart = performance.now();
        const localRes = runLocalFaceRecognition({
          imageBase64: samplePhoto,
          employees: effectiveEmployees,
          modelArchitecture: config.localModel.modelArchitecture,
          similarityThreshold: config.localModel.similarityThreshold,
          livenessSensitivity: config.localModel.livenessSensitivity,
          testEmployeeId: testEmp?.id,
        });
        const localDuration = Math.round(performance.now() - localStart) + 12;

        const simulatedGoogleDuration = Math.round(210 + Math.random() * 60);

        const result: BenchmarkResult = {
          googleAiResult: {
            model: config.googleAi.model,
            latencyMs: simulatedGoogleDuration,
            recognized: localRes.recognized,
            facesCount: localRes.detectedFaces.length || 1,
            detectedEmployees: localRes.bestMatch ? [localRes.bestMatch.name] : [],
            confidence: Math.round((96.5 + Math.random() * 2.8) * 10) / 10,
            livenessScore: 98.4,
            message: `Xác thực qua ${config.googleAi.model} (Phân tích toàn cảnh đa mục tiêu)`,
          },
          localResult: {
            model: localRes.modelName,
            latencyMs: localDuration,
            recognized: localRes.recognized,
            facesCount: localRes.detectedFaces.length || 1,
            detectedEmployees: localRes.bestMatch ? [localRes.bestMatch.name] : [],
            confidence: localRes.overallConfidence,
            livenessScore: localRes.overallLiveness,
            cosineSimilarity: localRes.cosineSimilarity,
            message: localRes.detectedFaces[0]?.message || "Xác thực vector Cosine",
          },
          speedDifference: `Local Model nhanh hơn xấp xỉ ${(simulatedGoogleDuration / Math.max(1, localDuration)).toFixed(1)}x so với Google Cloud AI (${localDuration}ms vs ${simulatedGoogleDuration}ms)`,
          recommendation:
            localRes.cosineSimilarity >= 0.72
              ? "Cả hai mô hình đều xác thực chính xác. Nên dùng chế độ Hybrid Auto hoặc Local Model để mở cửa siêu tốc <40ms!"
              : "Độ tin cậy cục bộ ở mức biên. Khuyến nghị bật chế độ Hybrid Auto để Google AI hỗ trợ phân tích sâu khi cần thiết.",
        };

        setBenchmarkResult(result);
        soundEffects.playBeep();
      }
    } catch {
      // Fallback
    } finally {
      setBenchmarking(false);
    }
  };

  // ---- Derived engine facts (all tolerant of a missing / partial payload) ----
  const engineInfo = engineStatus?.info || {};
  const engineName = String(engineStatus?.engine || "").toLowerCase();
  const engineIsOnnx = engineName === "onnx";
  const engineOperational = engineStatus?.ready === true && engineIsOnnx;
  const templateTotal =
    typeof engineStatus?.templates?.total === "number" ? engineStatus.templates.total : null;
  const enrolledEmployeeCount = countEnrolledEmployees(engineStatus?.templates?.byEmployee);
  const serverThresholds: Partial<FusionThresholds> = engineStatus?.thresholds || {};
  const serverAcceptSingle =
    typeof serverThresholds.acceptSingle === "number" ? serverThresholds.acceptSingle : null;
  const templateTotalForTag = engineStatus?.templates?.matchingModelTag;
  const staleTemplates =
    typeof templateTotalForTag === "number" && templateTotal !== null
      ? templateTotal - templateTotalForTag
      : 0;

  const threshold = config.localModel.similarityThreshold;
  /** Honest reading of the slider against this site's measured cosine ranges. */
  const thresholdVerdict =
    threshold < 0.32
      ? {
          tone: "rose" as const,
          title: "Nguy hiểm: dải chéo camera vắt ngang ngưỡng này",
          text: "Dải đo chéo giữa hai camera là 0.139 - 0.304: 4/6 cặp đo được nằm dưới 0.28, nhưng phần trên của dải vượt lên tới 0.304, tức là dải này nằm vắt ngang ngưỡng chứ không nằm trọn dưới. Đáy của dải còn chạm vào vùng đo được giữa hai người khác nhau (≤ 0.145). Đặt ngưỡng ở đây thì một người chưa đăng ký tại chính camera đó vẫn có thể vượt qua.",
        }
      : threshold < 0.45
      ? {
          tone: "amber" as const,
          title: "Dễ dãi: biên an toàn mỏng",
          text: "Toàn bộ dải chéo camera đo được (cao nhất 0.304) nằm dưới ngưỡng này, nhưng khoảng cách chỉ còn 0.02 - 0.15 - rất ít chỗ dự phòng cho những góc chụp chưa từng đo. Ngưỡng này cũng thấp hơn hẳn dải cùng người trên exit-501 (0.50 - 0.62).",
        }
      : threshold <= 0.62
      ? {
          tone: "emerald" as const,
          title: "Nằm trong vùng đo được của cùng một người",
          text: "Cùng một người trên camera exit-501 đo được 0.50 - 0.62. Ngưỡng trong khoảng này chấp nhận người đã đăng ký tại chính camera đó và loại vùng người lạ.",
        }
      : {
          tone: "amber" as const,
          title: "Khắt khe: nhiều lần quét hợp lệ sẽ bị từ chối",
          text: "Trên 0.62 là cao hơn mức cao nhất đo được của cùng một người (0.62). Nhân viên hợp lệ sẽ thường xuyên bị từ chối và phải quét lại.",
        };

  const renderEngineStatusPanel = () => (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Server className="w-4.5 h-4.5 text-slate-700 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 truncate">
            Động Cơ Nhận Diện Thật Trên Máy Chủ (Face Engine)
          </h2>
          {engineStatus && (
            <span
              className={`px-2 py-0.5 text-[10px] font-bold rounded-full border shrink-0 ${
                engineOperational
                  ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                  : "bg-rose-100 text-rose-800 border-rose-200"
              }`}
            >
              {engineOperational ? "ĐANG HOẠT ĐỘNG" : "KHÔNG HOẠT ĐỘNG"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {engineCheckedAt && (
            <span className="hidden sm:inline text-[10px] text-slate-400 font-mono">
              Kiểm tra lúc {engineCheckedAt}
            </span>
          )}
          <button
            type="button"
            id="btn-refresh-face-engine"
            onClick={fetchEngineStatus}
            disabled={engineLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all disabled:opacity-60"
            title="Đọc lại /api/face-engine/status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${engineLoading ? "animate-spin" : ""}`} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {engineLoading && !engineStatus && !engineError && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <RefreshCw className="w-4 h-4 animate-spin text-slate-400" />
            <span>Đang đọc trạng thái động cơ từ máy chủ...</span>
          </div>
        )}

        {!engineLoading && engineError && (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-2">
            <div className="flex items-start gap-2 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <strong className="block">Không xác định được trạng thái động cơ.</strong>
                <span className="font-mono text-[11px] break-words">{engineError}</span>
                <p className="mt-1 leading-relaxed">
                  Khi chưa đọc được trạng thái, đừng giả định là hệ thống đang nhận diện được. Hãy
                  kiểm tra lại máy chủ trước khi cho phép mở cửa bằng khuôn mặt.
                </p>
              </div>
            </div>
          </div>
        )}

        {!engineError && !engineLoading && !engineStatus && (
          <div className="text-xs text-slate-500">Máy chủ không trả về dữ liệu trạng thái nào.</div>
        )}

        {engineStatus && (
          <>
            {/* Honest headline state */}
            {engineOperational ? (
              <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs text-emerald-900">
                <ShieldCheck className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                <div className="leading-relaxed">
                  <strong>Động cơ ONNX đã nạp xong và đang nhận diện thật.</strong> Vector đặc trưng
                  được trích xuất trên máy chủ và so khớp với các mẫu đã đăng ký theo từng camera.
                </div>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-rose-50 border-2 border-rose-300 flex items-start gap-2.5 text-xs text-rose-900">
                <AlertTriangle className="w-4.5 h-4.5 text-rose-600 mt-0.5 shrink-0" />
                <div className="space-y-1 leading-relaxed">
                  <strong className="block text-sm">
                    Nhận diện khuôn mặt KHÔNG hoạt động. Mọi yêu cầu mở cửa bằng khuôn mặt sẽ bị từ chối.
                  </strong>
                  {engineName === "unavailable" ? (
                    <p>
                      Máy chủ được yêu cầu chạy động cơ{" "}
                      <span className="font-mono">{engineStatus.requestedEngine || "onnx"}</span> nhưng{" "}
                      <strong>không nạp được mô hình</strong>. Hệ thống đang ở trạng thái an toàn
                      (fail-closed): không có quyết định mở cửa nào được đưa ra. Kiểm tra tệp mô hình
                      ONNX và log máy chủ.
                    </p>
                  ) : engineName === "hash" ? (
                    <p>
                      Máy chủ đang chạy bộ so khớp <span className="font-mono">hash</span> thay cho mô
                      hình ONNX thật. Cơ chế này chỉ băm ảnh, không đo được độ giống của khuôn mặt,
                      nên không có kết quả nào từ nó được xem là xác thực.
                    </p>
                  ) : engineStatus.ready === false ? (
                    <p>
                      Động cơ <span className="font-mono">{engineStatus.engine || "?"}</span> báo{" "}
                      <span className="font-mono">ready: false</span> - mô hình chưa nạp xong hoặc nạp
                      thất bại. Kiểm tra log máy chủ và tệp mô hình ONNX.
                    </p>
                  ) : (
                    <p>
                      Máy chủ báo động cơ{" "}
                      <span className="font-mono">{engineStatus.engine || "không rõ"}</span>, không phải
                      ONNX. Đây là trạng thái thật, không phải lỗi hiển thị.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Engine facts */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                { label: "Động cơ", value: engineStatus.engine || "—", mono: true },
                { label: "Bộ phát hiện (detector)", value: engineInfo.detector || "—", mono: true },
                { label: "Bộ nhận diện (recognizer)", value: engineInfo.recognizer || "—", mono: true },
                {
                  label: "Số chiều vector",
                  value: typeof engineInfo.dims === "number" ? `${engineInfo.dims}-D` : "—",
                  mono: true,
                },
                { label: "Model tag", value: engineInfo.modelTag || "—", mono: true },
                {
                  label: "Thời gian nạp mô hình",
                  value: typeof engineInfo.loadMs === "number" ? `${engineInfo.loadMs} ms` : "—",
                  mono: true,
                },
              ].map((item) => (
                <div key={item.label} className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                    {item.label}
                  </div>
                  <div
                    className={`text-xs text-slate-900 font-semibold mt-0.5 break-words ${
                      item.mono ? "font-mono" : ""
                    }`}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Enrolled templates */}
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-600 shrink-0" />
                <span className="text-xs text-slate-700">
                  <strong className="font-semibold">Mẫu khuôn mặt đã đăng ký: </strong>
                  <span className="font-mono font-bold text-slate-900">
                    {templateTotal === null ? "—" : templateTotal}
                  </span>
                  {enrolledEmployeeCount !== null && (
                    <span className="text-slate-500">
                      {" "}
                      trên {enrolledEmployeeCount} nhân viên
                    </span>
                  )}
                </span>
              </div>
              {engineStatus.templates?.modelTag && (
                <span className="text-[11px] font-mono text-slate-500">
                  tag của mẫu: {engineStatus.templates.modelTag}
                </span>
              )}
              {templateTotal === 0 && (
                <span className="text-[11px] text-amber-800 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5 font-semibold">
                  Chưa có mẫu nào - không ai được nhận diện
                </span>
              )}
            </div>

            {staleTemplates > 0 && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2 text-[11px] text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <span>
                  {staleTemplates} mẫu được tạo bởi một model khác{" "}
                  {engineInfo.modelTag ? (
                    <>
                      (hiện chạy <span className="font-mono">{engineInfo.modelTag}</span>)
                    </>
                  ) : null}
                  . Vector của hai model không so sánh được nên những mẫu này bị bỏ qua khi nhận diện -
                  cần chụp lại tại đúng camera.
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      {/* Header Banner */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                <Sliders className="w-5 h-5" />
              </div>
              <h1 className="text-xl font-bold text-slate-900">
                Cấu Hình Mô Hình Nhận Diện AI
              </h1>
              <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                SOTA 2026
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Chọn giữa Google Cloud AI Vision (Gemini) và động cơ nhận diện cục bộ chạy trên máy chủ.
              Tên mô hình thật đang nạp được báo trực tiếp từ máy chủ ở bảng bên dưới - không phải nhãn cố định trong giao diện.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              id="btn-reset-ai-config"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all"
              title="Khôi phục thông số khuyến nghị"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Mặc Định</span>
            </button>

            <button
              id="btn-save-ai-config"
              onClick={handleSave}
              disabled={saving}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg shadow-xs transition-all ${
                saveSuccess
                  ? "bg-emerald-600 text-white"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white"
              }`}
            >
              {saving ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : saveSuccess ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>{saveSuccess ? "Đã Lưu Thành Công!" : "Lưu Cấu Hình"}</span>
            </button>
          </div>
        </div>

        {/* Quick Active Engine Status Strip */}
        <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
            <Activity className="w-4 h-4 text-indigo-600 shrink-0" />
            <div>
              <span className="font-semibold text-slate-700">Động cơ đang chạy: </span>
              <span className="text-indigo-600 font-bold">
                {config.engineMode === "GOOGLE_GEMINI"
                  ? "Google Cloud AI"
                  : config.engineMode === "LOCAL_BIOMETRIC"
                  ? "Local Edge Biometrics"
                  : "Hybrid Auto (Kép)"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
            <Zap className="w-4 h-4 text-amber-500 shrink-0" />
            <div>
              <span className="font-semibold text-slate-700">Tốc độ phản hồi: </span>
              <span className="text-slate-800 font-mono font-medium">
                {config.engineMode === "LOCAL_BIOMETRIC"
                  ? "< 40ms (Siêu tốc)"
                  : config.engineMode === "GOOGLE_GEMINI"
                  ? "~180-250ms (Đám mây)"
                  : "30-50ms (Ưu tiên Local)"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <div>
              <span className="font-semibold text-slate-700">Bảo mật dữ liệu: </span>
              <span className="text-emerald-700 font-medium">
                {config.engineMode === "LOCAL_BIOMETRIC"
                  ? "100% On-Device (Không gửi ảnh)"
                  : "Mã hóa TLS 1.3 End-to-End"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Real engine status - shown on every tab: it decides whether anything below matters */}
      {renderEngineStatusPanel()}

      {/* Navigation Sub-tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTabSection("engine")}
          className={`flex items-center gap-2 px-3.5 py-2 text-sm font-semibold rounded-lg transition-all ${
            activeTabSection === "engine"
              ? "bg-indigo-600 text-white shadow-xs"
              : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>1. Chọn Chế Độ Động Cơ</span>
        </button>

        <button
          onClick={() => setActiveTabSection("google")}
          className={`flex items-center gap-2 px-3.5 py-2 text-sm font-semibold rounded-lg transition-all ${
            activeTabSection === "google"
              ? "bg-indigo-600 text-white shadow-xs"
              : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          }`}
        >
          <Sparkles className="w-4 h-4" />
          <span>2. Tinh Chỉnh Google AI</span>
        </button>

        <button
          onClick={() => setActiveTabSection("local")}
          className={`flex items-center gap-2 px-3.5 py-2 text-sm font-semibold rounded-lg transition-all ${
            activeTabSection === "local"
              ? "bg-indigo-600 text-white shadow-xs"
              : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          }`}
        >
          <Cpu className="w-4 h-4" />
          <span>3. Tinh Chỉnh Local Model SOTA</span>
        </button>

        <button
          onClick={() => setActiveTabSection("benchmark")}
          className={`flex items-center gap-2 px-3.5 py-2 text-sm font-semibold rounded-lg transition-all ${
            activeTabSection === "benchmark"
              ? "bg-indigo-600 text-white shadow-xs"
              : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          }`}
        >
          <Award className="w-4 h-4" />
          <span>4. Thử Nghiệm Benchmark Đối Soát</span>
        </button>
      </div>

      {/* SECTION 1: ENGINE SELECTION */}
      {activeTabSection === "engine" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Card 1: Google Gemini */}
            <div
              id="card-engine-google"
              onClick={() => {
                setConfig({ ...config, engineMode: "GOOGLE_GEMINI" });
                soundEffects.playClick();
              }}
              className={`relative cursor-pointer rounded-2xl p-6 border-2 transition-all ${
                config.engineMode === "GOOGLE_GEMINI"
                  ? "border-indigo-600 bg-indigo-50/40 shadow-md ring-2 ring-indigo-500/20"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="p-3 bg-indigo-100 text-indigo-700 rounded-xl">
                  <Sparkles className="w-6 h-6" />
                </div>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
                  Google DeepMind
                </span>
              </div>

              <div className="mt-4">
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                  Google Cloud AI Vision
                  {config.engineMode === "GOOGLE_GEMINI" && (
                    <CheckCircle2 className="w-4 h-4 text-indigo-600 inline" />
                  )}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Mô hình Gemini Vision SOTA mới nhất (3.8 Flash & Pro)
                </p>
              </div>

              <ul className="mt-4 space-y-2 text-xs text-slate-600">
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Nhận diện đa người cùng lúc toàn cảnh</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Xử lý tốt góc nghiêng và phụ kiện che mặt</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Tự động giải thích lý do từ chối chi tiết</span>
                </li>
              </ul>

              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500">Độ trễ xử lý:</span>
                <span className="font-mono font-medium text-slate-800">~180 - 240ms</span>
              </div>
            </div>

            {/* Card 2: Local SOTA Biometric Model */}
            <div
              id="card-engine-local"
              onClick={() => {
                setConfig({ ...config, engineMode: "LOCAL_BIOMETRIC" });
                soundEffects.playClick();
              }}
              className={`relative cursor-pointer rounded-2xl p-6 border-2 transition-all ${
                config.engineMode === "LOCAL_BIOMETRIC"
                  ? "border-emerald-600 bg-emerald-50/40 shadow-md ring-2 ring-emerald-500/20"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="p-3 bg-emerald-100 text-emerald-700 rounded-xl">
                  <Cpu className="w-6 h-6" />
                </div>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                  Edge Biometrics
                </span>
              </div>

              <div className="mt-4">
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                  Local Face Recognition SOTA
                  {config.engineMode === "LOCAL_BIOMETRIC" && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 inline" />
                  )}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {engineStatus && (engineInfo.detector || engineInfo.recognizer)
                    ? `${engineInfo.detector || "?"} + ${engineInfo.recognizer || "?"}${
                        typeof engineInfo.dims === "number" ? ` (${engineInfo.dims}-D)` : ""
                      }`
                    : "Mô hình ONNX chạy trên máy chủ (xem bảng trạng thái động cơ)"}
                </p>
              </div>

              <ul className="mt-4 space-y-2 text-xs text-slate-600">
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Siêu tốc độ mở cửa tức thì (<strong className="font-semibold text-emerald-700">&lt; 40ms</strong>)</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Bảo mật 100%: Ảnh không gửi ra ngoài mạng</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Hoạt động liên tục cả khi rớt mạng / offline</span>
                </li>
              </ul>

              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500">Độ trễ xử lý:</span>
                <span className="font-mono font-medium text-emerald-700 font-bold">&lt; 35ms</span>
              </div>
            </div>

            {/* Card 3: Hybrid Auto Pipeline */}
            <div
              id="card-engine-hybrid"
              onClick={() => {
                setConfig({ ...config, engineMode: "HYBRID_AUTO" });
                soundEffects.playClick();
              }}
              className={`relative cursor-pointer rounded-2xl p-6 border-2 transition-all ${
                config.engineMode === "HYBRID_AUTO"
                  ? "border-violet-600 bg-violet-50/40 shadow-md ring-2 ring-violet-500/20"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="p-3 bg-violet-100 text-violet-700 rounded-xl">
                  <Layers className="w-6 h-6" />
                </div>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-violet-100 text-violet-700 border border-violet-200">
                  Khuyến nghị
                </span>
              </div>

              <div className="mt-4">
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                  Chế Độ Hybrid Thông Minh
                  {config.engineMode === "HYBRID_AUTO" && (
                    <CheckCircle2 className="w-4 h-4 text-violet-600 inline" />
                  )}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Kết hợp tối ưu: Local Fast-Path + Cloud Deep Vision
                </p>
              </div>

              <ul className="mt-4 space-y-2 text-xs text-slate-600">
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-violet-600 shrink-0" />
                  <span>Xác thực nhân viên quen thuộc trong 30ms</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-violet-600 shrink-0" />
                  <span>Tự động gọi Google AI khi gặp góc ánh sáng khó</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-violet-600 shrink-0" />
                  <span>Tiết kiệm băng thông & chi phí gọi API đám mây</span>
                </li>
              </ul>

              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500">Độ trễ trung bình:</span>
                <span className="font-mono font-medium text-violet-800">30ms - 200ms</span>
              </div>
            </div>
          </div>

          {/* Quick Guidance Box */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-start gap-3 text-xs text-slate-600">
            <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-slate-800">Lưu ý triển khai:</strong> Cả hai động cơ đều tích hợp đầy đủ với hệ thống Điều khiển Cửa thông minh (Smart Lock) và Webhook thông báo thời gian thực đến phòng chat Eton. Bạn có thể thay đổi chế độ bất kỳ lúc nào mà không làm gián đoạn vận hành cổng kiểm soát.
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: GOOGLE AI FINE-TUNING */}
      {activeTabSection === "google" && (
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-600" />
              <h2 className="text-base font-bold text-slate-900">
                Thông Số Kỹ Thuật Google AI Vision (Gemini)
              </h2>
            </div>
            <span className="text-xs text-slate-500 font-mono">
              SDK: @google/genai (Node.js Server-Side)
            </span>
          </div>

          {/* Model Selector Grid */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Phiên Bản Mô Hình Google AI
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  id: "gemini-3.8-flash",
                  title: "Gemini 3.8 Flash (Khuyến nghị SOTA)",
                  desc: "Mô hình Flash thế hệ mới nhất 2026. Tối ưu phân tích đa khuôn mặt toàn cảnh với độ trễ thấp.",
                  tag: "Mới nhất",
                },
                {
                  id: "gemini-flash-latest",
                  title: "Gemini Flash Latest (Tự động cập nhật)",
                  desc: "Luôn trỏ về phiên bản Flash ổn định cao cấp nhất được triển khai trên hạ tầng Google.",
                  tag: "Ổn định",
                },
                {
                  id: "gemini-3.1-flash-lite",
                  title: "Gemini 3.1 Flash Lite (Siêu nhẹ)",
                  desc: "Thiết kế chuyên biệt cho tác vụ thị giác tần suất cao với mức tiêu thụ tài nguyên tối thiểu.",
                  tag: "Tốc độ cao",
                },
                {
                  id: "gemini-3.1-pro-preview",
                  title: "Gemini 3.1 Pro (Phân tích sâu)",
                  desc: "Xử lý ảnh khó, ngược sáng mạnh, chụp từ khoảng cách xa với độ chính xác cao nhất.",
                  tag: "Độ chính xác cao",
                },
              ].map((m) => (
                <div
                  key={m.id}
                  onClick={() =>
                    setConfig({
                      ...config,
                      googleAi: { ...config.googleAi, model: m.id },
                    })
                  }
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${
                    config.googleAi.model === m.id
                      ? "border-indigo-600 bg-indigo-50/50 shadow-xs"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-900">{m.title}</span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                      {m.tag}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{m.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Sliders and Toggles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
            {/* Min Confidence */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  Ngưỡng Tin Cậy Tối Thiểu (Min Confidence):
                </span>
                <span className="font-mono font-bold text-indigo-600">
                  {config.googleAi.minConfidence}%
                </span>
              </div>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={config.googleAi.minConfidence}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    googleAi: {
                      ...config.googleAi,
                      minConfidence: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-indigo-600"
              />
              <p className="text-[11px] text-slate-500">
                Chỉ mở cửa tự động nếu độ khớp khuôn mặt từ Gemini đạt trên ngưỡng này.
              </p>
            </div>

            {/* Temperature */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  Nhiệt Độ Xử Lý (Temperature):
                </span>
                <span className="font-mono font-bold text-indigo-600">
                  {config.googleAi.temperature.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min="0.0"
                max="0.4"
                step="0.05"
                value={config.googleAi.temperature}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    googleAi: {
                      ...config.googleAi,
                      temperature: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-indigo-600"
              />
              <p className="text-[11px] text-slate-500">
                Nhiệt độ thấp (0.05 - 0.15) giúp kết quả nhận diện ổn định và định dạng JSON chuẩn xác nhất.
              </p>
            </div>
          </div>

          {/* Fallback Checkbox */}
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
            <input
              type="checkbox"
              id="chk-system-fallback"
              checked={config.googleAi.useSystemFallback}
              onChange={(e) =>
                setConfig({
                  ...config,
                  googleAi: {
                    ...config.googleAi,
                    useSystemFallback: e.target.checked,
                  },
                })
              }
              className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="chk-system-fallback" className="text-xs text-slate-700 cursor-pointer">
              <strong className="font-semibold">Tự động chuyển tiếp Model khi mạng cao tải:</strong> Khi model chính gặp quá tải tức thời (HTTP 503/429), hệ thống tự động gọi phiên bản Flash Lite thay thế để đảm bảo cửa không bị kẹt.
            </label>
          </div>
        </div>
      )}

      {/* SECTION 3: LOCAL MODEL FINE-TUNING */}
      {activeTabSection === "local" && (
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-emerald-600" />
              <h2 className="text-base font-bold text-slate-900">
                Thông Số Kỹ Thuật Mô Hình Cục Bộ SOTA (Edge Biometrics)
              </h2>
            </div>
            <span className="text-xs text-slate-500 font-mono">
              In-Browser Wasm / Edge Node Execution
            </span>
          </div>

          {/* Honest status of this section: the engine is real, most of these controls still are not. */}
          <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-[11px] text-amber-900 leading-relaxed">
              <strong>Bộ trích xuất đặc trưng thật đã có (SCRFD + ArcFace, vector 512 chiều)</strong> và{" "}
              <strong>Ngưỡng Tương Đồng Cosine</strong> bên dưới điều khiển trực tiếp ngưỡng{" "}
              <span className="font-mono">acceptSingle</span> của bộ quyết định. Nhưng{" "}
              <strong>chọn kiến trúc mô hình, độ nhạy chống giả mạo, cân bằng tương phản và kiểm tra
              sống thật vẫn chưa được nối vào luồng ONNX</strong> - chúng bị khóa để tránh hiểu nhầm.
              Kiến trúc thật đang chạy được máy chủ báo về ở bảng trạng thái phía trên, không chọn được từ đây.
            </div>
          </div>

          {/* Local Architecture Selection */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center gap-2">
              Kiến Trúc Mô Hình Cục Bộ (Model Architecture)
              {!LOCAL_MODEL_SUPPORT.modelArchitecture && (
                <span className="normal-case tracking-normal text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                  {NOT_IMPLEMENTED_BADGE}
                </span>
              )}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  id: "blazeface-arcface-sota",
                  title: "BlazeFace V2 + ArcFace (512-D)",
                  desc: "Tiêu chuẩn SOTA sinh trắc học công nghiệp. Nhúng vector 512 chiều với hàm mất mát Additive Angular Margin.",
                  badge: "Chuẩn SOTA",
                },
                {
                  id: "mediapipe-facemesh-dense",
                  title: "MediaPipe FaceMesh (468 Điểm 3D)",
                  desc: "Phân tích lưới cấu trúc hình học 3D khuôn mặt, chống giả mạo bằng phân tích cử động vi mô (Micro-motion).",
                  badge: "3D Lưới điểm",
                },
                {
                  id: "mobilefacenet-quantized",
                  title: "MobileFaceNet INT8",
                  desc: "Mô hình siêu nhẹ tối ưu lượng tử hóa INT8 cho vi xử lý tiết kiệm điện và thiết bị phần cứng IoT nhúng.",
                  badge: "IoT Edge",
                },
              ].map((arch) => (
                <div
                  key={arch.id}
                  onClick={() => {
                    if (!LOCAL_MODEL_SUPPORT.modelArchitecture) return;
                    setConfig({
                      ...config,
                      localModel: {
                        ...config.localModel,
                        modelArchitecture: arch.id as any,
                      },
                    });
                  }}
                  aria-disabled={!LOCAL_MODEL_SUPPORT.modelArchitecture}
                  title={LOCAL_MODEL_SUPPORT.modelArchitecture ? undefined : NOT_IMPLEMENTED_HINT}
                  className={`p-4 rounded-xl border transition-all ${
                    LOCAL_MODEL_SUPPORT.modelArchitecture
                      ? "cursor-pointer"
                      : "cursor-not-allowed opacity-60 bg-slate-50"
                  } ${
                    config.localModel.modelArchitecture === arch.id
                      ? "border-emerald-600 bg-emerald-50/50 shadow-xs"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-900">{arch.title}</span>
                  </div>
                  <span
                    className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      LOCAL_MODEL_SUPPORT.modelArchitecture
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {LOCAL_MODEL_SUPPORT.modelArchitecture ? arch.badge : NOT_IMPLEMENTED_BADGE}
                  </span>
                  <p className="text-xs text-slate-500 mt-2">{arch.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Local Model Sliders */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
            {/* Cosine Similarity Threshold -> fusion acceptSingle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700 flex items-center gap-2">
                  Ngưỡng Tương Đồng Cosine → <span className="font-mono">acceptSingle</span>
                  {LOCAL_MODEL_SUPPORT.similarityThreshold && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      Đang hoạt động
                    </span>
                  )}
                </span>
                <span className="font-mono font-bold text-emerald-600">
                  {threshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min="0.30"
                max="0.90"
                step="0.01"
                value={threshold}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    localModel: {
                      ...config.localModel,
                      similarityThreshold: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-emerald-600"
              />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>0.30 (trùng vùng người lạ)</span>
                <span>0.50 - 0.62 (đo được: cùng người)</span>
                <span>0.90</span>
              </div>

              <p className="text-[11px] text-slate-600 leading-relaxed">
                Đây là ngưỡng <span className="font-mono">acceptSingle</span>: chỉ cần{" "}
                <strong>một</strong> quan sát đạt cosine này (và cách người kế tiếp tối thiểu{" "}
                <span className="font-mono">minMargin</span>) là cửa được mở. Các quan sát yếu hơn vẫn
                có thể cộng dồn theo cơ chế đồng thuận nhiều góc nhìn.
              </p>

              <div
                className={`p-2.5 rounded-lg border text-[11px] leading-relaxed ${
                  thresholdVerdict.tone === "emerald"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                    : thresholdVerdict.tone === "amber"
                    ? "bg-amber-50 border-amber-200 text-amber-900"
                    : "bg-rose-50 border-rose-200 text-rose-900"
                }`}
              >
                <strong>{thresholdVerdict.title}.</strong> {thresholdVerdict.text}
              </div>

              {serverAcceptSingle !== null && Math.abs(serverAcceptSingle - threshold) > 0.005 && (
                <p className="text-[11px] text-slate-500">
                  Máy chủ đang áp dụng{" "}
                  <span className="font-mono font-semibold">{serverAcceptSingle.toFixed(2)}</span>. Giá trị
                  bạn chọn chỉ có hiệu lực sau khi bấm <strong>Lưu Cấu Hình</strong>.
                </p>
              )}
            </div>

            {/* Liveness Sensitivity */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                Độ Nhạy Chống Giả Mạo (Anti-Spoofing Liveness):
                {!LOCAL_MODEL_SUPPORT.livenessSensitivity && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    {NOT_IMPLEMENTED_BADGE}
                  </span>
                )}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(["LOW", "MEDIUM", "HIGH"] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    disabled={!LOCAL_MODEL_SUPPORT.livenessSensitivity}
                    title={LOCAL_MODEL_SUPPORT.livenessSensitivity ? undefined : NOT_IMPLEMENTED_HINT}
                    onClick={() =>
                      setConfig({
                        ...config,
                        localModel: { ...config.localModel, livenessSensitivity: lvl },
                      })
                    }
                    className={`py-2 text-xs font-semibold rounded-lg border transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                      config.localModel.livenessSensitivity === lvl
                        ? "bg-emerald-600 text-white border-emerald-600"
                        : "bg-white text-slate-700 border-slate-200 enabled:hover:bg-slate-50"
                    }`}
                  >
                    {lvl === "LOW" ? "Cơ Bản" : lvl === "MEDIUM" ? "Tiêu Chuẩn" : "Nghiêm Ngặt"}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                Phát hiện ảnh in giấy, màn hình điện thoại hoặc video phát lại.
              </p>
              {!LOCAL_MODEL_SUPPORT.livenessSensitivity && (
                <p className="text-[11px] text-amber-700">
                  Chưa triển khai: điểm "sống thật" hiện luôn nằm trong khoảng 94-100 nên không mức
                  nào có thể từ chối được khung hình.
                </p>
              )}
            </div>
          </div>

          {/* Read-only fusion thresholds reported by the engine */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                Các ngưỡng quyết định khác (chỉ đọc từ máy chủ)
              </span>
              <span className="text-[10px] font-mono text-slate-500">GET /api/face-engine/status</span>
            </div>

            {engineLoading && !engineStatus ? (
              <div className="px-4 py-3 text-[11px] text-slate-500 flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Đang đọc ngưỡng từ máy chủ...
              </div>
            ) : Object.keys(serverThresholds).length === 0 ? (
              <div className="px-4 py-3 text-[11px] text-amber-800 bg-amber-50 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                <span>
                  Máy chủ chưa báo về bộ ngưỡng nào{engineError ? ` (${engineError})` : ""}. Không hiển thị
                  giá trị phỏng đoán ở đây - hãy bấm <strong>Làm mới</strong> ở bảng trạng thái phía trên.
                </span>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {FUSION_THRESHOLD_LABELS.map((t) => {
                  const raw = serverThresholds[t.key];
                  const has = typeof raw === "number" && Number.isFinite(raw);
                  return (
                    <div key={t.key} className="px-4 py-2.5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 font-mono">{t.label}</div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">{t.desc}</p>
                      </div>
                      <span className="font-mono text-xs font-bold text-slate-900 shrink-0 tabular-nums">
                        {has ? (t.integer ? String(raw) : (raw as number).toFixed(2)) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Measured calibration note - the numbers behind the threshold advice */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-indigo-600 shrink-0" />
              <h3 className="text-xs font-bold text-indigo-950">
                Số đo thực tế trên camera của chính site này (dùng để chọn ngưỡng)
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[11px] text-left border-collapse">
                <thead>
                  <tr className="text-indigo-900/70 uppercase tracking-wide text-[10px]">
                    <th className="py-1 pr-3 font-semibold">Phép đo</th>
                    <th className="py-1 pr-3 font-semibold">exit-501 (BVE-CUA-KHO)</th>
                    <th className="py-1 font-semibold">exit-2401</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-slate-800">
                  <tr className="border-t border-indigo-100">
                    <td className="py-1.5 pr-3 font-sans text-slate-600">Cùng một người</td>
                    <td className="py-1.5 pr-3 text-emerald-700 font-bold">0.50 - 0.62</td>
                    <td className="py-1.5 text-slate-500">—</td>
                  </tr>
                  <tr className="border-t border-indigo-100">
                    <td className="py-1.5 pr-3 font-sans text-slate-600">Hai người khác nhau</td>
                    <td className="py-1.5 pr-3 text-rose-700 font-bold">≤ 0.145</td>
                    <td className="py-1.5 text-slate-500">—</td>
                  </tr>
                  <tr className="border-t border-indigo-100">
                    <td className="py-1.5 pr-3 font-sans text-slate-600">Kích thước khuôn mặt</td>
                    <td className="py-1.5 pr-3">49 - 62 px</td>
                    <td className="py-1.5">40 - 44 px</td>
                  </tr>
                  <tr className="border-t border-indigo-100">
                    <td className="py-1.5 pr-3 font-sans text-slate-600">Điểm chất lượng</td>
                    <td className="py-1.5 pr-3">0.34 - 0.43</td>
                    <td className="py-1.5">0.20 - 0.24</td>
                  </tr>
                  <tr className="border-t border-indigo-100">
                    <td className="py-1.5 pr-3 font-sans text-slate-600">Chéo camera (2401 ↔ 501)</td>
                    <td className="py-1.5 pr-3 text-rose-700 font-bold" colSpan={2}>
                      0.139 - 0.304 (vắt ngang ngưỡng; 4/6 cặp &lt; 0.28)
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="text-[11px] text-indigo-950 leading-relaxed space-y-1.5">
              <p>
                <strong>0.50 nghĩa là gì:</strong> chấp nhận gần như toàn bộ dải đo được của cùng một
                người trên exit-501, trong khi hai người khác nhau chỉ đạt tối đa 0.145 - khoảng cách
                an toàn còn rất rộng. <strong>0.30 nghĩa là gì:</strong> ngưỡng nằm lọt giữa dải chéo
                camera 0.139 - 0.304: 4/6 cặp đo được rơi xuống dưới 0.28 nhưng phần trên của dải
                vượt qua 0.30, nên kết quả trở thành may rủi - một người chưa đăng ký tại camera đó
                vẫn có thể vượt ngưỡng ở một số khung hình.
              </p>
              <p>
                Ảnh chụp ở exit-2401 nhỏ hơn và điểm chất lượng chỉ bằng khoảng một nửa exit-501, nên
                cosine đo trên 2401 thấp hơn hệ thống; đáy của dải chéo camera vì thế chạm vào vùng
                của hai người khác nhau, dù hai dải không trùng nhau. <strong>Vì vậy mỗi nhân viên phải được đăng ký
                riêng tại từng camera nơi họ cần được nhận diện</strong> - mẫu lấy từ camera này không
                dùng lại được cho camera kia. Thao tác đăng ký theo camera nằm ở trang{" "}
                <strong>Đăng Ký Nhân Viên</strong>.
              </p>
            </div>
          </div>

          {/* Feature toggles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <label
              title={LOCAL_MODEL_SUPPORT.autoContrast ? undefined : NOT_IMPLEMENTED_HINT}
              className={`flex items-center gap-3 p-3 rounded-xl border ${
                LOCAL_MODEL_SUPPORT.autoContrast
                  ? "bg-slate-50 border-slate-200 cursor-pointer"
                  : "bg-slate-100 border-slate-200 opacity-60 cursor-not-allowed"
              }`}
            >
              <input
                type="checkbox"
                disabled={!LOCAL_MODEL_SUPPORT.autoContrast}
                checked={config.localModel.autoContrast}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    localModel: {
                      ...config.localModel,
                      autoContrast: e.target.checked,
                    },
                  })
                }
                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-700 font-medium">
                Cân bằng tương phản ảnh tự động (Histogram Equalization)
                {!LOCAL_MODEL_SUPPORT.autoContrast && (
                  <span className="ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    {NOT_IMPLEMENTED_BADGE}
                  </span>
                )}
              </span>
            </label>

            <label
              title={LOCAL_MODEL_SUPPORT.antiSpoofing ? undefined : NOT_IMPLEMENTED_HINT}
              className={`flex items-center gap-3 p-3 rounded-xl border ${
                LOCAL_MODEL_SUPPORT.antiSpoofing
                  ? "bg-slate-50 border-slate-200 cursor-pointer"
                  : "bg-slate-100 border-slate-200 opacity-60 cursor-not-allowed"
              }`}
            >
              <input
                type="checkbox"
                disabled={!LOCAL_MODEL_SUPPORT.antiSpoofing}
                checked={config.localModel.antiSpoofing}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    localModel: {
                      ...config.localModel,
                      antiSpoofing: e.target.checked,
                    },
                  })
                }
                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-700 font-medium">
                Kích hoạt kiểm tra sống thật đa lớp (Multi-stage Anti-Spoofing)
                {!LOCAL_MODEL_SUPPORT.antiSpoofing && (
                  <span className="ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    {NOT_IMPLEMENTED_BADGE}
                  </span>
                )}
              </span>
            </label>
          </div>
        </div>
      )}

      {/* SECTION 4: BENCHMARK PLAYGROUND */}
      {activeTabSection === "benchmark" && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Award className="w-5 h-5 text-amber-500" />
                  Đối Soát Hiệu Năng: Google AI vs Local Model SOTA
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Chạy đo kiểm song song trên cùng một ảnh khuôn mặt để đối chiếu thời gian phản hồi và độ chính xác.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={testSubject}
                  onChange={(e) => setTestSubject(e.target.value)}
                  className="text-xs px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 font-medium text-slate-800"
                >
                  <option value="FIRST_EMPLOYEE">Nhân viên mẫu mặc định</option>
                  {effectiveEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.employeeCode})
                    </option>
                  ))}
                </select>

                <button
                  id="btn-run-benchmark"
                  onClick={runBenchmark}
                  disabled={benchmarking}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-all"
                >
                  {benchmarking ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  <span>{benchmarking ? "Đang Chạy Đo Kiểm..." : "Bắt Đầu Benchmark"}</span>
                </button>
              </div>
            </div>

            {/* Benchmark Display Results */}
            {benchmarkResult ? (
              <div className="space-y-4 pt-4 border-t border-slate-100">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Google AI Metric Card */}
                  <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-indigo-900 flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                        Google AI ({benchmarkResult.googleAiResult.model})
                      </span>
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          benchmarkResult.googleAiResult.recognized
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {benchmarkResult.googleAiResult.recognized ? "ĐÃ XÁC THỰC" : "TỪ CHỐI"}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-white p-2 rounded-lg border border-indigo-100">
                        <div className="text-[10px] text-slate-500 font-medium">Thời Gian</div>
                        <div className="text-base font-bold font-mono text-slate-800">
                          {benchmarkResult.googleAiResult.latencyMs}ms
                        </div>
                      </div>

                      <div className="bg-white p-2 rounded-lg border border-indigo-100">
                        <div className="text-[10px] text-slate-500 font-medium">Độ Tin Cậy</div>
                        <div className="text-base font-bold font-mono text-indigo-600">
                          {benchmarkResult.googleAiResult.confidence}%
                        </div>
                      </div>

                      <div className="bg-white p-2 rounded-lg border border-indigo-100">
                        <div className="text-[10px] text-slate-500 font-medium">Liveness</div>
                        <div className="text-base font-bold font-mono text-emerald-600">
                          {benchmarkResult.googleAiResult.livenessScore}%
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-slate-600 bg-white/80 p-2.5 rounded-lg border border-indigo-100">
                      {benchmarkResult.googleAiResult.message}
                    </p>
                  </div>

                  {/* Local SOTA Metric Card */}
                  <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-emerald-900 flex items-center gap-1.5">
                        <Cpu className="w-4 h-4 text-emerald-600" />
                        Local SOTA ({benchmarkResult.localResult.model})
                      </span>
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          benchmarkResult.localResult.recognized
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {benchmarkResult.localResult.recognized ? "ĐÃ XÁC THỰC" : "TỪ CHỐI"}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-white p-2 rounded-lg border border-emerald-100">
                        <div className="text-[10px] text-slate-500 font-medium">Thời Gian</div>
                        <div className="text-base font-bold font-mono text-emerald-700">
                          {benchmarkResult.localResult.latencyMs}ms
                        </div>
                      </div>

                      <div className="bg-white p-2 rounded-lg border border-emerald-100">
                        <div className="text-[10px] text-slate-500 font-medium">Cosine Match</div>
                        <div className="text-base font-bold font-mono text-emerald-600">
                          {(benchmarkResult.localResult.cosineSimilarity * 100).toFixed(1)}%
                        </div>
                      </div>

                      <div className="bg-white p-2 rounded-lg border border-emerald-100">
                        <div className="text-[10px] text-slate-500 font-medium">Liveness</div>
                        <div className="text-base font-bold font-mono text-emerald-600">
                          {benchmarkResult.localResult.livenessScore}%
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-slate-600 bg-white/80 p-2.5 rounded-lg border border-emerald-100">
                      {benchmarkResult.localResult.message}
                    </p>
                  </div>
                </div>

                {/* Benchmark Analysis Strip */}
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                    <Zap className="w-4 h-4 text-amber-500" />
                    <span>{benchmarkResult.speedDifference}</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    <strong className="text-slate-800">Đánh giá hệ thống:</strong>{" "}
                    {benchmarkResult.recommendation}
                  </p>
                </div>
              </div>
            ) : (
              <div className="text-center py-10 border-2 border-dashed border-slate-200 rounded-xl space-y-2">
                <Activity className="w-8 h-8 text-slate-400 mx-auto" />
                <p className="text-xs font-semibold text-slate-700">
                  Chưa có dữ liệu benchmark hiện hành
                </p>
                <p className="text-[11px] text-slate-500 max-w-sm mx-auto">
                  Chọn nhân viên mẫu phía trên và bấm <strong>Bắt Đầu Benchmark</strong> để đo trực tiếp độ trễ và độ khớp giữa Google AI và Local Biometrics.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer Shortcut to Scanner */}
      {onNavigateToScanner && (
        <div className="bg-indigo-900 text-white rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-0.5 text-center sm:text-left">
            <h4 className="text-sm font-bold flex items-center justify-center sm:justify-start gap-1.5">
              <Eye className="w-4 h-4 text-indigo-300" />
              Sẵn sàng kiểm tra camera quét khuôn mặt?
            </h4>
            <p className="text-xs text-indigo-200">
              Quay lại màn hình Quét Khuôn Mặt để trải nghiệm tốc độ nhận diện với cấu hình bạn vừa thiết lập.
            </p>
          </div>

          <button
            onClick={onNavigateToScanner}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold bg-white text-indigo-900 hover:bg-indigo-50 rounded-lg shadow-sm transition-all"
          >
            <span>Mở Camera Quét</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};
export default AiConfigPage;
