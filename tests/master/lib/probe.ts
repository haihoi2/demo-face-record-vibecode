/**
 * Helpers for the master security / contract suites (black-box, HTTP only).
 *
 * Canary secrets are fake and unique per run: tests plant them in
 * configuration and then assert they never come back out of an API response,
 * an SSE event or the gateway log.
 */
import { createServer, type AddressInfo, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { authenticateAs, BASE_URL, rawApi } from "../../integration/helpers.ts";

export { BASE_URL };

export const CANARY_PASSWORD = `MtCanary-${process.pid}-${Date.now().toString(36)}`;
export const CANARY_USER = "mtcanary";
/** TEST-NET-1 (RFC 5737): guaranteed not to be a real host. */
export const CANARY_RTSP = `rtsp://${CANARY_USER}:${CANARY_PASSWORD}@192.0.2.10:554/Streaming/Channels/101`;

export function assertNoCanary(label: string, text: string) {
  if (text.includes(CANARY_PASSWORD)) {
    throw new Error(`${label} leaked the planted camera password`);
  }
  if (/rtsp:\/\/[^\s"'/@]+:[^\s"'/@]+@/i.test(text)) {
    throw new Error(`${label} contains a credential-bearing rtsp:// URL`);
  }
}

let viewerCookie: Promise<string> | null = null;
export function viewer(): Promise<string> {
  if (!viewerCookie) viewerCookie = authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
  return viewerCookie;
}

/** GET as a raw cookie (no CSRF needed for reads). */
export function getAs(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return rawApi(path, { ...init, headers });
}

/** First non-internal IPv4 of this container: where the gateway can reach us on the test network. */
export function ownIpv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

export interface Listener {
  host: string;
  port: number;
  connections: Array<{ at: number; firstBytes: string }>;
  close(): Promise<void>;
}

/**
 * A TCP listener standing in for "some internal service". If the gateway can
 * be made to connect here, it can be made to connect anywhere on the network.
 */
export async function tcpListener(): Promise<Listener | null> {
  const host = ownIpv4();
  if (!host) return null;
  const connections: Listener["connections"] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    const entry = { at: Date.now(), firstBytes: "" };
    connections.push(entry);
    sock.on("data", (d) => {
      if (entry.firstBytes.length < 200) entry.firstBytes += d.toString("latin1").slice(0, 200 - entry.firstBytes.length);
    });
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    // Say nothing: a client waiting for an RTSP reply times out on its own.
    setTimeout(() => sock.destroy(), 3000).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    host,
    port,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function waitFor(cond: () => boolean, ms: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/** Opens the SSE stream as `cookie` and collects events until `stop()` is called. */
export async function sseCapture(cookie: string): Promise<{ events: Array<{ event: string; data: string }>; stop(): void; raw(): string }> {
  const ctrl = new AbortController();
  const events: Array<{ event: string; data: string }> = [];
  let all = "";
  const res = await fetch(BASE_URL + "/api/events", { headers: { Cookie: cookie }, signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        all += text;
        buf += text;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (event && data !== undefined) events.push({ event, data });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, stop: () => ctrl.abort(), raw: () => all };
}

/** Width/height of a JPEG from its SOF marker, or null. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Is a route present? 404 (Express default or JSON) after authentication means absent. */
export async function routePresent(cookie: string, path: string): Promise<boolean> {
  const r = await getAs(cookie, path);
  return r.status !== 404;
}
