/**
 * Presence alerts (P3a, owner 2026-10-05): which presence events message the
 * security group, how they are grouped, and the message text. Pure: the server
 * feeds events and a clock, and sends what due() returns.
 *
 * Rules (plan docs/plans/2026-10-02-person-presence-alerts.md, section 9):
 *  - only after hours (19:00-07:00 by default; the event's own period);
 *  - only when no face was seen (faceOutcome "none"). A recognised employee
 *    is never alerted; a face seen as a stranger already raised the stranger
 *    alert, so it is not alerted twice;
 *  - an event is decided `holdMs` after it first arrives, on its latest
 *    version, so a door scan that recognises the person a moment later still
 *    counts (2026-10-07: the scan comes 5.8 s after the person appears at the
 *    median, 17 s at the 90th percentile; 3 s alerted 8 employees in one
 *    morning, so the server default is 15 s);
 *  - per gate, the first alert goes out at once; after that at most one
 *    message per `windowMs`, summarising everything that arrived meanwhile
 *    (owner: "một tin gộp mỗi 5 phút" - 93 single messages in two mornings
 *    would have been 16);
 *  - text and a login-protected link only: no image leaves the system.
 */

export interface PresenceAlertEvent {
  id: string;
  gateId: string;
  startedAt: string;
  inViewMs: number;
  peakPersons: number;
  period: "working" | "after-hours";
  faceOutcome: "none" | "stranger" | "employee";
  /** Best box [x1, y1, x2, y2] in source pixels, for the static-object rule. */
  box?: [number, number, number, number];
  /** Best detector score; only low-confidence detections can be a static object. */
  score?: number;
}

export interface PresenceAlertBatch {
  gateId: string;
  events: PresenceAlertEvent[];
}

/**
 * Static objects (2026-10-28): a dark object on the stacked boxes in view of the
 * entry camera was read as a person (score ~0.32) thousands of times a night -
 * up to 6,300 events and 130 messages a night. A person walking through is ONE
 * track; a flickering false detection is many short events on the SAME box.
 * When `minHits` separate events overlap the same box (IoU >= `iou`) within
 * `windowMs`, that spot is static and its events are not alerted (they are
 * still recorded). A spot is forgotten after `windowMs` without a hit.
 *
 * Only LOW-confidence detections count (score < `maxScore`): the object scored
 * ~0.32, while a night-shift worker repeatedly pushing cages at one spot scored
 * ~0.67 - a real person is never silenced by this rule.
 */
export interface StaticSpotOptions { windowMs: number; minHits: number; iou: number; maxScore: number }
export const DEFAULT_STATIC_SPOTS: StaticSpotOptions = { windowMs: 30 * 60_000, minHits: 6, iou: 0.7, maxScore: 0.45 };

type Box = [number, number, number, number];
function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: Box) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

export class StaticSpotTracker {
  private readonly spots = new Map<string, Array<{ box: Box; hits: number[] }>>();
  constructor(private readonly opts: StaticSpotOptions = DEFAULT_STATIC_SPOTS) {}

  /** Whether a detection of this score can belong to a static object. */
  counts(score: number | undefined): boolean {
    return typeof score === "number" && score < this.opts.maxScore;
  }

  /** Records one new event's box; returns whether that spot is static now, and whether it just became so. */
  hit(gateId: string, box: Box, nowMs: number): { isStatic: boolean; becameStatic: boolean } {
    const list = (this.spots.get(gateId) || []).filter((sp) => {
      sp.hits = sp.hits.filter((t) => nowMs - t <= this.opts.windowMs);
      return sp.hits.length > 0;
    });
    let spot = list.find((sp) => iou(sp.box, box) >= this.opts.iou);
    if (!spot) {
      spot = { box, hits: [] };
      list.push(spot);
      if (list.length > 200) list.shift();
    }
    const before = spot.hits.length >= this.opts.minHits;
    spot.hits.push(nowMs);
    spot.box = box;
    this.spots.set(gateId, list);
    const isStatic = spot.hits.length >= this.opts.minHits;
    return { isStatic, becameStatic: isStatic && !before };
  }

  /** Static spots per gate right now (for status and logs). */
  staticSpots(gateId: string, nowMs: number): Box[] {
    return (this.spots.get(gateId) || [])
      .filter((sp) => sp.hits.filter((t) => nowMs - t <= this.opts.windowMs).length >= this.opts.minHits)
      .map((sp) => [...sp.box] as Box);
  }
}

