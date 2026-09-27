import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDestination,
  classifyAddress,
  createGuardedLookup,
  invalidPolicyEntries,
  parseHostList,
  policyFromEnv,
  type DestinationResult,
  type NetGuardDeps,
} from "../src/server/netGuard";

// Tests never touch DNS or the host's interfaces: every check gets a fake resolver.
function fakeDns(table: Record<string, string[]>, calls: string[] = []): NetGuardDeps {
  return {
    resolve: async (host) => {
      calls.push(host);
      if (!(host in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return table[host];
    },
    localAddresses: () => [],
  };
}

const DNS = fakeDns({
  "cam.example": ["203.0.113.5"],
  "nvr.site.local": ["10.9.9.9"],
  "lan-cam.example": ["192.168.10.5"],
  "split.example": ["192.168.10.5", "192.168.99.1"],
  "mixed.example": ["8.8.8.8", "127.0.0.1"],
  "mixed6.example": ["2606:4700:4700::1111", "::1"],
  "rebind.example": ["169.254.169.254"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "evil": ["93.184.216.34"],
  "chat.example.com": ["93.184.216.34"],
  "internal-chat.example.com": ["10.20.30.40"],
});

const camera = policyFromEnv("camera", {});
const webhook = policyFromEnv("webhook", {});
const door = policyFromEnv("door", {});

async function refused(url: string, policy = camera, deps: NetGuardDeps = DNS): Promise<string> {
  const r = await checkDestination(url, policy, deps);
  assert.equal(r.ok, false, `${url} should be refused`);
  return (r as Extract<DestinationResult, { ok: false }>).code;
}

async function allowed(url: string, policy = camera, deps: NetGuardDeps = DNS) {
  const r = await checkDestination(url, policy, deps);
  assert.ok(r.ok, `${url} should be allowed, got ${JSON.stringify(r)}`);
  return r as Extract<DestinationResult, { ok: true }>;
}

describe("netGuard: every spelling of loopback is refused", () => {
  const spellings = [
    "rtsp://127.0.0.1:3000/x",
    "rtsp://2130706433/x", // decimal
    "rtsp://0x7f000001/x", // hex
    "rtsp://0x7F.0.0.1/x", // hex part
    "rtsp://0177.0.0.1/x", // octal
    "rtsp://0177.1/x", // octal short
    "rtsp://127.1/x", // short
    "rtsp://127.0.1/x",
    "rtsp://127.0.0.1./x", // trailing dot
    "rtsp://127.255.255.254/x",
    "RTSP://127.0.0.1:554/x", // upper-case scheme
    "rtsp://admin:pw@127.0.0.1:554/x", // userinfo
    "rtsp://a@127.0.0.1/x",
    "http://2130706433/x",
    "http://0x7f000001/",
    "http://0177.1/",
    "HTTP://127.0.0.1./",
    "https://127.1:8443/",
    "rtsp://[::1]:3000/x",
    "rtsp://[0:0:0:0:0:0:0:1]/x",
    "rtsp://[::ffff:127.0.0.1]/x", // IPv4-mapped
    "rtsp://[::ffff:7f00:1]/x",
    "rtsp://[::127.0.0.1]/x", // IPv4-compatible
    "rtsp://[::ffff:0:127.0.0.1]/x", // SIIT
    "rtsp://[64:ff9b::7f00:1]/x", // NAT64
    "rtsp://[2002:7f00:1::]/x", // 6to4
    "rtsp://localhost:5432/x",
    "rtsp://LOCALHOST./x",
    "rtsp://db.localhost/x",
    "rtsp://ip6-localhost/x",
  ];
  for (const url of spellings) {
    it(url, async () => {
      assert.equal(await refused(url), "DEST_LOOPBACK");
    });
  }
});

describe("netGuard: always-refused classes, whatever the policy or allowlist", () => {
  const cases: Array<[string, string]> = [
    ["rtsp://0.0.0.0:22/x", "DEST_UNSPECIFIED"],
    ["rtsp://0/x", "DEST_UNSPECIFIED"],
    ["rtsp://0.1.2.3/x", "DEST_UNSPECIFIED"],
    ["rtsp://[::]/x", "DEST_UNSPECIFIED"],
    ["rtsp://169.254.1.1/x", "DEST_LINK_LOCAL"],
    ["rtsp://[fe80::1]/x", "DEST_LINK_LOCAL"],
    ["rtsp://[febf::1]/x", "DEST_LINK_LOCAL"],
    ["rtsp://169.254.169.254/latest", "DEST_METADATA"],
    ["http://169.254.169.254/latest/meta-data/", "DEST_METADATA"],
    ["http://2852039166/", "DEST_METADATA"], // 169.254.169.254 as decimal
    ["http://0xa9.0xfe.0xa9.0xfe/", "DEST_METADATA"],
    ["rtsp://[::ffff:169.254.169.254]/x", "DEST_METADATA"],
    ["rtsp://[::ffff:a9fe:a9fe]/x", "DEST_METADATA"],
    ["rtsp://[64:ff9b::a9fe:a9fe]/x", "DEST_METADATA"],
    ["rtsp://[fd00:ec2::254]/x", "DEST_METADATA"],
    ["rtsp://169.254.170.2/x", "DEST_METADATA"],
    ["rtsp://100.100.100.200/x", "DEST_METADATA"], // inside CGNAT, still refused
    ["rtsp://metadata.google.internal/x", "DEST_METADATA"],
    ["rtsp://224.0.0.1/x", "DEST_MULTICAST"],
    ["rtsp://239.255.255.250:1900/x", "DEST_MULTICAST"],
    ["rtsp://255.255.255.255/x", "DEST_MULTICAST"],
    ["rtsp://[ff02::1]/x", "DEST_MULTICAST"],
    ["rtsp://240.0.0.1/x", "DEST_RESERVED"],
    ["rtsp://192.0.0.8/x", "DEST_RESERVED"],
    ["rtsp://[2001::1]/x", "DEST_RESERVED"], // Teredo
    ["rtsp://[100::1]/x", "DEST_RESERVED"],
    ["rtsp://host.docker.internal:5432/x", "DEST_SELF"],
  ];
  for (const [url, code] of cases) {
    it(`${url} -> ${code}`, async () => {
      assert.equal(await refused(url), code);
    });
  }

  it("an allowlist naming an always-refused address does not open it", async () => {
    const p = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "127.0.0.1, 169.254.0.0/16, localhost, ::1" });
    assert.equal(await refused("rtsp://127.0.0.1/x", p), "DEST_LOOPBACK");
    assert.equal(await refused("rtsp://169.254.169.254/x", p), "DEST_METADATA");
    assert.equal(await refused("rtsp://localhost/x", p), "DEST_LOOPBACK");
    assert.equal(await refused("rtsp://[::1]/x", p), "DEST_LOOPBACK");
  });

  it("the master security suite's five stored-stream destinations are all refused", async () => {
    for (const url of ["rtsp://127.0.0.1:3000/x", "rtsp://localhost:5432/x", "rtsp://169.254.169.254/latest", "rtsp://[::1]:3000/x", "rtsp://0.0.0.0:22/x"]) {
      await refused(url);
    }
  });

  it("refuses the gateway's own interface addresses (its eth0 IP reaches its own ports)", async () => {
    const deps: NetGuardDeps = { ...DNS, localAddresses: () => ["127.0.0.1", "172.18.0.5", "fe80::42:acff:fe12:5%eth0", "fd00:1::5"] };
    assert.equal(await refused("rtsp://172.18.0.5:3000/x", camera, deps), "DEST_SELF");
    assert.equal(await refused("rtsp://[::ffff:172.18.0.5]:3000/x", camera, deps), "DEST_SELF");
    assert.equal(await refused("rtsp://[fd00:1::5]:3000/x", camera, deps), "DEST_SELF");
    await allowed("rtsp://172.18.0.6:554/x", camera, deps);
  });
});

describe("netGuard: URL parsing refuses ambiguous input", () => {
  const bad = [
    "",
    "   ",
    "not a url",
    "rtsp://",
    "rtsp:///x",
    "rtsp://:554/x",
    "192.168.60.1/stream", // no scheme
    "rtsp://127%2E0.0.1/x", // percent-encoded host
    "rtsp://evil\\@127.0.0.1/x", // backslash: WHATWG vs FFmpeg disagree
    "http://evil\\@127.0.0.1/x",
    "rtsp://cam .example/x",
    "rtsp://cam.example/x y",
    "rtsp://cam.example/\u0000",
    "http://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/", // circled "localhost"
    "rtsp://08.1/x", // invalid octal: resolvers disagree
    "rtsp://1.2.3.256/x",
    "rtsp://1.2.3.4.5/x",
    "rtsp://0x100000000/x",
    "rtsp://1.2.3.4:0/x",
    "rtsp://1.2.3.4:99999/x",
    "rtsp://1.2.3.4:55a/x",
    "rtsp://[fe80::1%25eth0]/x", // zone id
    "rtsp://[::1/x",
    "rtsp://cam_1..example/x",
    "rtsp://" + "a".repeat(2100),
  ];
  for (const url of bad) {
    it(JSON.stringify(url.slice(0, 60)), async () => {
      assert.equal(await refused(url), "DEST_BAD_URL");
    });
  }

  it("non-string input is a bad URL, not an exception", async () => {
    for (const v of [undefined, null, 42, {}, ["rtsp://1.2.3.4/"]]) {
      const r = await checkDestination(v, camera, DNS);
      assert.equal(r.ok, false);
      assert.equal((r as any).code, "DEST_BAD_URL");
    }
  });

  it("userinfo cannot smuggle a host: rtsp://127.0.0.1@evil dials evil, and evil is checked", async () => {
    const calls: string[] = [];
    const deps = fakeDns({ evil: ["93.184.216.34"] }, calls);
    const r = await allowed("rtsp://127.0.0.1@evil/x", camera, deps);
    assert.equal(r.host, "evil");
    assert.deepEqual(calls, ["evil"]);
    assert.equal(r.url.username, "");
    assert.equal(await refused("rtsp://127.0.0.1@evil/x", camera, fakeDns({ evil: ["127.0.0.1"] })), "DEST_LOOPBACK");
    // The LAST @ decides, as in FFmpeg and WHATWG.
    const r2 = await allowed("rtsp://user:p@ss@cam.example/x");
    assert.equal(r2.host, "cam.example");
  });

  it("returns the effective port: explicit, or the scheme default", async () => {
    assert.equal((await allowed("rtsp://192.168.60.1/Streaming/Channels/501")).port, 554);
    assert.equal((await allowed("rtsps://192.168.60.1/x")).port, 322);
    assert.equal((await allowed("http://192.168.60.1/x")).port, 80);
    assert.equal((await allowed("https://192.168.60.1/x")).port, 443);
    assert.equal((await allowed("RTSP://192.168.60.1:8554/x")).port, 8554);
  });

  it("normalises the host it reports (lower case, no trailing dot, canonical IP)", async () => {
    assert.equal((await allowed("rtsp://CAM.Example./x")).host, "cam.example");
    assert.equal((await allowed("rtsp://3232250881/x")).host, "192.168.60.1");
    assert.equal((await allowed("rtsp://[FD00:0:0:0:0:0:0:1]/x")).host, "fd00::1");
  });
});

describe("netGuard: schemes per policy", () => {
  it("camera: rtsp, rtsps, http, https only", async () => {
    for (const s of ["rtsp", "rtsps", "http", "https"]) await allowed(`${s}://192.168.60.1/x`);
    for (const u of ["ftp://192.168.60.1/x", "file:///etc/passwd", "gopher://192.168.60.1/x", "tcp://192.168.60.1:554", "javascript://192.168.60.1/%0aalert(1)"]) {
      const code = await refused(u);
      assert.ok(code === "DEST_SCHEME" || code === "DEST_BAD_URL", `${u} -> ${code}`);
    }
    assert.equal(await refused("ftp://192.168.60.1/x"), "DEST_SCHEME");
  });

  it("door: http and https only", async () => {
    await allowed("http://192.168.60.50/api/door", door);
    await allowed("https://192.168.60.50/api/door", door);
    assert.equal(await refused("rtsp://192.168.60.50/x", door), "DEST_SCHEME");
  });

  it("webhook: https only, http only when WEBHOOK_ALLOW_HTTP is set", async () => {
    await allowed("https://chat.example.com/hooks/abc", webhook);
    assert.equal(await refused("http://chat.example.com/hooks/abc", webhook), "DEST_SCHEME");
    const p = policyFromEnv("webhook", { WEBHOOK_ALLOW_HTTP: "true" });
    await allowed("http://chat.example.com/hooks/abc", p);
    assert.equal(policyFromEnv("webhook", { WEBHOOK_ALLOW_HTTP: "" }).schemes.includes("http"), false);
  });

  it("tcp-probe: a URL or a bare host:port, uses the camera allowlist", async () => {
    const p = policyFromEnv("tcp-probe", { CAMERA_ALLOWED_HOSTS: "192.168.60.1" });
    assert.equal((await allowed("192.168.60.1:554", p)).port, 554);
    assert.equal((await allowed("rtsp://admin:pw@192.168.60.1/x", p)).port, 554);
    assert.equal((await allowed("tcp://192.168.60.1:443", p)).port, 443);
    assert.equal(await refused("192.168.60.2:554", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("192.168.60.1", p), "DEST_BAD_URL"); // bare host needs a port
    assert.equal(await refused("localhost:5432", p), "DEST_LOOPBACK");
    assert.equal(await refused("127.1:22", policyFromEnv("tcp-probe", {})), "DEST_LOOPBACK");
    assert.equal(p.allowEnvVar, "CAMERA_ALLOWED_HOSTS");
  });
});

describe("netGuard: defaults without an allowlist", () => {
  it("camera and door accept RFC 1918, CGNAT, ULA and public addresses", async () => {
    for (const p of [camera, door, policyFromEnv("tcp-probe", {})]) {
      const scheme = p.name === "door" ? "http" : "rtsp";
      const suffix = p.name === "tcp-probe" ? ":554" : "/x";
      const pre = p.name === "tcp-probe" ? "" : `${scheme}://`;
      for (const h of ["192.168.60.1", "192.168.10.40", "10.1.2.3", "172.16.0.1", "172.31.255.254", "100.64.0.1", "8.8.8.8", "[fd12::1]"]) {
        await allowed(`${pre}${h}${suffix}`, p);
      }
    }
  });

  it("webhook refuses private destinations with DEST_PRIVATE_WEBHOOK", async () => {
    for (const h of ["10.1.2.3", "172.16.5.5", "192.168.1.1", "100.64.1.1", "198.18.0.1", "[fd00::1]", "[fc00::1]", "[::ffff:10.1.2.3]"]) {
      assert.equal(await refused(`https://${h}/hooks/x`, webhook), "DEST_PRIVATE_WEBHOOK", h);
    }
    assert.equal(await refused("https://internal-chat.example.com/hooks/x", webhook), "DEST_PRIVATE_WEBHOOK");
    await allowed("https://chat.example.com/hooks/x", webhook);
    await allowed("https://[2606:4700:4700::1111]/hooks/x", webhook);
  });

  it("webhook accepts a private destination the allowlist names", async () => {
    const p = policyFromEnv("webhook", { WEBHOOK_ALLOWED_HOSTS: "10.1.2.3, internal-chat.example.com" });
    await allowed("https://10.1.2.3/hooks/x", p);
    await allowed("https://internal-chat.example.com/hooks/x", p);
    assert.equal(await refused("https://10.1.2.4/hooks/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("https://chat.example.com/hooks/x", p), "DEST_NOT_ALLOWED", "a set list is exclusive, public included");
  });

  it("a blank variable is unset (docker compose passes unset variables as empty strings)", async () => {
    const p = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "  ", CAMERA_DENIED_HOSTS: "" });
    assert.equal(p.allow, null);
    await allowed("rtsp://10.1.2.3/x", p);
  });
});

describe("netGuard: allowlists", () => {
  const p = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "192.168.60.1, 192.168.10.0/24, nvr.site.local, *.cams.example, fd12:3456::/32" });

  it("IP and CIDR entries", async () => {
    await allowed("rtsp://192.168.60.1:554/Streaming/Channels/501", p);
    await allowed("rtsp://192.168.10.40/x", p);
    await allowed("rtsp://[::ffff:192.168.60.1]/x", p);
    await allowed("rtsp://[fd12:3456:1::9]/x", p);
    assert.equal(await refused("rtsp://192.168.60.2/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("rtsp://192.168.11.1/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("rtsp://8.8.8.8/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("rtsp://[fd12:3457::1]/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("rtsp://172.18.0.2:5432/x", p), "DEST_NOT_ALLOWED", "docker network outside the list");
  });

  it("host-name entries trust what the name resolves to, except always-refused addresses", async () => {
    await allowed("rtsp://nvr.site.local/x", p);
    const deps = fakeDns({ "a.cams.example": ["10.0.0.7"], "cams.example": ["10.0.0.8"], "b.cams.example": ["127.0.0.1"] });
    await allowed("rtsp://a.cams.example/x", p, deps);
    assert.equal(await refused("rtsp://cams.example/x", p, deps), "DEST_NOT_ALLOWED", "*.x does not match x itself");
    assert.equal(await refused("rtsp://b.cams.example/x", p, deps), "DEST_LOOPBACK");
  });

  it("an unlisted name must resolve ONLY into listed ranges", async () => {
    await allowed("rtsp://lan-cam.example/x", p);
    assert.equal(await refused("rtsp://split.example/x", p), "DEST_NOT_ALLOWED");
    assert.equal(await refused("rtsp://cam.example/x", p), "DEST_NOT_ALLOWED");
  });

  it("parseHostList: hosts, wildcards, IPs, CIDRs, IPv6; invalid entries are reported, not guessed", () => {
    assert.equal(parseHostList(undefined), null);
    assert.equal(parseHostList(""), null);
    assert.equal(parseHostList(" , "), null, "separators only = unset");
    const l = parseHostList(" 192.168.60.1 ,192.168.10.0/24, NVR.Site.Local., *.Eton.VN, [fd00::1], fd00::/8, 192.168.10.7/24, 10/8, cam:554, 1.2.3.4/33, 0177.1, *.,, ::ffff:10.0.0.0/104 ")!;
    assert.deepEqual(l.names, ["nvr.site.local"]);
    assert.deepEqual(l.suffixes, [".eton.vn"]);
    assert.deepEqual(l.invalid, ["10/8", "cam:554", "1.2.3.4/33", "0177.1", "*."]);
    assert.equal(l.cidrs.length, 6);
    assert.deepEqual(invalidPolicyEntries(policyFromEnv("door", { DOOR_ALLOWED_HOSTS: "10/8,10.0.0.1", NET_DENIED_HOSTS: "bad host" })), ["10/8", "bad host"]);
  });

  it("CIDR with host bits set matches the network; mapped IPv6 CIDR matches IPv4", async () => {
    const q = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "192.168.10.7/24, ::ffff:10.0.0.0/112" });
    await allowed("rtsp://192.168.10.200/x", q);
    await allowed("rtsp://10.0.200.1/x", q);
    assert.equal(await refused("rtsp://10.1.0.1/x", q), "DEST_NOT_ALLOWED");
  });

  it("a list whose entries are all invalid refuses everything (fail closed)", async () => {
    const q = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "10/8, cam:554" });
    assert.notEqual(q.allow, null);
    assert.equal(await refused("rtsp://10.1.2.3/x", q), "DEST_NOT_ALLOWED");
  });

  it("each policy reads its own variable", () => {
    const env = { CAMERA_ALLOWED_HOSTS: "10.0.0.1", WEBHOOK_ALLOWED_HOSTS: "10.0.0.2", DOOR_ALLOWED_HOSTS: "10.0.0.3" };
    assert.equal(policyFromEnv("camera", env).allow!.cidrs[0].base, 167772161n);
    assert.equal(policyFromEnv("tcp-probe", env).allow!.cidrs[0].base, 167772161n);
    assert.equal(policyFromEnv("webhook", env).allow!.cidrs[0].base, 167772162n);
    assert.equal(policyFromEnv("door", env).allow!.cidrs[0].base, 167772163n);
    assert.equal(policyFromEnv("door", env).allowEnvVar, "DOOR_ALLOWED_HOSTS");
  });
});

