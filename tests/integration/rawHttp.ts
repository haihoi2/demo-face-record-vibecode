/**
 * A request whose path reaches the gateway byte-for-byte. `fetch` (WHATWG URL)
 * resolves dot segments - including percent-encoded ones such as %2e%2e -
 * before sending, so `/api/logs/../image` would arrive as `/api/image` and a
 * traversal test would be testing the client. node:http sends the path as given.
 */
import http from "node:http";

import { BASE_URL } from "./helpers";

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: any;
}

export function rawRequest(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  const base = new URL(BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: base.hostname, port: Number(base.port || 80), method, path, headers: body === undefined ? headers : { ...headers, "Content-Length": String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = undefined;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