export interface PresenceAlertOptions {
  windowMs: number;
  holdMs: number;
  /** Per-gate window (P3b settings); default `windowMs`. */
  windowMsFor?: (gateId: string) => number;
  /** Static-object rule; omitted = off. */
  staticSpots?: StaticSpotTracker;
  /** Called when a spot first becomes static (for one log line). */
  onStaticSpot?: (gateId: string, box: [number, number, number, number]) => void;
}

/** Whether an event messages the security group (see the module comment). */
export function presenceAlertEligible(e: Pick<PresenceAlertEvent, "period" | "faceOutcome">): boolean {
  return e.period === "after-hours" && e.faceOutcome === "none";
}

export class PresenceAlertBatcher {
  private readonly latest = new Map<string, PresenceAlertEvent>();
  private readonly pending = new Map<string, number>();
  private readonly queued = new Map<string, PresenceAlertEvent[]>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly decided = new Set<string>();
  /** Events on a static spot: recorded, never alerted. */
  private readonly onStatic = new Set<string>();
  private suppressedStatic = 0;

  constructor(private readonly opts: PresenceAlertOptions) {}

  /** A new or updated event. Updates after the decision change nothing. `holdMs`: per-gate hold (P3b settings). */
  offer(e: PresenceAlertEvent, nowMs: number, holdMs: number = this.opts.holdMs): void {
    if (this.decided.has(e.id)) return;
    this.latest.set(e.id, { ...e });
    if (!this.pending.has(e.id)) {
      this.pending.set(e.id, nowMs + holdMs);
      // First sight of this event: one hit on its spot.
      if (e.box && this.opts.staticSpots && this.opts.staticSpots.counts(e.score)) {
        const r = this.opts.staticSpots.hit(e.gateId, e.box, nowMs);
        if (r.isStatic) this.onStatic.add(e.id);
        if (r.becameStatic) this.opts.onStaticSpot?.(e.gateId, e.box);
      }
    }
  }

  /** The messages to send now (at most one per gate). */
  due(nowMs: number): PresenceAlertBatch[] {
    for (const [id, decideAt] of this.pending) {
      if (decideAt > nowMs) continue;
      this.pending.delete(id);
      const e = this.latest.get(id);
      this.latest.delete(id);
      this.remember(id);
      const isStatic = this.onStatic.delete(id);
      if (!e || !presenceAlertEligible(e)) continue;
      if (isStatic) {
        this.suppressedStatic += 1;
        continue;
      }
      const q = this.queued.get(e.gateId) || [];
      q.push(e);
      this.queued.set(e.gateId, q);
    }
    const out: PresenceAlertBatch[] = [];
    for (const [gateId, events] of this.queued) {
      if (!events.length) continue;
      const last = this.lastSentAt.get(gateId);
      const windowMs = this.opts.windowMsFor?.(gateId) ?? this.opts.windowMs;
      if (last !== undefined && nowMs - last < windowMs) continue;
      events.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      out.push({ gateId, events: [...events] });
      this.queued.set(gateId, []);
      this.lastSentAt.set(gateId, nowMs);
    }
    return out;
  }

  /**
   * A message that could not be sent: its events go back to the front of the
   * gate's queue for the next message (the window still applies). Events older
   * than `maxAgeMs` are dropped rather than reported late.
   */
  requeue(batch: PresenceAlertBatch, nowMs: number, maxAgeMs: number): number {
    const fresh = batch.events.filter((e) => nowMs - Date.parse(e.startedAt) <= maxAgeMs);
    this.queued.set(batch.gateId, [...fresh, ...(this.queued.get(batch.gateId) || [])]);
    return fresh.length;
  }

  /** Events waiting for a decision or for the next message (for status and tests). */
  backlog(): { pending: number; queued: number; suppressedStatic: number } {
    let queued = 0;
    for (const q of this.queued.values()) queued += q.length;
    return { pending: this.pending.size, queued, suppressedStatic: this.suppressedStatic };
  }

  private remember(id: string): void {
    this.decided.add(id);
    if (this.decided.size > 5000) this.decided.delete(this.decided.values().next().value!);
  }
}

