/**
 * The client address of a request (owner 2026-10-02: sign-in rate limit and
 * audit, site public behind eton8/T2 since 2026-10-02).
 *
 * The edge proxies overwrite X-Real-IP with the real visitor (nginx realip from
 * Cloudflare's ranges only), and the container sees their own addresses as the
 * TCP peer (iptables DNAT; checked 2026-10-02: 192.168.6.19 eton8, 10.0.19.37
 * T2). So X-Real-IP is believed only when the peer is one of TRUSTED_PROXY_IPS;
 * any other peer (a LAN host on :8080) is keyed by its own address and cannot
 * forge one. CF-Connecting-IP is never read: the proxies pass it through
 * unchanged, so a client reaching them directly could forge it.
 */
import { isIP } from "node:net";

/** "::ffff:1.2.3.4" -> "1.2.3.4"; trims; "" for nothing. */
export function normalizeIp(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return s.toLowerCase().startsWith("::ffff:") && isIP(s.slice(7)) === 4 ? s.slice(7) : s;
}

export function parseTrustedProxies(raw: unknown): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((v) => normalizeIp(v))
      .filter((v) => isIP(v) !== 0),
  );
}

/**
 * `peer` is the TCP peer (req.socket.remoteAddress). The forwarded header is
 * used only from a trusted proxy, only its first value, and only when it is an
 * IP address; otherwise the peer itself.
 */
export function clientIpOf(
  peer: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trusted: ReadonlySet<string>,
  header = "x-real-ip",
): string {
  const p = normalizeIp(peer);
  if (!p || !trusted.has(p)) return p || "unknown";
  const raw = headers[header.toLowerCase()];
  const first = normalizeIp(String(Array.isArray(raw) ? raw[0] : raw ?? "").split(",")[0]);
  return isIP(first) !== 0 ? first : p;
}
