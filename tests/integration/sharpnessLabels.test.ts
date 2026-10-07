/** Face sharpness S0 routes: access, validation. (No stored faces on the test gateway: sample is empty.) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, postJson, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("sharpness labelling routes", () => {
  it("access: anonymous 401, viewer 403; admin sees sample and summary", async () => {
    assert.equal((await rawApi("/api/strangers/sharpness/sample")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/strangers/sharpness/sample")).status, 403);
    assert.equal((await apiAs(viewer, "/api/strangers/sharpness/summary")).status, 403);
    const sample = await api<any>("/api/strangers/sharpness/sample?limit=5");
    assert.equal(sample.status, 200, sample.text.slice(0, 200));
    assert.ok(Array.isArray(sample.body.faces));
    assert.equal(sample.body.target, 300);
    const summary = await api<any>("/api/strangers/sharpness/summary");
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.facesRated, "number");
  });
  it("rating: validated; unknown face 404; legacy ids 400", async () => {
    assert.equal((await postJson("/api/strangers/faces/SF-nope/rating", { rating: "great" })).status, 400);
    assert.equal((await postJson("/api/strangers/faces/SF-does-not-exist/rating", { rating: "sharp" })).status, 404);
    assert.equal((await postJson("/api/strangers/faces/LOG-1/rating", { rating: "sharp" })).status, 400);
  });
});
