/**
 * Whether the NVR recording of an event can be played, per gate. The server
 * only says yes/no - the NVR address never reaches the browser.
 */
import { useEffect, useState } from "react";
import { normalizeApiUrl, operatorJsonFetch } from "./api";

export interface RecordingGates {
  ENTRY: boolean;
  EXIT: boolean;
  before: number;
  after: number;
}

const OFF: RecordingGates = { ENTRY: false, EXIT: false, before: 8, after: 7 };
let cached: Promise<RecordingGates> | null = null;

function loadRecordingGates(): Promise<RecordingGates> {
  cached ||= operatorJsonFetch<any>("/api/recordings/config").then((res) => {
    if (!res.ok || !res.data?.success || !res.data.enabled) {
      if (!res.ok) cached = null; // signed out or offline: ask again next time
      return OFF;
    }
    return {
      ENTRY: Boolean(res.data.gates?.ENTRY),
      EXIT: Boolean(res.data.gates?.EXIT),
      before: Number(res.data.windowSeconds?.before) || OFF.before,
      after: Number(res.data.windowSeconds?.after) || OFF.after,
    };
  });
  return cached;
}

export function useRecordingGates(): RecordingGates {
  const [gates, setGates] = useState<RecordingGates>(OFF);
  useEffect(() => {
    let active = true;
    void loadRecordingGates().then((g) => active && setGates(g));
    return () => {
      active = false;
    };
  }, []);
  return gates;
}

export function recordingUrl(logId: string): string {
  return normalizeApiUrl(`/api/logs/${encodeURIComponent(logId)}/recording`);
}
