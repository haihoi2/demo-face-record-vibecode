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
 *    counts;
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
}

export interface PresenceAlertBatch {
  gateId: string;
  events: PresenceAlertEvent[];
}

export interface PresenceAlertOptions {
  windowMs: number;
  holdMs: number;
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

  constructor(private readonly opts: PresenceAlertOptions) {}

  /** A new or updated event. Updates after the decision change nothing. */
  offer(e: PresenceAlertEvent, nowMs: number): void {
    if (this.decided.has(e.id)) return;
    this.latest.set(e.id, { ...e });
    if (!this.pending.has(e.id)) this.pending.set(e.id, nowMs + this.opts.holdMs);
  }

  /** The messages to send now (at most one per gate). */
  due(nowMs: number): PresenceAlertBatch[] {
    for (const [id, decideAt] of this.pending) {
      if (decideAt > nowMs) continue;
      this.pending.delete(id);
      const e = this.latest.get(id);
      this.latest.delete(id);
      this.remember(id);
      if (!e || !presenceAlertEligible(e)) continue;
      const q = this.queued.get(e.gateId) || [];
      q.push(e);
      this.queued.set(e.gateId, q);
    }
    const out: PresenceAlertBatch[] = [];
    for (const [gateId, events] of this.queued) {
      if (!events.length) continue;
      const last = this.lastSentAt.get(gateId);
      if (last !== undefined && nowMs - last < this.opts.windowMs) continue;
      events.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      out.push({ gateId, events: [...events] });
      this.queued.set(gateId, []);
      this.lastSentAt.set(gateId, nowMs);
    }
    return out;
  }

  /** Events waiting for a decision or for the next message (for status and tests). */
  backlog(): { pending: number; queued: number } {
    let queued = 0;
    for (const q of this.queued.values()) queued += q.length;
    return { pending: this.pending.size, queued };
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