describe("netGuard: denylists", () => {
  it("CAMERA_DENIED_HOSTS and NET_DENIED_HOSTS refuse addresses and names, before DNS for names", async () => {
    const calls: string[] = [];
    const deps = fakeDns({ "db.example": ["10.5.5.5"], "ok.example": ["10.6.6.6"] }, calls);
    const p = policyFromEnv("camera", { CAMERA_DENIED_HOSTS: "10.5.0.0/16, db.example", NET_DENIED_HOSTS: "*.corp.example, 10.7.7.7" });
    assert.equal(await refused("rtsp://10.5.1.1/x", p, deps), "DEST_DENIED");
    assert.equal(await refused("rtsp://10.7.7.7/x", p, deps), "DEST_DENIED");
    assert.equal(await refused("rtsp://db.example/x", p, deps), "DEST_DENIED");
    assert.equal(await refused("rtsp://x.corp.example/x", p, deps), "DEST_DENIED");
    assert.deepEqual(calls, [], "denied names are refused without a lookup");
    await allowed("rtsp://ok.example/x", p, deps);
  });

  it("a denylist wins over the allowlist", async () => {
    const p = policyFromEnv("door", { DOOR_ALLOWED_HOSTS: "10.0.0.0/8", DOOR_DENIED_HOSTS: "10.0.0.5" });
    assert.equal(await refused("http://10.0.0.5/open", p), "DEST_DENIED");
    await allowed("http://10.0.0.6/open", p);
  });
});

