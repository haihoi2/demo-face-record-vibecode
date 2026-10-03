/**
 * Presence rules (P2), pure and synchronous: detections in, PresenceEventDraft
 * out. Runs on the presence host (main thread; a few boxes per frame).
 *
 *   primary(t, YOLOX boxes)      every processed frame, in order
 *   secondary(t, RTMDet boxes)   every 4th frame, LATE (after later primaries)
 *     -> cross-model NMS 0.5 with the primary boxes of the same frame t: an
 *        RTMDet box overlapping a YOLOX box (IoU > 0.5) is the same detection
 *        (it only updates the track's best box / models when its score is
 *        higher); the others are new detections at t
 *   tracker (tracker.ts) -> tracks
 *   rules:
 *     in view = lastSeen - firstSeen + one frame period (P1b's episode length:
 *       6 frames at 2 fps = 3.0 s)
 *     period = working hours or after hours at the track's latest detection,
 *       local time in rules.workingHours.timeZone (Asia/Ho_Chi_Minh)
 *     a track QUALIFIES once in view >= 3 s (working) / 1 s (after hours):
 *       one draft (final = false);
 *     a track ENDS when nothing was seen for longer than linkGapMs and no
 *       frame that could still extend it is being processed: one final draft
 *       for a qualified track; unqualified tracks end silently.
 * Never sends anything and never touches a door; the host forwards drafts.
 */
import type { Box, PersonDetection, PresenceEventDraft, PresenceModelId, PresenceRules } from "./contracts";
import { boxIou, NMS_IOU } from "./detectors";
import { PresenceTracker, type PresenceTrack } from "./tracker";

export type PresencePeriod = "working" | "after-hours";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in `timeZone`. */
export function localMinutes(ms: number, timeZone: string): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return (h % 24) * 60 + m;
}

const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

/** Working hours [start, end) local; a window crossing midnight (e.g. 22:00-06:00) is supported. */
export function periodAt(ms: number, rules: Pick<PresenceRules, "workingHours">): PresencePeriod {
  const m = localMinutes(ms, rules.workingHours.timeZone);
  const s = hhmm(rules.workingHours.start);
  const e = hhmm(rules.workingHours.end);
  const working = s < e ? m >= s && m < e : m >= s || m < e;
  return working ? "working" : "after-hours";
}

export function minInViewMs(period: PresencePeriod, rules: PresenceRules): number {
  return period === "working" ? rules.minInViewMsWorking : rules.minInViewMsAfterHours;
}

export interface PresenceCoreOptions {
  gateId: string;
  rules: PresenceRules;
  /** Nominal time between processed frames (1000 / PRESENCE_FPS). */
  framePeriodMs: number;
  /** Track id prefix base; default Date.now() at construction ("P-<epochMs>"). */
  runStartedAtMs?: number;
  /** Open tracks beyond this end the stalest one (memory bound). Default 64. */
  maxOpenTracks?: number;
}

export interface CoreUpdate {
  drafts: PresenceEventDraft[];
  /** Tracks whose best box changed at frame time `t` (the host keeps that frame for the crop). */
  bestChanged: Array<{ trackId: string; t: number }>;
  /** Tracks that ended (qualified or not): the host releases their best frames. */
  ended: string[];
}

