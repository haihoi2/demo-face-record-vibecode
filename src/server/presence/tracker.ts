/**
 * Person tracker for presence detection (P2), the P1b linking rule made
 * per-person: detections up to `linkGapMs` (2 s) apart belong to one track,
 * so a person seen by RTMDet-tiny only every 4th frame (0.5 fps) stays one track.
 *
 * Association (greedy, cheapest first) of a detection at time t with an open
 * track uses the track's box NEAREST IN TIME to t (detections may arrive late:
 * RTMDet answers ~0.6-0.8 s after the frame it ran on):
 *   - same person if IoU >= 0.3, or if the centre moved at most
 *     (0.5 + 1.0 * |dt| in s) box heights and the heights differ by < 2.5x
 *     (a walking person covers about one body height per second; occlusion by
 *     cage bars changes the box height a lot);
 *   - a track takes at most one detection per frame time.
 * Unmatched detections start new tracks. Pure and synchronous; times are the
 * frames' capture times (ms since epoch).
 */
import type { Box, PersonDetection, PresenceModelId } from "./contracts";
import { boxIou } from "./detectors";

export const ASSOC_IOU = 0.3;
export const ASSOC_BASE_HEIGHTS = 0.5;
export const ASSOC_HEIGHTS_PER_S = 1.0;
export const ASSOC_MAX_HEIGHT_RATIO = 2.5;
/** Recent boxes kept per track for late association (beyond 2 x linkGap they are never nearest). */
const RECENT_KEEP = 24;

export interface TrackBest {
  box: Box;
  score: number;
  t: number;
  model: PresenceModelId;
}

export interface PresenceTrack {
  id: string;
  firstSeen: number;
  lastSeen: number;
  /** Distinct frame times with a detection. */
  frames: Set<number>;
  /** Most recent detections (time-ordered), for association. */
  recent: Array<{ t: number; box: Box }>;
  best: TrackBest;
  models: Set<PresenceModelId>;
  /** Most tracks detected in one frame while this track was seen. */
  peak: number;
  /** Set by the rules (presenceCore). */
  qualified: boolean;
  period?: "working" | "after-hours";
}