describe("netGuard: DNS", () => {
  it("checks EVERY resolved address: one loopback answer among public ones refuses the host", async () => {
    assert.equal(await refused("rtsp://mixed.example/x"), "DEST_LOOPBACK");
    assert.equal(await refused("rtsp://mixed6.example/x"), "DEST_LOOPBACK");
    assert.equal(await refused("https://mixed.example/x", webhook), "DEST_LOOPBACK");
    assert.equal(await refused("rtsp://rebind.example/x"), "DEST_METADATA");
    assert.equal(await refused("rtsp://mapped.example/x"), "DEST_LOOPBACK");
  });

  it("returns every checked address so the caller can pin them", async () => {
    const deps = fakeDns({ "two.example": ["203.0.113.7", "2001:db8::7"] });
    const r = await allowed("rtsp://two.example/x", camera, deps);
    assert.deepEqual(r.addresses, ["203.0.113.7", "2001:db8::7"]);
    assert.deepEqual((await allowed("rtsp://192.168.60.1/x")).addresses, ["192.168.60.1"]);
  });

  it("resolver failure, empty answer, garbage answer and timeout are DEST_UNRESOLVED", async () => {
    assert.equal(await refused("rtsp://nowhere.example/x"), "DEST_UNRESOLVED");
    assert.equal(await refused("rtsp://empty.example/x", camera, { resolve: async () => [], localAddresses: () => [] }), "DEST_UNRESOLVED");
    assert.equal(await refused("rtsp://junk.example/x", camera, { resolve: async () => ["not-an-ip"], localAddresses: () => [] }), "DEST_UNRESOLVED");
    const slow: NetGuardDeps = { resolve: () => new Promise(() => {}), localAddresses: () => [], resolveTimeoutMs: 20 };
    assert.equal(await refused("rtsp://slow.example/x", camera, slow), "DEST_UNRESOLVED");
  });

  it("an IP literal never reaches the resolver", async () => {
    const calls: string[] = [];
    await allowed("rtsp://192.168.60.1/x", camera, fakeDns({}, calls));
    await refused("rtsp://2130706433/x", camera, fakeDns({}, calls));
    assert.deepEqual(calls, []);
  });

  it("createGuardedLookup re-checks at connect time (DNS rebinding) and pins checked addresses", async () => {
    const lookup = createGuardedLookup(camera, fakeDns({ "cam.example": ["203.0.113.5", "2001:db8::5"], "rebind.example": ["127.0.0.1"] }));
    const one = await new Promise<any[]>((res) => lookup("cam.example", {}, (err, address, family) => res([err, address, family])));
    assert.deepEqual(one, [null, "203.0.113.5", 4]);
    const all = await new Promise<any[]>((res) => lookup("cam.example", { all: true }, (err, address) => res([err, address])));
    assert.deepEqual(all, [null, [{ address: "203.0.113.5", family: 4 }, { address: "2001:db8::5", family: 6 }]]);
    const v6 = await new Promise<any[]>((res) => lookup("cam.example", { family: 6 }, (err, address, family) => res([err, address, family])));
    assert.deepEqual(v6, [null, "2001:db8::5", 6]);
    const bad = await new Promise<any>((res) => lookup("rebind.example", {}, (err) => res(err)));
    assert.equal(bad.code, "DEST_LOOPBACK");
    const garbage = await new Promise<any>((res) => lookup("a b", {}, (err) => res(err)));
    assert.equal(garbage.code, "DEST_BAD_URL");
  });
});

