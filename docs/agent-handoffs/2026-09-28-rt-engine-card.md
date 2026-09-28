# Agent handoff: real-time engine card with a per-gate admin switch

## Task

- **Title:** Fourth card "Động cơ thời gian thực" on the AI config engine tab, with the pipeline mode
  (legacy | shadow | live) switched per gate by an admin.
- **Owner/agent:** card (frontend), option 2 of the owner's choice: the real-time pipeline is a SEPARATE
  engine flow beside the legacy workflow, never one of the three `engineMode` values.
- **Acceptance criteria:**
  1. The engine tab shows a fourth card in the same visual language, clearly NOT selectable as
     `engineMode`, explaining that the pipeline runs beside the current workflow per gate and that
     shadow only observes (no door, no logs).
  2. One row per gate (Cổng vào / Cổng ra): effective mode, source (theo cấu hình / mặc định máy chủ),
     the "configured but not available" note, stream health (status, fps, newest-frame age with the
     >1.5 s warning, reconnects), decisions/employees/strangers/insufficient, frames processed/dropped,
     loop and decision latency, contextOk + reason, worker state/restarts/engineReady/openTracks,
     detectInput, lastError with `scheme://user:pass@` masked.
  3. Admin-only control per gate: legacy | shadow | live (`live` disabled, title "chưa có trong bản
     này"), confirm dialog before every switch (shadow and back-to-legacy wording as requested),
     "Dùng mặc định máy chủ" sends `mode: null`. Success re-reads the watch data and shows the new
     effective mode; 409 shows the server's message; non-admin sees read-only rows with a hint.
  4. Poll `GET /api/camera-streams/watch` every 5 s while the page is visible; stop on unmount.
  5. "Lưu ý triển khai" mentions the per-gate switch in this card.
  6. Tests for the helper logic and a source-level guard that the card never writes `engineMode`;
     typecheck, unit, build green in the isolated image.
- **Scope explicitly excluded:** every backend change (INT implemented the route and the two new fields in
  parallel - landed as `ad8918d` on the base during this task); `src/types.ts` (INT's commit already
  contains the two additions this card needs); SSE reuse (no shared hook exists - see risks).

## Source control

- **Branch/worktree:** `feat/rt-engine-card` in `/opt/etonlab/dev/demo-face-record-vibecode-wt/rt-ui`
- **Base SHA:** started on `fa94a1a` (unit 706/0); rebased onto `ad8918d` (`release/rt-pipeline`,
  INT's "admin switch for a gate's real-time pipeline mode", unit 707/0)
- **Commit SHA(s):** `df24cf9` feat(ui): real-time engine card with a per-gate admin switch; plus this handoff commit
- **Rebased/updated before handoff:** yes - `release/rt-pipeline` moved to `ad8918d` during the task; rebased
  cleanly (no conflicts) and every gate was rerun on the rebased tree

## Ownership

- **Files owned:** `src/components/RealtimeEngineCard.tsx` (new), `src/components/AiConfigPage.tsx`,
  `src/utils/pipelineMode.ts` (new), `src/utils/pipelineStatus.ts` (additive), `tests/pipelineModeControl.test.ts`
  (new), this handoff.
- **Files forbidden/not touched:** `server.ts`, `src/server/**`, `src/types.ts`, `src/utils/api.ts`,
  `src/App.tsx`, shared context (`AGENTS.md`, `CLAUDE.md`, `.claude/**`).
- **`server.ts` touched:** no
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** none

## Changes

- **Files changed:**
  - `src/components/RealtimeEngineCard.tsx` (new): the card, per-gate rows, admin segmented control,
    confirm dialog (focus in / Tab trapped / Escape / backdrop / focus restored), `role="status"`
    live region, 5 s visibility-gated poll with cleanup.
  - `src/utils/pipelineMode.ts` (new, pure): `readGatePipelineRow(s)`, `pipelineModeSourceLabel`,
    `buildPipelineModeRequest`, `pipelineModeConfirmText`, `interpretPipelineModeResponse`,
    `isPipelineModeSelectable`, gate key/label helpers.
  - `src/utils/pipelineStatus.ts` (additive): `PipelineStats` gains the optional counters, `contextOk`,
    `contextReason`, `worker`, `lastError`; new `normalizePipelineWorker`, `workerStateLabel`. The W0
    shape for an older server is unchanged (pinned by the existing test).
  - `src/components/AiConfigPage.tsx`: imports and renders `<RealtimeEngineCard />` after the three
    selectable cards; rewords "Lưu ý triển khai".
  - `tests/pipelineModeControl.test.ts` (new).
- **Behavior changed:** the engine tab shows the new card. Nothing else on the page changes; the three
  `engineMode` cards and the Save button behave exactly as before. The card's only write is
  `POST /api/camera-streams/:gate/pipeline-mode` via `operatorJsonFetch` (session cookie + CSRF, 401
  sign-in prompt); every displayed value comes from the server's watch payload or the POST response.
  The switch shows the CONFIGURED value (`pipelineModeSource === "config"` ->
  `pipelineModeRequested ?? pipelineMode`), so the card does not need `GET /api/camera-streams/config`.
- **API/event contracts added or changed:** none implemented here. The UI CONSUMES INT's contract:
  - `GET /api/camera-streams/watch` `watchers[]`: `pipelineMode`, `pipelineModeRequested`,
    `pipelineModeSource: "config" | "env"`, `pipelineState`, `pipelineStats` (all optional, read
    defensively; absent fields render as "máy chủ chưa báo").
  - `POST /api/camera-streams/:gate/pipeline-mode` (gate = entry | exit) body `{ "mode": "legacy" |
    "shadow" | "live" | null }`; 200 `{ success, gate, pipelineMode, pipelineModeRequested?,
    pipelineModeSource, watcher }`; 400/403/409 `{ success:false, code?, error }`.
  - Response handling: only a 2xx body with `success: true` is treated as applied; 409 shows the
    server's `error`; 403 "cần Quản trị"; 401 "cần đăng nhập"; 404 "máy chủ chưa có API"; status 0 is
    a transport failure ("CHƯA đổi"), never success.
- **Schema/migration changed:** no
- **Environment/configuration changed:** no
- **Security/privacy impact:** no credentials, tokens or embeddings in browser state or storage; the
  card never calls a door route (source-level test); admin gating in the UI is a courtesy, the server
  enforces role + CSRF; `lastError` / `contextReason` pass through `redactCredentialUrls` before render.
  Demo/offline paths are not involved (the card does nothing without a server).

## Verification

```text
command: docker build -q --target tester -t smartface-tests:rt-card .
result:  exit 0 (sha256:761eb30c..., built from the rebased tree)
command: docker run --rm --cpus 2 smartface-tests:rt-card npm run typecheck
result:  exit 0
command: docker run --rm --cpus 2 smartface-tests:rt-card npm test
result:  exit 0 - tests 742, pass 736, fail 0, skipped 6 (base ad8918d: 707 pass / 0 fail; +29 new).
         Same run before the rebase on fa94a1a: 741 / 735 / 0 / 6.
command: docker run --rm --cpus 2 smartface-tests:rt-card npm run build
result:  exit 0 (client, server, faceWorker and pipelineWorker bundles)
```

All containers ran at `--cpus 2` under `nice -n 15`; the gate script paused (60 s re-checks) while the
1-minute host load was above 7.5 because a live soak is running on the dev gateway.

- **Not run and why:** integration suite - no server behaviour or persistence changed and the backend
  route is not in this tree (INT implements it in parallel). No browser automation exists in the repo;
  component behaviour is covered by pure-logic tests plus source-level checks.
- **Manual verification:** none in a real browser (backend route not available in this tree).

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** revert the feature commit; the card writes nothing until INT's route exists.
- **Backward compatibility:** on today's server (no `pipelineModeSource`, no route) the rows show the
  effective mode with "máy chủ chưa báo nguồn", the "Dùng mặc định máy chủ" button stays disabled, and a
  switch attempt reports HTTP 404 without changing anything.
- **Data retention/deletion impact:** none.
- **Deployment/restart required:** yes - image rebuild (frontend bundle) when released, together with INT's route.

## Risks and follow-up

- **Known risks:**
  - The card polls `/api/camera-streams/watch` every 5 s while the AI config page is open (paused
    while the tab is hidden). `CameraDashboard` already polls the same route at the same cadence when
    it is open; the two pages are never mounted together, so the load does not double.
  - No shared SSE hook exists (`CameraDashboard` opens its own `EventSource`); centralising
    `gate_watch_state` ownership is a follow-up, not done here.
  - `live` is hard-disabled in the UI (owner: not in this build). When a build ships `live`, drop the
    `isPipelineModeSelectable` guard; the 409 path already handles a server that still refuses.
  - Worker state strings are labelled for `running/ready/starting/restarting/stopped/failed/crashed`;
    any other string is shown as-is.
- **Unresolved questions:**
  - Should "Dùng mặc định máy chủ" also require a confirm when the env default is `shadow` (it does
    today - every switch confirms; the text explains that the env default may start a stream)?
  - Should the card show the env default itself (e.g. "mặc định máy chủ: legacy") when a gate is
    overridden? It would need the server to send the default as well (not in the contract).
- **Dependencies on other agents/commits:** INT's `ad8918d` (already on the base and under this branch).
  Verified against it read-only: `src/types.ts` gained exactly `GateWatchRuntime.pipelineModeSource?:
  "config" | "env"` and `GateStreamConfig.pipelineMode?: "legacy" | "shadow" | "live"`; the route answers
  400 `{ success:false, error }`, 409 `{ success:false, code:"PIPELINE_MODE_NOT_AVAILABLE", error:"Chế độ
  live chưa có trong bản này." }` and 200 `{ success:true, gate, pipelineMode, pipelineModeRequested?,
  pipelineModeSource, watcher }` - the shapes the card's `interpretPipelineModeResponse` handles.
- **Requested integration action/order:**
  1. No hotspot change is needed any more: the two `src/types.ts` additions this card would have
     proposed are already in `ad8918d`. Optional convenience type, if the type owner wants one:
     ```ts
     export interface PipelineModeChangeResponse {
       success: boolean;
       gate: "ENTRY" | "EXIT";
       pipelineMode: "legacy" | "shadow" | "live";
       pipelineModeRequested?: "legacy" | "shadow" | "live";
       pipelineModeSource: "config" | "env";
       watcher: GateWatchRuntime;
       code?: "PIPELINE_MODE_NOT_AVAILABLE";
       error?: string;
     }
     ```
  2. Fast-forward `feat/rt-engine-card` (one feature commit + this handoff) onto `release/rt-pipeline`;
     rerun the full unit gate from the integrated branch. A browser check against an isolated gateway
     (admin: shadow -> row shows "chạy thử (shadow)" + "theo cấu hình"; live -> 409 message; null ->
     "mặc định máy chủ"; viewer: read-only rows) is the remaining manual step for the integrator.
