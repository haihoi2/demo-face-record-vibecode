/**
 * Outbound destination guard (SSRF defence) for every address an operator or
 * admin can configure: camera RTSP/HTTP streams, the test-stream TCP probe,
 * webhook URLs and the door-controller URL.
 *
 * `checkDestination(rawUrl, policy)` parses the URL the way the dialler will
 * see it, refuses internal destinations (loopback, unspecified, link-local and
 * cloud metadata, multicast/broadcast, reserved ranges, the gateway's own
 * interfaces, IPv4-mapped/compatible/NAT64/6to4 spellings of those), resolves
 * host names and checks EVERY resolved address, then applies the per-policy
 * allowlist or its default.
 *
 * Allowlists come from the environment, comma-separated hosts, IPs or CIDRs:
 *   CAMERA_ALLOWED_HOSTS  (camera streams and the test-stream probe)
 *   WEBHOOK_ALLOWED_HOSTS
 *   DOOR_ALLOWED_HOSTS
 * and optional denylists CAMERA_DENIED_HOSTS / WEBHOOK_DENIED_HOSTS /
 * DOOR_DENIED_HOSTS / NET_DENIED_HOSTS (all policies). Blank means unset
 * (docker compose passes unset variables as empty strings).
 *
 * Unset allowlist defaults: camera / door / tcp-probe accept private
 * (RFC 1918, CGNAT 100.64/10, ULA) and public addresses; webhook accepts
 * public addresses only. The always-refused set applies in every case, even to
 * an address an allowlist names.
 *
 * DNS rebinding: a check followed by a separate dial resolves the name twice;
 * a hostile DNS server can answer differently the second time. The result
 * carries the checked `addresses` so a caller can pin them (dial the IP, or
 * pass `createGuardedLookup(policy)` as the `lookup` option of
 * http(s).request / net.connect, which re-checks at connect time). FFmpeg
 * resolves by itself, so camera allowlists should name IPs, not host names.
 *
 * No side effects at import: the environment is read by `policyFromEnv`, the
 * network interfaces and DNS only when a check runs.
 */
