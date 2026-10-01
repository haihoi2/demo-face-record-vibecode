/**
 * Whether the NVR recording of an event can be played, per gate id. The server
 * only says yes/no - the NVR address never reaches the browser.
 */
import { useEffect, useState } from "react";
import { normalizeApiUrl, operatorJsonFetch } from "./api";
import { gateIdFromAny, isGateId } from "./gates";

export interface RecordingGates {
  /** Gate id -> the server can play this gate's NVR recording. */
  byGate: Record<string, boolean>;
  before: number;
  after: number;
}

const OFF: RecordingGates = { byGate: {}, before: 8, after: 7 };

/**
 * `GET /api/recordings/config`. `gates` is keyed by direction on an older
 * server ({ ENTRY, EXIT } = gates "entry"/"exit") and by gate id on a newer
 * one; a gate-id key wins over the direction spelling of the same gate.
 */
export function readRecordingGates(data: unknown): RecordingGates {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (d.success !== true || !d.enabled) return OFF;
  const byGate: Record<string, boolean> = {};
  const gates = d.gates && typeof d.gates === "object" ? (d.gates as Record<string, unknown>) : {};
  const keys = Object.keys(gates);
  for (const key of keys.filter((k) => !isGateId(k))) {
    const id = gateIdFromAny(key);
    if (id) byGate[id] = Boolean(gates[key]);
  }
  for (const key of keys.filter((k) => isGateId(k))) byGate[key] = Boolean(gates[key]);
  const w = d.windowSeconds && typeof d.windowSeconds === "object" ? (d.windowSeconds as Record<string, unknown>) : {};
  return { byGate, before: Number(w.before) || OFF.before, after: Number(w.after) || OFF.after };
}

/** Whether an event's gate has a playable recording. */
export function gateHasRecording(gates: RecordingGates, gateId: string): boolean {
  return gates.byGate[gateId] === true;
}

let cached: Promise<RecordingGates> | null = null;

function loadRecordingGates(): Promise<RecordingGates> {
  cached ||= operatorJsonFetch<any>("/api/recordings/config").then((res) => {
    if (!res.ok) {
      cached = null; // signed out or offline: ask again next time
      return OFF;
    }
    return readRecordingGates(res.data);
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
