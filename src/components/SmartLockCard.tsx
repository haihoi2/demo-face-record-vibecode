import React, { useState } from "react";
import {
  Lock,
  Unlock,
  Radio,
  BatteryCharging,
  Wifi,
  Cpu,
  Code2,
  Copy,
  Check,
  Zap,
  Power,
  RefreshCw,
} from "lucide-react";
import { SmartLockState } from "../types";
import { soundEffects } from "../utils/audio";
import { apiFetch } from "../utils/api";

interface SmartLockCardProps {
  lockState: SmartLockState;
  onRefresh: () => void;
}

export const SmartLockCard: React.FC<SmartLockCardProps> = ({
  lockState,
  onRefresh,
}) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [isTriggering, setIsTriggering] = useState<boolean>(false);

  const handleManualUnlock = async () => {
    setIsTriggering(true);
    try {
      soundEffects.playLockClick();
      await apiFetch("/api/lock/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "Bảng Điều Khiển Khóa Thông Minh",
          reason: "Kích hoạt thủ công từ Dashboard Quản trị",
        }),
      });
      soundEffects.playSuccess();
    } catch (err) {
      console.error("Lỗi mở khóa:", err);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleManualLock = async () => {
    setIsTriggering(true);
    try {
      soundEffects.playLockClick();
      await apiFetch("/api/lock/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "Bảng Điều Khiển Khóa Thông Minh",
        }),
      });
    } catch (err) {
      console.error("Lỗi đóng khóa:", err);
    } finally {
      setIsTriggering(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const apiCurlUnlock = `curl -X POST https://your-domain.com/api/lock/unlock \\
  -H "Content-Type: application/json" \\
  -d '{"source": "AI_FACE_RECOGNITION", "employeeId": "NV-1082"}'`;

  const apiCurlStatus = `curl -X GET https://your-domain.com/api/lock/status`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Physical Smart Lock Visualization */}
        <div className="lg:col-span-6 bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center">
                  <Cpu className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">
                    Khóa Cửa Thông Minh (Smart Lock Hardware)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Model: SmartLock-Pro Gen 3 • Zigbee 3.0 / REST API
                  </p>
                </div>
              </div>

              <button
                onClick={onRefresh}
                className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"
                title="Làm mới trạng thái"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Realistic Hardware Lock Graphic */}
            <div className="my-6 py-8 px-6 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800 text-center relative overflow-hidden">
              {/* Circuit lines decorative background */}
              <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#6366f1_1px,transparent_1px)] [background-size:16px_16px]" />

              {/* Status LED */}
              <div className="flex items-center justify-center gap-2 mb-4">
                <span
                  className={`w-3 h-3 rounded-full transition-all duration-300 ${
                    lockState.isLocked
                      ? "bg-rose-500 shadow-[0_0_12px_#f43f5e]"
                      : "bg-emerald-400 shadow-[0_0_12px_#34d399] animate-pulse"
                  }`}
                />
                <span className="text-xs font-mono tracking-widest text-slate-400 uppercase">
                  LED STATUS: {lockState.isLocked ? "BOLT LOCKED" : "BOLT RETRACTED"}
                </span>
              </div>

              {/* Bolt Cylinder Mechanical Graphic */}
              <div className="relative inline-block my-4">
                <div
                  className={`w-32 h-32 rounded-3xl mx-auto flex items-center justify-center border-4 transition-all duration-500 shadow-2xl ${
                    lockState.isLocked
                      ? "bg-slate-800/90 border-slate-700 text-slate-400"
                      : "bg-emerald-950/90 border-emerald-500 text-emerald-400 scale-105"
                  }`}
                >
                  {lockState.isLocked ? (
                    <Lock className="w-14 h-14 text-rose-400 transition-transform duration-300" />
                  ) : (
                    <Unlock className="w-14 h-14 text-emerald-400 animate-bounce" />
                  )}
                </div>

                {/* Mechanical Bolt indicator */}
                <div
                  className={`absolute top-1/2 -right-6 -translate-y-1/2 h-8 rounded-r-md transition-all duration-500 bg-gradient-to-r from-slate-400 to-slate-200 border border-slate-300 ${
                    lockState.isLocked ? "w-10 opacity-100" : "w-1 opacity-20"
                  }`}
                  title={lockState.isLocked ? "Chốt khóa đang gài" : "Chốt khóa đang thu vào"}
                />
              </div>

              {/* Lock Label */}
              <h4 className="text-white font-bold text-lg mt-2">
                {lockState.doorName}
              </h4>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                ID: {lockState.lockId} • Firmware: {lockState.firmwareVersion}
              </p>

              {/* Auto-relock progress bar */}
              {!lockState.isLocked && (
                <div className="mt-4 max-w-xs mx-auto">
                  <div className="flex justify-between text-xs text-emerald-300 font-medium mb-1">
                    <span>Đang mở cửa</span>
                    <span>Tự khóa sau: {lockState.remainingRelockSeconds}s</span>
                  </div>
                  <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full transition-all duration-1000"
                      style={{
                        width: `${(lockState.remainingRelockSeconds / lockState.autoRelockSeconds) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Hardware Telemetry Bar */}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div className="flex items-center justify-center gap-1 text-slate-500 text-xs mb-1">
                  <BatteryCharging className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Dung lượng Pin</span>
                </div>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {lockState.batteryLevel}%
                </span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div className="flex items-center justify-center gap-1 text-slate-500 text-xs mb-1">
                  <Wifi className="w-3.5 h-3.5 text-blue-600" />
                  <span>Tín hiệu sóng</span>
                </div>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {lockState.signalDbm} dBm
                </span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div className="flex items-center justify-center gap-1 text-slate-500 text-xs mb-1">
                  <Radio className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Trạng thái</span>
                </div>
                <span className="font-semibold text-emerald-600 text-xs">
                  {lockState.status}
                </span>
              </div>
            </div>
          </div>

          {/* Action Trigger Buttons */}
          <div className="pt-5 border-t border-slate-100 mt-5 flex gap-3">
            <button
              id="btn-trigger-unlock-api"
              disabled={isTriggering || !lockState.isLocked}
              onClick={handleManualUnlock}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-semibold rounded-xl text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-xs"
            >
              <Unlock className="w-4 h-4" />
              <span>Gửi Lệnh Mở Khóa Qua API</span>
            </button>

            <button
              id="btn-trigger-lock-api"
              disabled={isTriggering || lockState.isLocked}
              onClick={handleManualLock}
              className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-semibold rounded-xl text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-xs"
            >
              <Lock className="w-4 h-4" />
              <span>Gửi Lệnh Đóng Khóa</span>
            </button>
          </div>
        </div>

        {/* API Integration & Webhook Endpoints Documentation */}
        <div className="lg:col-span-6 bg-slate-900 text-slate-200 rounded-2xl p-6 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 rounded-xl bg-indigo-600/30 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                <Code2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-white text-sm">
                  Tài Liệu Kết Nối Khóa Thông Minh Qua REST API
                </h3>
                <p className="text-xs text-slate-400">
                  Hệ thống AI tương tác trực tiếp với API khóa thông minh
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Endpoint 1: Unlock Door */}
              <div className="bg-slate-950 rounded-xl p-3.5 border border-slate-800">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                      POST
                    </span>
                    <span className="font-mono text-xs text-white">/api/lock/unlock</span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(apiCurlUnlock, 1)}
                    className="text-slate-400 hover:text-white text-xs flex items-center gap-1 transition"
                  >
                    {copiedIndex === 1 ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>Sao chép curl</span>
                  </button>
                </div>
                <p className="text-xs text-slate-400 mb-2 leading-relaxed">
                  Lệnh gửi từ AI Recognition Engine khi khuôn mặt nhân viên được xác minh thành công. Khóa sẽ tự động rút chốt và bắt đầu đếm ngược tự đóng lại.
                </p>
                <pre className="text-[11px] font-mono text-indigo-300 bg-slate-900/80 p-2 rounded-lg overflow-x-auto">
                  {`{\n  "source": "AI_FACE_RECOGNITION",\n  "employeeId": "NV-1082",\n  "employeeName": "Nguyễn Hoàng Minh"\n}`}
                </pre>
              </div>

              {/* Endpoint 2: Lock Status */}
              <div className="bg-slate-950 rounded-xl p-3.5 border border-slate-800">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-blue-950 text-blue-400 border border-blue-800">
                      GET
                    </span>
                    <span className="font-mono text-xs text-white">/api/lock/status</span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(apiCurlStatus, 2)}
                    className="text-slate-400 hover:text-white text-xs flex items-center gap-1 transition"
                  >
                    {copiedIndex === 2 ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>Sao chép curl</span>
                  </button>
                </div>
                <p className="text-xs text-slate-400 mb-2 leading-relaxed">
                  Truy vấn trạng thái chốt khóa vật lý, pin, tín hiệu và sự kiện mở khóa gần nhất.
                </p>
                <pre className="text-[11px] font-mono text-emerald-300 bg-slate-900/80 p-2 rounded-lg overflow-x-auto">
                  {`{\n  "state": "UNLOCKED",\n  "batteryLevel": 96,\n  "signalDbm": -54,\n  "autoRelockSeconds": 6\n}`}
                </pre>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Power className="w-3.5 h-3.5 text-emerald-400" />
              Gateway API Server: <strong>Port 3000 (Active)</strong>
            </span>
            <span className="text-slate-500 font-mono">Protocols: HTTP/SSE/MQTT</span>
          </div>
        </div>
      </div>
    </div>
  );
};