describe("netGuard: credentials never leave in a result", () => {
  const SECRET = "S3cr3t-Pa55";
  const urls = [
    `rtsp://admin:${SECRET}@127.0.0.1:554/Streaming/Channels/501`,
    `rtsp://admin:${SECRET}@169.254.169.254/x`,
    `rtsp://admin:${SECRET}@nowhere.example/x`,
    `rtsp://admin:${SECRET}@mixed.example/x`,
    `ftp://admin:${SECRET}@192.168.60.1/x`,
    `rtsp://admin:${SECRET}@1.2.3.4:0/x`,
    `rtsp://admin:${SECRET}@evil\\@127.0.0.1/x`,
    `rtsp://admin:${SECRET}@[::1]/x`,
    `https://admin:${SECRET}@10.1.2.3/hooks/${SECRET}`,
    `https://chat.example.com/hooks/${SECRET}?token=${SECRET}`,
  ];

  it("refusals carry a code, a Vietnamese reason and at most the host", async () => {
    for (const url of urls) {
      const policy = url.startsWith("https") ? policyFromEnv("webhook", { WEBHOOK_ALLOWED_HOSTS: "10.9.9.9" }) : camera;
      const r = await checkDestination(url, policy, DNS);
      assert.equal(r.ok, false, url);
      const text = JSON.stringify(r);
      assert.ok(!text.includes(SECRET), `secret leaked for ${url.replace(SECRET, "***")}: ${text}`);
      assert.ok(!text.includes("admin"), `user name leaked: ${text}`);
      assert.ok(!/rtsp:\/\/|https?:\/\//.test((r as any).reason), "reason never echoes a URL");
      assert.match((r as any).code, /^DEST_[A-Z_]+$/);
      assert.ok((r as any).reason.length > 10);
    }
  });

  it("an accepted URL comes back without userinfo", async () => {
    const r = await allowed(`rtsp://admin:${SECRET}@192.168.60.1:554/Streaming/Channels/501`);
    assert.equal(r.url.username, "");
    assert.equal(r.url.password, "");
    assert.ok(!r.url.href.includes(SECRET));
    assert.equal(r.url.href, "rtsp://192.168.60.1:554/Streaming/Channels/501");
  });

  it("reasons are Vietnamese and name the allowlist variable to fix", async () => {
    const p = policyFromEnv("camera", { CAMERA_ALLOWED_HOSTS: "192.168.60.1" });
    const r = await checkDestination("rtsp://192.168.60.9/x", p, DNS);
    assert.equal(r.ok, false);
    assert.match((r as any).reason, /danh sách cho phép/);
    assert.match((r as any).reason, /CAMERA_ALLOWED_HOSTS/);
    assert.equal((r as any).host, "192.168.60.9");
    const w = await checkDestination("https://10.1.2.3/hooks/x", webhook, DNS);
    assert.match((w as any).reason, /WEBHOOK_ALLOWED_HOSTS/);
  });
});

describe("netGuard: classifyAddress", () => {
  it("classifies IPv4, IPv6 and embedded IPv4 forms", () => {
    const table: Array<[string, string | null]> = [
      ["127.0.0.1", "loopback"],
      ["0.0.0.0", "unspecified"],
      ["169.254.10.10", "link-local"],
      ["169.254.169.254", "metadata"],
      ["10.0.0.1", "private"],
      ["172.15.255.255", "public"],
      ["172.16.0.0", "private"],
      ["172.32.0.0", "public"],
      ["100.63.255.255", "public"],
      ["100.64.0.0", "private"],
      ["100.127.255.255", "private"],
      ["100.128.0.0", "public"],
      ["192.0.2.1", "documentation"],
      ["224.0.0.251", "multicast"],
      ["8.8.8.8", "public"],
      ["::1", "loopback"],
      ["::", "unspecified"],
      ["fe80::1", "link-local"],
      ["fd00::1", "private"],
      ["fec0::1", "private"],
      ["ff05::2", "multicast"],
      ["2001:db8::1", "documentation"],
      ["2606:4700:4700::1111", "public"],
      ["::ffff:10.0.0.1", "private"],
      ["::ffff:8.8.8.8", "public"],
      ["2002:0808:0808::1", "public"],
      ["2002:0a00:0001::1", "private"],
      ["64:ff9b::808:808", "public"],
      ["4000::1", "reserved"],
      ["2130706433", null], // not a resolver answer
      ["localhost", null],
    ];
    for (const [addr, cls] of table) assert.equal(classifyAddress(addr), cls, addr);
  });
});