import { promises as dnsPromises } from "node:dns";
import { isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";

export type DestinationPolicyName = "camera" | "webhook" | "door" | "tcp-probe";

export type DestinationCode =
  | "DEST_BAD_URL"
  | "DEST_SCHEME"
  | "DEST_LOOPBACK"
  | "DEST_UNSPECIFIED"
  | "DEST_LINK_LOCAL"
  | "DEST_METADATA"
  | "DEST_MULTICAST"
  | "DEST_RESERVED"
  | "DEST_SELF"
  | "DEST_DENIED"
  | "DEST_PRIVATE_WEBHOOK"
  | "DEST_NOT_ALLOWED"
  | "DEST_UNRESOLVED";

export type AddressClass =
  | "loopback"
  | "unspecified"
  | "link-local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "private"
  | "documentation"
  | "public";

export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

export interface HostList {
  /** Exact host names, lower case, no trailing dot. */
  names: string[];
  /** `*.example.com` entries, stored as `.example.com`. */
  suffixes: string[];
  cidrs: Cidr[];
  /** Entries that could not be parsed (they match nothing; log them at startup). */
  invalid: string[];
}

export interface DestinationPolicy {
  name: DestinationPolicyName;
  schemes: readonly string[];
  /** null = no allowlist configured: the default for this policy applies. */
  allow: HostList | null;
  deny: HostList;
  /** Default when `allow` is null: accept private (RFC 1918 / CGNAT / ULA) addresses. */
  privateByDefault: boolean;
  /** Environment variable named in operator messages. */
  allowEnvVar: string;
}

export type DestinationResult =
  | { ok: true; url: URL; host: string; port: number; addresses: string[] }
  | { ok: false; code: DestinationCode; reason: string; host?: string };

export interface NetGuardDeps {
  /** Resolves a host name to IP address strings. Default: dns.promises.lookup(host, { all: true }). */
  resolve?: (host: string) => Promise<string[]>;
  /** The gateway's own interface addresses. Default: os.networkInterfaces(). */
  localAddresses?: () => string[];
  /** DNS timeout in ms (default 3000). */
  resolveTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Messages (Vietnamese, operator-facing). Never include a URL, path or userinfo:
// only the host, which carries no credentials.
// ---------------------------------------------------------------------------
function reasonFor(code: DestinationCode, host: string | undefined, policy: DestinationPolicy): string {
  const h = host ? ` (${host})` : "";
  switch (code) {
    case "DEST_BAD_URL":
      return "Địa chỉ đích không hợp lệ. Hãy nhập dạng giao thức://máy-chủ[:cổng]/đường-dẫn, không dùng ký tự đặc biệt trong tên máy chủ.";
    case "DEST_SCHEME":
      return `Giao thức không được phép cho loại đích này (chỉ chấp nhận: ${policy.schemes.join(", ")}).`;
    case "DEST_LOOPBACK":
      return `Không được trỏ tới chính máy chủ (localhost / loopback)${h}.`;
    case "DEST_UNSPECIFIED":
      return `Địa chỉ 0.0.0.0 / :: không phải là đích hợp lệ${h}.`;
    case "DEST_LINK_LOCAL":
      return `Không được trỏ tới địa chỉ link-local (169.254.x.x, fe80::)${h}.`;
    case "DEST_METADATA":
      return `Không được trỏ tới dịch vụ metadata của nền tảng đám mây${h}.`;
    case "DEST_MULTICAST":
      return `Không được dùng địa chỉ multicast / broadcast${h}.`;
    case "DEST_RESERVED":
      return `Địa chỉ thuộc dải dành riêng, không phải đích hợp lệ${h}.`;
    case "DEST_SELF":
      return `Không được trỏ tới địa chỉ của chính gateway hoặc máy chủ Docker${h}.`;
    case "DEST_DENIED":
      return `Đích này nằm trong danh sách chặn của máy chủ${h}.`;
    case "DEST_PRIVATE_WEBHOOK":
      return `Webhook chỉ được gửi tới địa chỉ Internet công khai${h}. Địa chỉ mạng nội bộ phải được quản trị viên khai báo trong ${policy.allowEnvVar}.`;
    case "DEST_NOT_ALLOWED":
      return `Đích${h} không nằm trong danh sách cho phép của máy chủ (${policy.allowEnvVar}). Liên hệ quản trị viên để bổ sung.`;
    case "DEST_UNRESOLVED":
      return `Không phân giải được tên máy chủ${h}.`;
  }
}

function fail(code: DestinationCode, policy: DestinationPolicy, host?: string): DestinationResult {
  return host ? { ok: false, code, reason: reasonFor(code, host, policy), host } : { ok: false, code, reason: reasonFor(code, undefined, policy) };
}

// ---------------------------------------------------------------------------
// IP parsing
// ---------------------------------------------------------------------------
interface Ip {
  family: 4 | 6;
  value: bigint;
}

/**
 * inet_aton() semantics, which getaddrinfo (FFmpeg) and the WHATWG URL parser
 * (http/https) both apply: 1-4 parts, each decimal, octal (leading 0) or hex
 * (0x), the last part filling the remaining bytes. `127.1`, `0177.0.0.1`,
 * `0x7f000001` and `2130706433` are all 127.0.0.1.
 */
function parseIPv4Loose(input: string): number | null {
  if (!input) return null;
  const parts = input.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - nums.length)) return null;
  let value = 0;
  nums.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return value + last;
}