interface PrimaryFrame {
  dets: Array<{ det: PersonDetection; trackId: string | null }>;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class PresenceCore {
  readonly gateId: string;
  private readonly tracker: PresenceTracker;
  private readonly rules: PresenceRules;
  private readonly framePeriodMs: number;
  private readonly maxOpen: number;
  /** Primary boxes per frame time, kept for the late secondary merge. */
  private readonly primaries = new Map<number, PrimaryFrame>();
  private latestT = -Infinity;
  readonly counters = { tracks: 0, qualified: 0, finals: 0, droppedUnqualified: 0, secondaryMerged: 0, secondaryNew: 0 };

  constructor(opts: PresenceCoreOptions) {
    this.gateId = opts.gateId;
    this.rules = opts.rules;
    this.framePeriodMs = Math.max(1, opts.framePeriodMs);
    this.maxOpen = Math.max(1, opts.maxOpenTracks ?? 64);
    this.tracker = new PresenceTracker({ linkGapMs: opts.rules.linkGapMs, idPrefix: `P-${opts.runStartedAtMs ?? Date.now()}` });
  }

  openTracks(): number {
    return this.tracker.open().length;
  }

  /** Primary model (YOLOX-Nano) boxes of the frame captured at t. */
  primary(t: number, dets: PersonDetection[]): CoreUpdate {
    const up: CoreUpdate = { drafts: [], bestChanged: [], ended: [] };
    this.latestT = Math.max(this.latestT, t);
    const res = this.tracker.observe(t, dets);
    this.primaries.set(t, { dets: dets.map((det, i) => ({ det, trackId: res.assignments[i] ?? null })) });
    this.afterObserve(t, res.touched, res.bestChanged, up);
    this.prunePrimaries();
    return up;
  }

  /** Secondary model (RTMDet-tiny) boxes of the frame captured at t (may arrive after later primaries). */
  secondary(t: number, dets: PersonDetection[]): CoreUpdate {
    const up: CoreUpdate = { drafts: [], bestChanged: [], ended: [] };
    const prim = this.primaries.get(t)?.dets ?? [];
    const fresh: PersonDetection[] = [];
    for (const det of dets) {
      // Cross-model NMS: the highest-scoring box of an overlapping group survives.
      let hit: { det: PersonDetection; trackId: string | null } | undefined;
      for (const p of prim) if (boxIou(det.box, p.det.box) > NMS_IOU && (!hit || p.det.score > hit.det.score)) hit = p;
      if (!hit) {
        fresh.push(det);
        continue;
      }
      this.counters.secondaryMerged += 1;
      if (det.score > hit.det.score && hit.trackId && this.tracker.confirm(hit.trackId, t, det)) {
        up.bestChanged.push({ trackId: hit.trackId, t });
      }
    }
    if (fresh.length) {
      this.counters.secondaryNew += fresh.length;
      const res = this.tracker.observe(t, fresh);
      this.afterObserve(t, res.touched, res.bestChanged, up);
    }
    return up;
  }

  /**
   * Ends tracks not seen for longer than linkGapMs at `nowMs`, unless a frame
   * captured within the gap after their last detection is still being processed
   * (`pendingFrameTimes`: frames sent to a detector and not answered yet).
   */
  tick(nowMs: number, pendingFrameTimes: number[] = []): CoreUpdate {
    const up: CoreUpdate = { drafts: [], bestChanged: [], ended: [] };
    const gap = this.rules.linkGapMs;
    const ended = this.tracker.expire((tr) => {
      if (nowMs - tr.lastSeen <= gap) return false;
      return !pendingFrameTimes.some((p) => p > tr.lastSeen && p - tr.lastSeen <= gap);
    });
    for (const tr of ended) this.finish(tr, up);
    return up;
  }

  /** Ends every open track (stop / worker loss): final drafts for the qualified ones. */
  endAll(): CoreUpdate {
    const up: CoreUpdate = { drafts: [], bestChanged: [], ended: [] };
    for (const tr of this.tracker.endAll()) this.finish(tr, up);
    this.primaries.clear();
    return up;
  }

  inViewMs(tr: PresenceTrack): number {
    return tr.lastSeen - tr.firstSeen + this.framePeriodMs;
  }

  private afterObserve(t: number, touched: PresenceTrack[], bestChanged: PresenceTrack[], up: CoreUpdate): void {
    for (const tr of bestChanged) up.bestChanged.push({ trackId: tr.id, t });
    for (const tr of touched) {
      if (tr.frames.size === 1 && tr.firstSeen === t && tr.lastSeen === t) this.counters.tracks += 1;
      if (tr.qualified) continue;
      const period = periodAt(tr.lastSeen, this.rules);
      if (this.inViewMs(tr) >= minInViewMs(period, this.rules)) {
        tr.qualified = true;
        tr.period = period;
        this.counters.qualified += 1;
        up.drafts.push(this.draft(tr, false));
      }
    }
    const open = this.tracker.open();
    if (open.length > this.maxOpen) {
      const stalest = open.sort((a, b) => a.lastSeen - b.lastSeen).slice(0, open.length - this.maxOpen);
      const ids = new Set(stalest.map((s) => s.id));
      for (const tr of this.tracker.expire((x) => ids.has(x.id))) this.finish(tr, up);
    }
  }

  private finish(tr: PresenceTrack, up: CoreUpdate): void {
    up.ended.push(tr.id);
    if (tr.qualified) {
      this.counters.finals += 1;
      up.drafts.push(this.draft(tr, true));
    } else {
      this.counters.droppedUnqualified += 1;
    }
  }

  private draft(tr: PresenceTrack, final: boolean): PresenceEventDraft {
    const models = (["yolox-nano", "rtmdet-tiny"] as PresenceModelId[]).filter((m) => tr.models.has(m));
    return {
      gateId: this.gateId,
      trackId: tr.id,
      startedAt: iso(tr.firstSeen),
      lastSeenAt: iso(tr.lastSeen),
      final,
      inViewMs: Math.round(this.inViewMs(tr)),
      framesSeen: tr.frames.size,
      peakPersons: tr.peak,
      period: tr.period ?? periodAt(tr.lastSeen, this.rules),
      bestBox: tr.best.box.map((v) => Math.round(v * 10) / 10) as Box,
      bestScore: Math.round(tr.best.score * 1000) / 1000,
      bestFrameAt: iso(tr.best.t),
      models,
    };
  }

  private prunePrimaries(): void {
    const keepFrom = this.latestT - 4 * this.rules.linkGapMs;
    for (const t of this.primaries.keys()) if (t < keepFrom) this.primaries.delete(t);
  }
}
