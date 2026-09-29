/**
 * Per-face stranger records (plan docs/plans/2026-09-29-per-face-stranger-observations.md,
 * section 9): two people in one frame are two tiles sharing one logId, so the
 * panel identifies tiles by observation id, sends the observation ids with
 * every resolve request, and links a face crop to its whole frame.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { StrangerPhoto } from "../src/types";
import {
  defaultActiveObservationId,
  findPhotoByObservationId,
  frameLinkPath,
  observationIdOf,
  photoForSnapshot,
  photoMatchesTarget,
  preselectTarget,
  resolvePayloadIds,
} from "../src/utils/strangerPhotos";

const photo = (extra: Partial<StrangerPhoto> & { logId: string }): StrangerPhoto => ({
  photoSnapshot: `/api/logs/${extra.logId}/image`,
  timestamp: "2026-09-29T01:00:00.000Z",
  doorName: "Cổng vào - Camera 1",
  confidence: 0,
  ...extra,
});

// Two strangers in frame LOG-1, plus an older whole-frame capture LOG-0.
const faceA = photo({
  logId: "LOG-1",
  observationId: "face:SF-a",
  faceId: "SF-a",
  photoSnapshot: "/api/strangers/faces/SF-a/image",
  frameUrl: "/api/logs/LOG-1/image",
});
const faceB = photo({
  logId: "LOG-1",
  observationId: "face:SF-b",
  faceId: "SF-b",
  photoSnapshot: "/api/strangers/faces/SF-b/image",
  frameUrl: "/api/logs/LOG-1/image",
});
const legacy = photo({ logId: "LOG-0" });

describe("stranger tile identity", () => {
  it("uses the server's observation id, falling back to log:<logId> for older servers", () => {
    assert.equal(observationIdOf(faceA), "face:SF-a");
    assert.equal(observationIdOf(legacy), "log:LOG-0");
    assert.equal(observationIdOf({ logId: "LOG-9", observationId: "  " }), "log:LOG-9");
  });

  it("keeps two faces of one frame distinguishable", () => {
    assert.notEqual(observationIdOf(faceA), observationIdOf(faceB));
    const photos = [faceA, faceB, legacy];
    assert.equal(findPhotoByObservationId(photos, "face:SF-b"), faceB);
    assert.equal(findPhotoByObservationId(photos, "log:LOG-0"), legacy);
    assert.equal(findPhotoByObservationId(photos, "log:LOG-1"), undefined);
    assert.equal(findPhotoByObservationId(photos, ""), undefined);
  });

  it("opens a cluster on the preferred tile, else the primary photo's tile, else the first", () => {
    const cluster = { photos: [faceA, faceB], primaryPhoto: faceB.photoSnapshot };
    assert.equal(defaultActiveObservationId(cluster, "face:SF-a"), "face:SF-a");
    assert.equal(defaultActiveObservationId(cluster, "face:SF-zz"), "face:SF-b");
    assert.equal(defaultActiveObservationId(cluster), "face:SF-b");
    assert.equal(defaultActiveObservationId({ photos: [faceA, faceB], primaryPhoto: "/elsewhere" }), "face:SF-a");
    assert.equal(defaultActiveObservationId({ photos: [], primaryPhoto: "" }), "");
  });
});

describe("in-app photo preselection", () => {
  it("finds a tile by its own image first, then by its frame", () => {
    const photos = [faceA, faceB, legacy];
    assert.equal(photoForSnapshot(photos, faceB.photoSnapshot), faceB);
    assert.equal(photoForSnapshot(photos, "/api/logs/LOG-1/image"), faceA);
    assert.equal(photoForSnapshot(photos, legacy.photoSnapshot), legacy);
    assert.equal(photoForSnapshot(photos, "/api/logs/NOPE/image"), undefined);
    assert.equal(photoForSnapshot(photos, null), undefined);
  });
});

describe("resolve request ids", () => {
  it("carry one observation id per tile and the legacy log ids once each", () => {
    const ids = resolvePayloadIds([faceA, faceB, legacy]);
    assert.deepEqual(ids.clusterObservationIds, ["face:SF-a", "face:SF-b", "log:LOG-0"]);
    assert.deepEqual(ids.clusterLogIds, ["LOG-1", "LOG-0"]);
    assert.equal("sourceLogId" in ids, false);
    assert.equal("sourceObservationId" in ids, false);
  });

  it("name the chosen tile by observation id alongside its log id", () => {
    const ids = resolvePayloadIds([faceA, faceB], faceB);
    assert.equal(ids.sourceObservationId, "face:SF-b");
    assert.equal(ids.sourceLogId, "LOG-1");
  });

  it("still work against an older server that sends no observation ids", () => {
    const older = [photo({ logId: "L1" }), photo({ logId: "L2" })];
    const ids = resolvePayloadIds(older, older[1]);
    assert.deepEqual(ids.clusterLogIds, ["L1", "L2"]);
    assert.deepEqual(ids.clusterObservationIds, ["log:L1", "log:L2"]);
    assert.equal(ids.sourceObservationId, "log:L2");
    assert.equal(ids.sourceLogId, "L2");
  });
});

describe("whole-frame link", () => {
  it("accepts only a same-origin API path", () => {
    assert.equal(frameLinkPath(faceA), "/api/logs/LOG-1/image");
    assert.equal(frameLinkPath({ frameUrl: "/api/logs/LOG-1/image?v=2" }), "/api/logs/LOG-1/image?v=2");
    for (const frameUrl of [
      undefined,
      "",
      "javascript:alert(1)",
      "https://evil.test/api/logs/LOG-1/image",
      "//evil.test/api/logs/x",
      "/api//evil",
      "/api/logs/../../admin",
      "/api/logs/%2e%2e/admin",
      "/other/LOG-1/image",
      "/api/logs/LOG 1/image",
    ]) {
      assert.equal(frameLinkPath({ frameUrl }), null, String(frameUrl));
    }
  });
});

describe("deep-link targets", () => {
  it("prefer a face id over a log id and match the right tile", () => {
    assert.deepEqual(preselectTarget(" SF-b ", "LOG-1"), { kind: "face", id: "SF-b" });
    assert.deepEqual(preselectTarget(null, " LOG-1 "), { kind: "log", id: "LOG-1" });
    assert.equal(preselectTarget("", ""), null);
    assert.equal(photoMatchesTarget(faceB, { kind: "face", id: "SF-b" }), true);
    assert.equal(photoMatchesTarget(faceA, { kind: "face", id: "SF-b" }), false);
    assert.equal(photoMatchesTarget(faceA, { kind: "log", id: "LOG-1" }), true);
    assert.equal(photoMatchesTarget(legacy, { kind: "face", id: "LOG-0" }), false);
  });
});

describe("stranger panel source", () => {
  const src = readFileSync(new URL("../src/components/StrangerClusterModal.tsx", import.meta.url), "utf8");

  it("keys and selects tiles by observation id, never by logId or photo URL", () => {
    assert.match(src, /const tileId = observationIdOf\(photo\);/);
    assert.match(src, /key=\{tileId\}/);
    assert.match(src, /activeObservationId === tileId/);
    assert.match(src, /setActiveObservationId\(tileId\)/);
    assert.doesNotMatch(src, /key=\{photo\.logId/);
    assert.doesNotMatch(src, /activePhotoUrl/);
    assert.doesNotMatch(src, /photoSnapshot === activePhoto/);
  });

  it("sends observation ids in quick-register, merge and dismiss", () => {
    assert.equal((src.match(/\.\.\.resolvePayloadIds\(selectedCluster\.photos, activePhoto\)/g) || []).length, 2);
    assert.match(src, /\.\.\.resolvePayloadIds\(cluster\.photos\),\s*\n\s*reason:/);
    assert.doesNotMatch(src, /clusterLogIds: [a-zA-Z.]+\.photos\.map/);
    for (const route of ["/api/strangers/quick-register", "/api/strangers/merge", "/api/strangers/dismiss"]) {
      assert.ok(src.includes(`"${route}"`), route);
    }
  });

  it("links a face tile and the chosen photo to the whole frame in a new tab", () => {
    const links = src.match(/<a\b[\s\S]*?<\/a>/g) || [];
    const frameLinks = links.filter((a) => /normalizeApiAssetUrl\((?:framePath|activeFramePath)\)/.test(a));
    assert.equal(frameLinks.length, 2);
    for (const a of frameLinks) {
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener noreferrer"/);
    }
    assert.match(src, /<span>Xem khung hình<\/span>/);
    assert.match(src, /\{activeFramePath && \(/);
    assert.match(src, /\{framePath && \(/);
  });

  it("shows the chosen crop at thumbnail size rather than stretched", () => {
    assert.match(src, /<FaceThumb\s+src=\{activePhoto\.photoSnapshot\}[\s\S]{0,120}className="w-24 h-24/);
  });

  it("resolves a face deep link through the lookup route", () => {
    assert.match(src, /initialPreselectedFaceId\?: string \| null;/);
    assert.match(src, /\/api\/strangers\/lookup\?faceId=\$\{encodeURIComponent\(target\.id\)\}/);
    assert.match(src, /\[isOpen, initialPreselectedLogId, initialPreselectedFaceId\]/);
  });
});