const TIME_ZONE = "Asia/Ho_Chi_Minh";
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("vi-VN", { timeZone: TIME_ZONE, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** dd/MM in site time, built from parts (ICU builds differ on the separator). */
const day = (iso: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}/${get("month")}`;
};
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/** Eton/Mattermost body for one batch: text + attachment, no image. */
export function presenceAlertPayload(
  batch: PresenceAlertBatch,
  gateLabel: string,
  link: string,
): { text: string; attachments: Array<{ title: string; title_link?: string; text: string }> } {
  const events = batch.events;
  const first = events[0];
  const lastEvent = events[events.length - 1];
  const text = events.length === 1
    ? `🚶 Có người ngoài giờ tại ${gateLabel} - ${clock(first.startedAt)} ${day(first.startedAt)}`
    : `🚶 ${events.length} lượt có người ngoài giờ tại ${gateLabel}, ${clock(first.startedAt)}-${clock(lastEvent.startedAt)} ${day(first.startedAt)}`;
  const lines: string[] = [];
  if (events.length === 1) {
    lines.push(`Không thấy khuôn mặt · trong khung hình ${seconds(first.inViewMs)} · ${first.peakPersons} người`);
    lines.push(`Mã sự kiện: ${first.id}`);
  } else {
    const shown = events.slice(0, 10);
    for (const e of shown) lines.push(`${clock(e.startedAt)} · ${seconds(e.inViewMs)} · ${e.peakPersons} người · không thấy mặt`);
    if (events.length > shown.length) lines.push(`+${events.length - shown.length} lượt khác`);
  }
  lines.push("Chỉ ghi nhận và báo - không thay đổi trạng thái cửa.");
  const attachment: { title: string; title_link?: string; text: string } = {
    title: "Cảnh báo hiện diện (không thấy khuôn mặt)",
    text: lines.join("\n"),
  };
  if (link) attachment.title_link = link;
  return { text: link ? `${text}\n[Mở bảng Hiện diện](${link})` : text, attachments: [attachment] };
}

/**
 * How long the detector has gone without a picture: since the last picture
 * seen, or since start when none has been seen yet. A stream reconnect swaps
 * the reader and briefly has no picture at all - that is not "2 minutes
 * without pictures" (2026-10-06: 28 false offline/online pairs in one day).
 */
export function presenceDetectorAgeMs(lastFrameAtMs: number | null | undefined, sinceMs: number, nowMs: number): number {
  return Math.max(0, nowMs - (lastFrameAtMs ?? sinceMs));
}

/**
 * Detection health for a live gate: one "offline" notice when no picture has
 * reached the detector for `offlineAfterMs`, one "online" notice when pictures
 * come back. Healthy at start (state unknown) is not an event; the caller
 * starts checking only after `offlineAfterMs` of uptime, so a gate that never
 * gets a picture after a restart is reported too.
 */
export type PresenceHealthState = "unknown" | "online" | "offline";
export function presenceHealthTransition(
  state: PresenceHealthState,
  frameAgeMs: number | null,
  offlineAfterMs: number,
): { state: PresenceHealthState; notice: "offline" | "online" | null } {
  const healthy = frameAgeMs !== null && frameAgeMs < offlineAfterMs;
  if (healthy) return { state: "online", notice: state === "offline" ? "online" : null };
  if (state !== "offline") return { state: "offline", notice: "offline" };
  return { state, notice: null };
}

export function presenceHealthPayload(notice: "offline" | "online", gateLabel: string, atIso: string, link: string) {
  const text = notice === "offline"
    ? `⚠️ Phát hiện người tại ${gateLabel} đang NGỪNG hoạt động (${clock(atIso)} ${day(atIso)}) - sẽ không có cảnh báo hiện diện cho tới khi hoạt động lại.`
    : `✅ Phát hiện người tại ${gateLabel} đã hoạt động lại (${clock(atIso)} ${day(atIso)}).`;
  return {
    text: link ? `${text}\n[Mở bảng Hiện diện](${link})` : text,
    attachments: [{ title: "Tình trạng phát hiện người", text: notice === "offline" ? "Kiểm tra luồng camera và bộ phát hiện trên bảng Hiện diện." : "Cảnh báo hiện diện ngoài giờ hoạt động bình thường." }],
  };
}