const height = (b: readonly number[]) => Math.max(1e-6, b[3] - b[1]);
const centre = (b: readonly number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** Association cost of a detection with a reference box dt ms apart, or null when not the same person. Pure. */
export function associationCost(ref: readonly number[], det: readonly number[], dtMs: number): number | null {
  const iou = boxIou(ref, det);
  const hr = height(ref);
  const hd = height(det);
  const [cx1, cy1] = centre(ref);
  const [cx2, cy2] = centre(det);
  const dist = Math.hypot(cx2 - cx1, cy2 - cy1) / Math.max(hr, hd);
  if (iou >= ASSOC_IOU) return dist;
  const ratio = Math.max(hr, hd) / Math.min(hr, hd);
  if (ratio >= ASSOC_MAX_HEIGHT_RATIO) return null;
  const allowed = ASSOC_BASE_HEIGHTS + (ASSOC_HEIGHTS_PER_S * Math.abs(dtMs)) / 1000;
  return dist <= allowed ? dist : null;
}

export interface ObserveResult {
  /** Tracks that got a detection (new or existing). */
  touched: PresenceTrack[];
  /** Tracks whose best box changed (the host keeps that frame's pixels for the crop). */
  bestChanged: PresenceTrack[];
  /** Track id per input detection (same order as `dets`). */
  assignments: string[];
}

export class PresenceTracker {
  private readonly tracks = new Map<string, PresenceTrack>();
  /** frame time -> ids of tracks detected in that frame (peak persons). */
  private readonly perFrame = new Map<number, Set<string>>();
  private seq = 0;

  constructor(private readonly opts: { linkGapMs: number; idPrefix: string; maxOpenTracks?: number }) {}

  open(): PresenceTrack[] {
    return [...this.tracks.values()];
  }

  get(id: string): PresenceTrack | undefined {
    return this.tracks.get(id);
  }

  /** Adds one frame's detections (time t). */
  observe(t: number, dets: PersonDetection[]): ObserveResult {
    const touched: PresenceTrack[] = [];
    const bestChanged: PresenceTrack[] = [];
    const assignments: string[] = new Array(dets.length);
    if (!dets.length) return { touched, bestChanged, assignments };
    const pairs: Array<{ cost: number; d: number; track: PresenceTrack }> = [];
    for (const track of this.tracks.values()) {
      if (track.frames.has(t)) continue;
      const ref = nearest(track.recent, t);
      if (!ref || Math.abs(ref.t - t) > this.opts.linkGapMs) continue;
      dets.forEach((det, d) => {
        const cost = associationCost(ref.box, det.box, t - ref.t);
        if (cost !== null) pairs.push({ cost, d, track });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const usedDet = new Set<number>();
    const usedTrack = new Set<string>();
    for (const p of pairs) {
      if (usedDet.has(p.d) || usedTrack.has(p.track.id)) continue;
      usedDet.add(p.d);
      usedTrack.add(p.track.id);
      if (this.add(p.track, t, dets[p.d])) bestChanged.push(p.track);
      touched.push(p.track);
      assignments[p.d] = p.track.id;
    }
    dets.forEach((det, d) => {
      if (usedDet.has(d)) return;
      const track = this.create(t, det);
      touched.push(track);
      bestChanged.push(track);
      assignments[d] = track.id;
    });
    this.countFrame(t, touched);
    return { touched, bestChanged, assignments };
  }

  /**
   * A second model's box for a person already detected at t (cross-model NMS
   * kept the higher-score box): updates best box and contributing models only.
   * Returns true when the best box changed.
   */
  confirm(trackId: string, t: number, det: PersonDetection): boolean {
    const track = this.tracks.get(trackId);
    if (!track) return false;
    track.models.add(det.model);
    if (det.score > track.best.score) {
      track.best = { box: [...det.box] as Box, score: det.score, t, model: det.model };
      return true;
    }
    return false;
  }

  /** Removes and returns tracks for which `ended(track)` is true. */
  expire(ended: (track: PresenceTrack) => boolean): PresenceTrack[] {
    const out: PresenceTrack[] = [];
    for (const track of [...this.tracks.values()]) {
      if (ended(track)) {
        this.tracks.delete(track.id);
        out.push(track);
      }
    }
    this.prune();
    return out;
  }

  /** Removes and returns every open track. */
  endAll(): PresenceTrack[] {
    const out = [...this.tracks.values()];
    this.tracks.clear();
    this.perFrame.clear();
    return out;
  }

  private create(t: number, det: PersonDetection): PresenceTrack {
    this.seq += 1;
    const track: PresenceTrack = {
      id: `${this.opts.idPrefix}-${this.seq}`,
      firstSeen: t,
      lastSeen: t,
      frames: new Set([t]),
      recent: [{ t, box: [...det.box] as Box }],
      best: { box: [...det.box] as Box, score: det.score, t, model: det.model },
      models: new Set([det.model]),
      peak: 1,
      qualified: false,
    };
    this.tracks.set(track.id, track);
    return track;
  }

  /** Returns true when the best box changed. */
  private add(track: PresenceTrack, t: number, det: PersonDetection): boolean {
    track.frames.add(t);
    track.firstSeen = Math.min(track.firstSeen, t);
    track.lastSeen = Math.max(track.lastSeen, t);
    track.models.add(det.model);
    const r = track.recent;
    let i = r.length;
    while (i > 0 && r[i - 1].t > t) i -= 1;
    r.splice(i, 0, { t, box: [...det.box] as Box });
    if (r.length > RECENT_KEEP) r.splice(0, r.length - RECENT_KEEP);
    if (det.score > track.best.score) {
      track.best = { box: [...det.box] as Box, score: det.score, t, model: det.model };
      return true;
    }
    return false;
  }

  private countFrame(t: number, touched: PresenceTrack[]): void {
    let ids = this.perFrame.get(t);
    if (!ids) {
      ids = new Set();
      this.perFrame.set(t, ids);
    }
    for (const tr of touched) ids.add(tr.id);
    const n = ids.size;
    for (const id of ids) {
      const tr = this.tracks.get(id);
      if (tr && n > tr.peak) tr.peak = n;
    }
  }

  private prune(): void {
    let oldest = Infinity;
    for (const tr of this.tracks.values()) oldest = Math.min(oldest, tr.firstSeen);
    for (const t of this.perFrame.keys()) if (t < oldest - this.opts.linkGapMs) this.perFrame.delete(t);
  }
}

function nearest(recent: Array<{ t: number; box: Box }>, t: number): { t: number; box: Box } | null {
  let best: { t: number; box: Box } | null = null;
  for (const r of recent) if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  return best;
}
