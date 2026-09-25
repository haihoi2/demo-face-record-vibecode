/**
 * A rejected async route handler must reach Express's error path instead of
 * becoming an unhandled rejection that terminates the gateway.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

import { guardAsyncRoutes, guardHandler, jsonErrorHandler } from "../src/server/asyncRoutes";

async function withServer(build: (app: express.Application) => void, fn: (base: string) => Promise<void>) {
  const app = express();
  guardAsyncRoutes(app);
  build(app);
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("guarded async routes", () => {
  it("turns a rejected async handler into a 500 and keeps serving", async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
      await withServer((app) => {
        app.get("/boom", async () => { throw new Error("database went away"); });
        app.get("/ok", (_req, res) => { res.json({ ok: true }); });
      }, async (base) => {
        const boom = await fetch(`${base}/boom`);
        assert.equal(boom.status, 500);
        assert.equal((await boom.json()).success, false);
        const ok = await fetch(`${base}/ok`);
        assert.equal(ok.status, 200, "the server is still serving after the failure");
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, 0, "nothing escaped as an unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("also covers synchronous throws, route arrays and middleware chains", async () => {
    await withServer((app) => {
      app.get(["/a", "/b"], (_req, _res, next) => next(), () => { throw new Error("sync"); });
    }, async (base) => {
      assert.equal((await fetch(`${base}/a`)).status, 500);
      assert.equal((await fetch(`${base}/b`)).status, 500);
    });
  });

  it("leaves error middleware (four parameters) untouched and settings reads working", () => {
    const errorMw = (_e: unknown, _q: unknown, _s: unknown, _n: unknown) => undefined;
    assert.equal(guardHandler(errorMw), errorMw);
    const app = express();
    guardAsyncRoutes(app);
    app.set("trust proxy", 1);
    assert.equal(app.get("trust proxy"), 1);
  });
});