/** Plain dotted quad, decimal only (configuration entries and resolver output). */
function parseIPv4Strict(input: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

function parseIPv6(input: string): bigint | null {
  if (!input || input.includes("%") || !isIPv6(input)) return null;
  let str = input.toLowerCase();
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail) {
    const v4 = parseIPv4Strict(tail[2]);
    if (v4 === null) return null;
    str = `${tail[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function formatIPv4(v: number | bigint): string {
  const n = Number(v);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** RFC 5952 text form; IPv4-mapped addresses keep the dotted tail. */
function formatIPv6(v: bigint): string {
  if (v >> 32n === 0xffffn) return `::ffff:${formatIPv4(v & 0xffffffffn)}`;
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((v >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

function formatIp(ip: Ip): string {
  return ip.family === 4 ? formatIPv4(ip.value) : formatIPv6(ip.value);
}

/** Resolver output or a bracket-less literal: strict dotted IPv4 or IPv6. */
function parseIpAddress(input: string): Ip | null {
  const s = input.trim().replace(/^\[(.*)\]$/, "$1");
  const v4 = parseIPv4Strict(s);
  if (v4 !== null) return { family: 4, value: BigInt(v4) };
  const v6 = parseIPv6(s);
  if (v6 !== null) return { family: 6, value: v6 };
  return null;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 host itself: match and compare it as IPv4. */
function effectiveIp(ip: Ip): Ip {
  if (ip.family === 6 && ip.value >> 32n === 0xffffn) return { family: 4, value: ip.value & 0xffffffffn };
  return ip;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function cidr4(a: string, bits: number): Cidr {
  return { family: 4, base: BigInt(parseIPv4Strict(a)!), bits };
}
function cidr6(a: string, bits: number): Cidr {
  return { family: 6, base: parseIPv6(a)!, bits };
}

function inCidr(ip: Ip, c: Cidr): boolean {
  if (ip.family !== c.family) return false;
  const width = c.family === 4 ? 32n : 128n;
  const shift = width - BigInt(c.bits);
  return ip.value >> shift === c.base >> shift;
}

const METADATA_IPS: readonly Ip[] = [
  "169.254.169.254", // AWS / GCP / Azure / OpenStack / Oracle IMDS
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud (inside CGNAT, so listed explicitly)
  "fd00:ec2::254", // AWS IMDS over IPv6
].map((a) => parseIpAddress(a)!);

const V4_CLASSES: ReadonlyArray<[Cidr, AddressClass]> = [
  [cidr4("0.0.0.0", 8), "unspecified"],
  [cidr4("127.0.0.0", 8), "loopback"],
  [cidr4("169.254.0.0", 16), "link-local"],
  [cidr4("224.0.0.0", 4), "multicast"],
  [cidr4("255.255.255.255", 32), "multicast"], // limited broadcast
  [cidr4("240.0.0.0", 4), "reserved"],
  [cidr4("192.0.0.0", 24), "reserved"], // IETF protocol assignments
  [cidr4("192.88.99.0", 24), "reserved"], // deprecated 6to4 relay anycast
  [cidr4("10.0.0.0", 8), "private"],
  [cidr4("172.16.0.0", 12), "private"],
  [cidr4("192.168.0.0", 16), "private"],
  [cidr4("100.64.0.0", 10), "private"], // CGNAT
  [cidr4("198.18.0.0", 15), "private"], // benchmarking
  [cidr4("192.0.2.0", 24), "documentation"],
  [cidr4("198.51.100.0", 24), "documentation"],
  [cidr4("203.0.113.0", 24), "documentation"],
];

function classifyIPv4(v: bigint): AddressClass {
  const ip: Ip = { family: 4, value: v };
  if (METADATA_IPS.some((m) => m.family === 4 && m.value === v)) return "metadata";
  for (const [c, cls] of V4_CLASSES) if (inCidr(ip, c)) return cls;
  return "public";
}

const V6_UNSPEC = 0n;
const V6_LOOP = 1n;

function classifyIPv6(v: bigint): AddressClass {
  const ip: Ip = { family: 6, value: v };
  if (v === V6_UNSPEC) return "unspecified";
  if (v === V6_LOOP) return "loopback";
  if (METADATA_IPS.some((m) => m.family === 6 && m.value === v)) return "metadata";
  // IPv4 embedded in IPv6: judge the IPv4 address it reaches.
  if (v >> 32n === 0xffffn) return classifyIPv4(v & 0xffffffffn); // ::ffff:a.b.c.d mapped
  if (v >> 32n === 0xffff0000n) return classifyIPv4(v & 0xffffffffn); // ::ffff:0:a.b.c.d (SIIT)
  if (v >> 32n === 0n) return classifyIPv4(v & 0xffffffffn); // ::a.b.c.d compatible (deprecated)
  if (inCidr(ip, cidr6("64:ff9b::", 96)) || inCidr(ip, cidr6("64:ff9b:1::", 48))) return classifyIPv4(v & 0xffffffffn); // NAT64
  if (inCidr(ip, cidr6("2002::", 16))) return classifyIPv4((v >> 80n) & 0xffffffffn); // 6to4
  if (inCidr(ip, cidr6("fe80::", 10))) return "link-local";
  if (inCidr(ip, cidr6("ff00::", 8))) return "multicast";
  if (inCidr(ip, cidr6("fc00::", 7))) return "private"; // ULA
  if (inCidr(ip, cidr6("fec0::", 10))) return "private"; // deprecated site-local
  if (inCidr(ip, cidr6("2001:db8::", 32))) return "documentation";
  if (inCidr(ip, cidr6("2001::", 32))) return "reserved"; // Teredo (embeds an obfuscated client address)
  if (inCidr(ip, cidr6("100::", 64))) return "reserved"; // discard-only
  if (!inCidr(ip, cidr6("2000::", 3))) return "reserved"; // outside global unicast
  return "public";
}

function classify(ip: Ip): AddressClass {
  return ip.family === 4 ? classifyIPv4(ip.value) : classifyIPv6(ip.value);
}

/** Class of an IP address string (dotted IPv4 or IPv6), or null when it is not an address. */
export function classifyAddress(address: string): AddressClass | null {
  const ip = parseIpAddress(address);
  return ip ? classify(ip) : null;
}

const ALWAYS_REFUSED: Partial<Record<AddressClass, DestinationCode>> = {
  loopback: "DEST_LOOPBACK",
  unspecified: "DEST_UNSPECIFIED",
  "link-local": "DEST_LINK_LOCAL",
  metadata: "DEST_METADATA",
  multicast: "DEST_MULTICAST",
  reserved: "DEST_RESERVED",
};

// ---------------------------------------------------------------------------
// Host names
// ---------------------------------------------------------------------------
const HOSTNAME_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/;
const REFUSED_NAMES: ReadonlyArray<[string, DestinationCode]> = [
  ["localhost", "DEST_LOOPBACK"],
  ["localhost.localdomain", "DEST_LOOPBACK"],
  ["ip6-localhost", "DEST_LOOPBACK"],
  ["ip6-loopback", "DEST_LOOPBACK"],
  ["metadata.google.internal", "DEST_METADATA"],
  ["metadata.goog", "DEST_METADATA"],
  ["metadata", "DEST_METADATA"],
  ["instance-data", "DEST_METADATA"],
  ["instance-data.ec2.internal", "DEST_METADATA"],
  ["host.docker.internal", "DEST_SELF"],
  ["gateway.docker.internal", "DEST_SELF"],
];

function refusedName(name: string): DestinationCode | null {
  if (name === "localhost" || name.endsWith(".localhost")) return "DEST_LOOPBACK";
  for (const [n, code] of REFUSED_NAMES) if (name === n) return code;
  return null;
}

function nameMatches(list: HostList, name: string): boolean {
  return list.names.includes(name) || list.suffixes.some((s) => name.endsWith(s) && name.length > s.length);
}

function ipMatches(list: HostList, ip: Ip): boolean {
  const eff = effectiveIp(ip);
  return list.cidrs.some((c) => inCidr(eff, c));
}

type HostLiteral = { kind: "ip"; ip: Ip } | { kind: "name"; name: string } | { kind: "bad" };

/**
 * Interprets a host exactly as a dialler would: bracketed IPv6, any inet_aton
 * IPv4 spelling, or a DNS name. A name whose last label is numeric but not a
 * valid IPv4 spelling is refused (resolvers disagree on those).
 */
function parseHost(raw: string): HostLiteral {
  let h = raw.toLowerCase();
  if (h.startsWith("[")) {
    if (!h.endsWith("]")) return { kind: "bad" };
    const v6 = parseIPv6(h.slice(1, -1));
    return v6 === null ? { kind: "bad" } : { kind: "ip", ip: { family: 6, value: v6 } };
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 253) return { kind: "bad" };
  const labels = h.split(".");
  const last = labels[labels.length - 1];
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/i.test(last)) {
    const v4 = parseIPv4Loose(h);
    return v4 === null ? { kind: "bad" } : { kind: "ip", ip: { family: 4, value: BigInt(v4) } };
  }
  return HOSTNAME_RE.test(h) ? { kind: "name", name: h } : { kind: "bad" };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Parses a comma-separated list of hosts, `*.suffix` names, IPs and CIDRs
 * (IPv4 dotted quads only, so `10/8` is invalid rather than 0.0.0.10).
 * Returns null for an unset or blank value.
 */
export function parseHostList(value: string | undefined | null): HostList | null {
  if (value === undefined || value === null || !String(value).trim()) return null;
  const list: HostList = { names: [], suffixes: [], cidrs: [], invalid: [] };
  for (const rawEntry of String(value).split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash >= 0) {
      const addr = entry.slice(0, slash).replace(/^\[(.*)\]$/, "$1");
      const bitsText = entry.slice(slash + 1);
      const ip = parseIpAddress(addr);
      const bits = /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : NaN;
      if (!ip || !(bits >= 0 && bits <= (ip.family === 4 ? 32 : 128))) {
        list.invalid.push(rawEntry.trim());
        continue;
      }
      const eff = bits >= 96 || ip.family === 4 ? effectiveIp(ip) : ip;
      const effBits = eff.family === 4 && ip.family === 6 ? bits - 96 : bits;
      list.cidrs.push({ family: eff.family, base: eff.value, bits: effBits });
      continue;
    }
    const ip = parseIpAddress(entry);
    if (ip) {
      const eff = effectiveIp(ip);
      list.cidrs.push({ family: eff.family, base: eff.value, bits: eff.family === 4 ? 32 : 128 });
      continue;
    }
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2).replace(/\.$/, "");
      const parsed = parseHost(suffix);
      if (parsed.kind === "name") list.suffixes.push(`.${parsed.name}`);
      else list.invalid.push(rawEntry.trim());
      continue;
    }
    const parsed = parseHost(entry);
    if (parsed.kind === "name") list.names.push(parsed.name);
    else list.invalid.push(rawEntry.trim()); // host:port, loose IPv4 spellings, garbage
  }
  const entries = list.names.length + list.suffixes.length + list.cidrs.length + list.invalid.length;
  return entries === 0 ? null : list; // only separators: unset
}

function mergeLists(...lists: Array<HostList | null>): HostList {
  const out: HostList = { names: [], suffixes: [], cidrs: [], invalid: [] };
  for (const l of lists) {
    if (!l) continue;
    out.names.push(...l.names);
    out.suffixes.push(...l.suffixes);
    out.cidrs.push(...l.cidrs);
    out.invalid.push(...l.invalid);
  }
  return out;
}

const ENV_PREFIX: Record<DestinationPolicyName, string> = {
  camera: "CAMERA",
  "tcp-probe": "CAMERA",
  webhook: "WEBHOOK",
  door: "DOOR",
};

function envFlag(v: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(v || "").trim());
}

/**
 * Builds a policy from the environment:
 *   <P>_ALLOWED_HOSTS, <P>_DENIED_HOSTS, NET_DENIED_HOSTS, WEBHOOK_ALLOW_HTTP
 * with <P> = CAMERA (camera, tcp-probe), WEBHOOK, DOOR.
 */
export function policyFromEnv(
  name: DestinationPolicyName,
  env: Record<string, string | undefined> = process.env,
): DestinationPolicy {
  const prefix = ENV_PREFIX[name];
  const allowEnvVar = `${prefix}_ALLOWED_HOSTS`;
  let schemes: string[];
  if (name === "webhook") schemes = envFlag(env.WEBHOOK_ALLOW_HTTP) ? ["https", "http"] : ["https"];
  else if (name === "door") schemes = ["http", "https"];
  else schemes = ["rtsp", "rtsps", "http", "https"];
  return {
    name,
    schemes,
    allow: parseHostList(env[allowEnvVar]),
    deny: mergeLists(parseHostList(env[`${prefix}_DENIED_HOSTS`]), parseHostList(env.NET_DENIED_HOSTS)),
    privateByDefault: name !== "webhook",
    allowEnvVar,
  };
}

/** Entries of the policy's lists that could not be parsed - log them once at startup. */
export function invalidPolicyEntries(policy: DestinationPolicy): string[] {
  return [...(policy.allow?.invalid || []), ...policy.deny.invalid];
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------
const DEFAULT_PORTS: Record<string, number> = { rtsp: 554, rtsps: 322, http: 80, https: 443 };

/** Copy of a URL without user name and password, for logs and responses. */
export function withoutUserinfo(url: URL): URL {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  return copy;
}

type ParsedTarget =
  | { ok: true; url: URL; scheme: string; hostRaw: string; port: number }
  | { ok: false; code: "DEST_BAD_URL" | "DEST_SCHEME" };

function parseTarget(rawUrl: unknown, policy: DestinationPolicy): ParsedTarget {
  if (typeof rawUrl !== "string") return { ok: false, code: "DEST_BAD_URL" };
  let raw = rawUrl.trim();
  if (!raw || raw.length > 2048) return { ok: false, code: "DEST_BAD_URL" };
  // Parser differentials between WHATWG URL, FFmpeg and libc: no backslashes,
  // whitespace, control or non-ASCII characters anywhere.
  if (/[\\\s\u0000-\u001f\u007f]|[^\u0000-\u007f]/.test(raw)) return { ok: false, code: "DEST_BAD_URL" };
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!schemeMatch) {
    // The TCP probe also takes a bare host[:port]; everything else needs scheme://.
    if (policy.name !== "tcp-probe" || raw.includes("://")) return { ok: false, code: "DEST_BAD_URL" };
    raw = `tcp://${raw}`;
  }
  const scheme = (schemeMatch ? schemeMatch[1] : "tcp").toLowerCase();
  const schemeAllowed = scheme === "tcp" ? policy.name === "tcp-probe" : policy.schemes.includes(scheme);
  if (!schemeAllowed) return { ok: false, code: "DEST_SCHEME" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "DEST_BAD_URL" };
  }
  // Authority as a naive splitter (FFmpeg's av_url_split) sees it: up to the
  // first / ? #, host after the LAST @. It must name the same host as WHATWG.
  const afterScheme = raw.slice(raw.indexOf("://") + 3);
  const authority = afterScheme.slice(0, afterScheme.search(/[/?#]|$/));
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  let hostRaw: string;
  let portText = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return { ok: false, code: "DEST_BAD_URL" };
    hostRaw = hostPort.slice(0, close + 1);
    const rest = hostPort.slice(close + 1);
    if (rest && !/^:\d*$/.test(rest)) return { ok: false, code: "DEST_BAD_URL" };
    portText = rest.slice(1);
  } else {
    const colon = hostPort.lastIndexOf(":");
    hostRaw = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    portText = colon >= 0 ? hostPort.slice(colon + 1) : "";
    if (portText && !/^\d+$/.test(portText)) return { ok: false, code: "DEST_BAD_URL" };
  }
  if (!hostRaw || hostRaw.includes("%")) return { ok: false, code: "DEST_BAD_URL" };
  const a = parseHost(hostRaw);
  const b = parseHost(url.hostname);
  const same =
    (a.kind === "ip" && b.kind === "ip" && a.ip.family === b.ip.family && a.ip.value === b.ip.value) ||
    (a.kind === "name" && b.kind === "name" && a.name === b.name);
  if (!same) return { ok: false, code: "DEST_BAD_URL" };

  const port = portText ? Number(portText) : scheme === "tcp" ? NaN : DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: "DEST_BAD_URL" };
  return { ok: true, url, scheme, hostRaw, port };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
async function defaultResolve(host: string): Promise<string[]> {
  const rows = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

function defaultLocalAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) out.push(i.address);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type HostCheck = { ok: true; host: string; addresses: string[] } | { ok: false; code: DestinationCode; host: string };

/** Checks a parsed host (name or IP) against the refused set, the denylist and the policy. */
async function checkParsedHost(target: HostLiteral & { kind: "ip" | "name" }, policy: DestinationPolicy, deps: NetGuardDeps): Promise<HostCheck> {
  const display = target.kind === "ip" ? formatIp(target.ip) : target.name;
  let ips: Ip[];
  if (target.kind === "name") {
    const refused = refusedName(target.name);
    if (refused) return { ok: false, code: refused, host: display };
    if (nameMatches(policy.deny, target.name)) return { ok: false, code: "DEST_DENIED", host: display };
    let resolved: string[];
    try {
      resolved = await withTimeout((deps.resolve || defaultResolve)(target.name), deps.resolveTimeoutMs ?? 3000);
    } catch {
      return { ok: false, code: "DEST_UNRESOLVED", host: display };
    }
    ips = [];
    for (const a of Array.isArray(resolved) ? resolved : []) {
      const ip = typeof a === "string" ? parseIpAddress(a) : null;
      if (!ip) return { ok: false, code: "DEST_UNRESOLVED", host: display };
      ips.push(ip);
    }
    if (ips.length === 0) return { ok: false, code: "DEST_UNRESOLVED", host: display };
  } else {
    ips = [target.ip];
  }

  // Every address must pass: one loopback answer among public ones refuses the host.
  let self: Ip[] | null = null;
  for (const ip of ips) {
    const cls = classify(ip);
    const code = ALWAYS_REFUSED[cls];
    if (code) return { ok: false, code, host: display };
    self ??= (deps.localAddresses || defaultLocalAddresses)()
      .map((a) => parseIpAddress(String(a).replace(/%.*$/, "")))
      .filter((x): x is Ip => x !== null)
      .map(effectiveIp);
    const eff = effectiveIp(ip);
    if (self.some((s) => s.family === eff.family && s.value === eff.value)) return { ok: false, code: "DEST_SELF", host: display };
    if (ipMatches(policy.deny, ip)) return { ok: false, code: "DEST_DENIED", host: display };
  }

  if (policy.allow) {
    const byName = target.kind === "name" && nameMatches(policy.allow, target.name);
    if (!byName && !ips.every((ip) => ipMatches(policy.allow!, ip))) return { ok: false, code: "DEST_NOT_ALLOWED", host: display };
  } else if (!policy.privateByDefault && ips.some((ip) => classify(ip) === "private")) {
    return { ok: false, code: "DEST_PRIVATE_WEBHOOK", host: display };
  }
  return { ok: true, host: display, addresses: ips.map(formatIp) };
}

function resolvePolicy(policy: DestinationPolicy | DestinationPolicyName): DestinationPolicy {
  return typeof policy === "string" ? policyFromEnv(policy, process.env) : policy;
}

/**
 * Checks a user-supplied destination before it is stored or dialled.
 * `policy` is a policy object or a name (read from process.env on each call).
 * On success `url` has no userinfo; dial the ORIGINAL string (it carries the
 * camera login) or, better, pin one of `addresses`.
 */
export async function checkDestination(
  rawUrl: unknown,
  policyOrName: DestinationPolicy | DestinationPolicyName,
  deps: NetGuardDeps = {},
): Promise<DestinationResult> {
  const policy = resolvePolicy(policyOrName);
  const parsed = parseTarget(rawUrl, policy);
  if (parsed.ok === false) return fail(parsed.code, policy);
  const host = parseHost(parsed.hostRaw);
  if (host.kind === "bad") return fail("DEST_BAD_URL", policy);
  const checked = await checkParsedHost(host, policy, deps);
  if (checked.ok === false) return fail(checked.code, policy, checked.host);
  return { ok: true, url: withoutUserinfo(parsed.url), host: checked.host, port: parsed.port, addresses: checked.addresses };
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * A `lookup` function for http(s).request / net.connect that resolves AND
 * checks at connect time, closing the DNS-rebinding gap between
 * checkDestination and the dial. A refused host fails the connection with
 * `err.code` = the DEST_* code.
 */
export function createGuardedLookup(policyOrName: DestinationPolicy | DestinationPolicyName, deps: NetGuardDeps = {}) {
  return (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number };
    const policy = resolvePolicy(policyOrName);
    const host = parseHost(String(hostname || ""));
    const done = (res: HostCheck | { ok: false; code: DestinationCode; host: string }) => {
      if (res.ok === false) {
        const err = new Error(reasonFor(res.code, res.host, policy)) as NodeJS.ErrnoException;
        err.code = res.code;
        cb(err, opts.all ? [] : "", 0);
        return;
      }
      let rows = res.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      if (opts.family === 4 || opts.family === 6) rows = rows.filter((r) => r.family === opts.family);
      if (rows.length === 0) {
        const err = new Error(reasonFor("DEST_UNRESOLVED", res.host, policy)) as NodeJS.ErrnoException;
        err.code = "DEST_UNRESOLVED";
        cb(err, opts.all ? [] : "", 0);
        return;
      }
      if (opts.all) cb(null, rows);
      else cb(null, rows[0].address, rows[0].family);
    };
    if (host.kind === "bad") {
      done({ ok: false, code: "DEST_BAD_URL", host: "" });
      return;
    }
    checkParsedHost(host, policy, deps).then(done, () => done({ ok: false, code: "DEST_UNRESOLVED", host: "" }));
  };
}
