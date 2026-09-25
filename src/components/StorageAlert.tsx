import React, { useEffect, useState } from "react";
import { DatabaseZap } from "lucide-react";
import { operatorJsonFetch } from "../utils/api";
import { useOperatorSession } from "../utils/session";

interface StorageStatus {
  success: boolean;
  expected: "postgresql" | "local";
  active: "postgresql" | "sqlite" | "json" | "connecting";
  degraded: boolean;
  since: string | null;
  reason: string | null;
}

const POLL_MS = 60_000;

/**
 * Red banner while the gateway is not writing to PostgreSQL (fell back to its
 * local store at startup, or lost the connection). Records written meanwhile
 * exist only on the gateway host and must be copied back, so everyone signed
 * in should see it - not just whoever reads the server log.
 */
export const StorageAlert: React.FC = () => {
  const session = useOperatorSession();
  const [status, setStatus] = useState<StorageStatus | null>(null);

  useEffect(() => {
    if (!session) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const res = await operatorJsonFetch<StorageStatus>("/api/storage-status");
      if (!cancelled && res.ok && res.data?.success) setStatus(res.data);
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);

  if (!status?.degraded) return null;
  const since = status.since
    ? new Date(status.since).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })
    : null;
  const where = status.active === "sqlite" ? "SQLite dự phòng" : status.active === "json" ? "tệp JSON dự phòng" : "PostgreSQL (mất kết nối)";

  return (
    <div
      role="alert"
      data-testid="storage-degraded-alert"
      className="mb-4 flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-xs text-rose-900"
    >
      <DatabaseZap className="w-5 h-5 shrink-0 text-rose-600" />
      <div className="space-y-0.5">
        <div className="font-bold">
          Cơ sở dữ liệu chính không hoạt động — đang ghi vào {where}
          {since && <span className="font-normal"> (từ {since})</span>}
        </div>
        <div>{status.reason}</div>
        <div className="text-rose-700">
          Cổng vẫn hoạt động. Báo quản trị viên kiểm tra PostgreSQL và khởi động lại gateway; các bản ghi trong thời gian
          này cần được chép lại.
        </div>
      </div>
    </div>
  );
};
