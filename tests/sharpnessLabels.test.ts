/** Face sharpness S0 labelling: ratings, sample order, summary, and that ratings never touch blur reports. */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FACE_RATINGS, isBlurReportOnlyKind, latestRatings, ratingSummary, sharpnessSampleOrder } from "../src/server/blurReports";
import { ratingForKey, ratingRequest, readSample, sampleRequest } from "../src/utils/sharpnessLabels";

const row = (faceId: string, kind: string, actor: string, at: string, id = `${faceId}-${actor}-${at}`) => ({ faceId, kind, actor, at, id });

describe("sharpness ratings", () => {
  it("ratings are not blur reports", () => {
    for (const k of Object.values(FACE_RATINGS)) assert.equal(isBlurReportOnlyKind(k), false, k);
    assert.equal(isBlurReportOnlyKind("blur"), true);
  });
  it("the same order for everyone, independent of capture time", () => {
    const faces = ["SF-a", "SF-b", "SF-c", "SF-d"].map((id) => ({ id }));
    const one = sharpnessSampleOrder(faces).map((f) => f.id);
    assert.deepEqual(sharpnessSampleOrder([...faces].reverse()).map((f) => f.id), one);
    assert.equal(new Set(one).size, 4);
  });
  it("a person's newest rating of a face replaces their earlier one; blur reports are ignored", () => {
    const latest = latestRatings([
      row("SF-1", "rated-blurry", "an", "2026-10-07T01:00:00Z"),
      row("SF-1", "rated-sharp", "an", "2026-10-07T02:00:00Z"),
      row("SF-1", "blur", "an", "2026-10-07T03:00:00Z"),
    ]);
    assert.deepEqual(latest.map((r) => r.kind), ["rated-sharp"]);
  });
  it("summary: counts, people, and agreement on faces rated by two people", () => {
    const s = ratingSummary([
      row("SF-1", "rated-sharp", "an", "2026-10-07T01:00:00Z"),
      row("SF-1", "rated-sharp", "binh", "2026-10-07T01:00:01Z"),
      row("SF-2", "rated-blurry", "an", "2026-10-07T01:00:02Z"),
      row("SF-2", "rated-sharp", "binh", "2026-10-07T01:00:03Z"),
      row("SF-3", "rated-not-face", "an", "2026-10-07T01:00:04Z"),
    ]);
    assert.equal(s.facesRated, 3);
    assert.deepEqual(s.byRating, { sharp: 3, blurry: 1, notFace: 1 });
    assert.deepEqual(s.byActor, { an: 3, binh: 2 });
    assert.equal(s.ratedByTwoOrMore, 2);
    assert.equal(s.agreementPct, 50);
  });
});

describe("labelling screen helpers", () => {
  it("keys 1/2/3 rate, S skips, Backspace goes back", () => {
    assert.equal(ratingForKey("1"), "sharp");
    assert.equal(ratingForKey("2"), "blurry");
    assert.equal(ratingForKey("3"), "not-face");
    assert.equal(ratingForKey("s"), "skip");
    assert.equal(ratingForKey("Backspace"), "back");
    assert.equal(ratingForKey("x"), null);
  });
  it("requests and replies", () => {
    assert.equal(sampleRequest(500), "/api/strangers/sharpness/sample?limit=100");
    const r = ratingRequest("SF-1/x", "blurry");
    assert.equal(r.url, "/api/strangers/faces/SF-1%2Fx/rating");
    assert.deepEqual(JSON.parse(String(r.init.body)), { rating: "blurry" });
    assert.deepEqual(readSample({ faces: [{ faceId: "SF-1", imageUrl: "/api/strangers/faces/SF-1/image", capturedAt: "t" }, { bad: 1 }], ratedByMe: 4 }).faces.length, 1);
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const db = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../src/server/auth.ts", import.meta.url), "utf8");
  it("operators rate (CSRF), admins read the summary; the blur badge ignores ratings", () => {
    assert.match(src, /app\.post\("\/api\/strangers\/faces\/:faceId\/rating", requireOperatorRole\("operator"\), requireCsrf,/);
    assert.match(src, /app\.get\("\/api\/strangers\/sharpness\/summary", requireOperatorRole\("admin"\)/);
    assert.match(auth, /sharpness\\\/sample\$\/, role: "operator"/);
    assert.match(db, /if \(!isBlurReportOnlyKind\(r\.kind\)\) continue;/);
  });
});
