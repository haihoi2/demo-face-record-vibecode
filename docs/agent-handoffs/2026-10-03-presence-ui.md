# Agent handoff

## Task

- **Title:** Presence P2 UI - "Hiện diện" tab (status strip, event review, labels)
- **Owner/agent:** frontend agent (presence-ui); integration owner Hermes (INT)
- **Acceptance criteria:**
  - Operator tab "Hiện diện" (lucide `PersonStanding`) in `NAV_ITEMS`; `presence` in `NavTabType`; `TAB_MIN_ROLE.presence = "operator"`, so viewers and signed-out users do not see it (the server enforces roles anyway).
  - Status strip from `GET /api/presence/status`: per gate mode, fps, last frame age, worker state/restarts/models, last event, the server's `note`. While any gate is `shadow`, it shows "Chế độ chạy thử: chỉ ghi nhận, chưa gửi cảnh báo". When every gate is off, a plain notice says so. An unknown future mode is shown as-is and never described as shadow.
  - Event list from `GET /api/presence/events`, newest first, with filters: gate, period (working/after-hours), faceOutcome (employee/stranger/none) and label (real/false-alarm/employee, plus "Chưa gắn nhãn" = `label=none`). "Tải thêm" pages via `nextCursor`. Each row has:
    - the body crop from `/api/presence/events/:id/crop`, loaded through `ProtectedImage` (the same approach as stranger faces); a placeholder reads "Ảnh đã xóa sau 7 ngày" when `cropPurgedAt` is set, otherwise "Không có ảnh";
    - time in vi-VN to the second (Asia/Ho_Chi_Minh, so it agrees with the period badge), duration in view and people count;
    - badges for period "Giờ làm"/"Ngoài giờ" and face outcome "Nhân viên"/"Người lạ"/"Không thấy mặt";
    - a "Sẽ cảnh báo" badge, only when `wouldAlert === true`;
    - the current label.
  - Label buttons "Đúng là người" / "Báo nhầm" / "Nhân viên" send `POST /api/presence/events/:id/label { kind }` through `operatorJsonFetch` (CSRF, 401 sign-in retry). The row changes only on a 2xx with `success: true` and the same event id, and the row is replaced with the server's event. A refusal shows the server's `error` text as-is. Status 0 (transport failure) is never a success.
  - Empty, loading and error states. Keyboard: native buttons and selects; `aria-pressed` on label buttons; the busy state uses `aria-disabled`, not `disabled`, so focus stays put. A polite live region announces list status and confirmed labels; row errors use `role="alert"`. All server text is rendered as plain React text.
- **Scope explicitly excluded:** no backend, no SSE subscription (see requests), no top-bar unacknowledged badge, no per-gate admin settings, no engine-card health. Nothing deployed or restarted; the live service was not touched.

## Source control

- **Branch/worktree:** `feat/presence-ui` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a6e9d68dbd267a7dd`
- **Base SHA:** created from `feat/presence-p2` @ `10fc8ee` as instructed, then rebased onto the current `feat/presence-p2` @ `3ab4912` (server routes landed meanwhile)
- **Commit SHA(s):** `87a9f0a` (tab, util, tests, wiring), `fbeb945` (align with the implemented routes), plus this handoff commit
- **Rebased/updated before handoff:** yes (onto `3ab4912`; all gates rerun after the rebase)

## Ownership

- **Files owned:** `src/components/PresencePanel.tsx` (new), `src/utils/presence.ts` (new), `tests/presenceUi.test.ts` (new), minimal lines in `src/components/Navbar.tsx` and `src/App.tsx`, `tests/roleUi.test.ts` (one expected-tab list), this handoff
- **Files forbidden/not touched:** `server.ts`, `src/server/**`, `src/types.ts`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`
- **`server.ts` touched:** no
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** no. This handoff file is the only file under `docs/agent-handoffs/**`, as the task asked.

## Changes

- **Files changed:**
  - `src/utils/presence.ts`: pure helpers. Mirrored types; labels and badge logic; vi-VN formatting; filter parsing; the events URL builder (validates values, clamps limit 1..100, page size 30); crop/label paths (ids URL-encoded); label request; parsers for page/status/event that drop malformed rows and never throw; the label-result reader (2xx + success + same id only); paging merge with de-duplication that stops when a page brings nothing new; row replace; gate options.
  - `src/components/PresencePanel.tsx`: the tab. One status hook polls every 15 s while the page is visible, with an explicit interval cleanup. One list hook uses a generation counter, so replies for an older filter or reload are dropped. Label requests have a synchronous per-event in-flight guard, and nothing is written after unmount.
  - `src/components/Navbar.tsx`: `presence` tab type, `TAB_MIN_ROLE` operator, `NAV_ITEMS` entry after "Nhật Ký Vào Ra".
  - `src/App.tsx`: import; render `{activeTab === "presence" && canSeeTab(operatorSession, "presence") && <PresencePanel />}`; hash alias `#presence`, so a later P3 message link can open the tab.
  - `tests/presenceUi.test.ts`: new unit and source-wiring tests.
  - `tests/roleUi.test.ts`: the operator's visible-tab list now includes `presence`.
- **Behavior changed:** operators and admins see a new tab. No other behavior changed.
- **API/event contracts added or changed:** none. Consumes `src/server/presence/contracts.ts` as implemented in `server.ts` @ `3ab4912`, including the extras the implementation adds: `label=none`, `note` on a status gate, `worker: null`, and `cropPurgedAt` on rows.
- **Schema/migration changed:** no
- **Environment/configuration changed:** no
- **Security/privacy impact:**
  - Body crops are biometric/personal data. They are fetched only through `ProtectedImage` (credentialed same-origin fetch, blob URL revoked on unmount), never through a bare `<img src="/api/...">`, never stored, and lists carry no image.
  - No localStorage or sessionStorage, no `dangerouslySetInnerHTML`, no door or lock calls. Tests assert all of this.
  - The UI does not decide anything: mode, period, outcome, `wouldAlert` and labels all come from the server.

## Verification

Image built with the legacy builder capped at 2 CPUs, because the default BuildKit driver cannot cap CPU. Containers ran one at a time with `--cpus 2`. Final run is on the rebased branch (`fbeb945` sources).

```text
command: DOCKER_BUILDKIT=0 docker build --cpu-period=100000 --cpu-quota=200000 --target tester -t smartface-tests:presence-ui .
result:  exit 0 (the builder stage includes `npm run build`)

command: docker run --rm --cpus 2 --entrypoint npx smartface-tests:presence-ui tsc --noEmit
result:  exit 0, no output

command: docker run --rm --cpus 2 --entrypoint npm smartface-tests:presence-ui run lint
result:  exit 0 (tsc --noEmit)

command: docker run --rm --cpus 2 --entrypoint node smartface-tests:presence-ui --import tsx --test tests/presenceUi.test.ts tests/roleUi.test.ts
result:  exit 0 - tests 39, pass 39, fail 0, skipped 0

command: docker run --rm --cpus 2 --entrypoint npm smartface-tests:presence-ui test
result:  exit 0 - tests 1104, suites 229, pass 1096, fail 0, cancelled 0, skipped 8

command: docker run --rm --cpus 2 --entrypoint npm smartface-tests:presence-ui run build
result:  exit 0 - vite built in 16.0 s; only the pre-existing ">500 kB chunk" warning (index ~1.96 MB)
```

The test image and the intermediate images from these builds were removed afterwards. Host root disk is at 61%.

- **Not run and why:**
  - Integration tests (`tests/integration/presence.test.ts`): they need an isolated gateway and DB, which is out of scope for a UI-only change and must never target live.
  - There is no React component-test harness in the repo, so component behavior is covered by pure-helper tests plus source-wiring assertions.
- **Manual verification:** none in a browser. The routes are not running anywhere I am allowed to touch: dev or staging would need INT to build `feat/presence-p2` + this branch.

## Data and deployment

- **Forward migration:** none
- **Rollback or compensation:** revert `fbeb945` and `87a9f0a` (frontend only; no data written by the UI apart from append-only label rows through the server route)
- **Backward compatibility:** against a server without the presence routes, the tab shows the server's or HTML-fallback error text in the status/list error boxes. It never shows an empty "all clear" in place of an error.
- **Data retention/deletion impact:** none client-side. Crops are never cached: blob URLs live only while mounted, and the server sends `Cache-Control: private, no-store`.
- **Deployment/restart required:** yes, a frontend rebuild is needed for it to appear, but only after INT integrates and an explicit owner-approved deploy. Test on dev before staging.

## Risks and follow-up

- **Known risks:**
  - **Server paging with a label filter can stop early.** `db.getPresenceEventsPage` over-fetches `min(1000, n*10+1)` rows and filters by label after the SQL. If fewer than `n+1` matching rows sit inside that window, it returns `hasMore: false` even though older matching events exist. "Tải thêm" then disappears early for rare labels. Suggested fix for INT (db owner): put the latest-label subquery in the SQL `WHERE`, or loop until `n+1` matches or the table is exhausted. Unit-level only; not reproduced against a running server.
  - Labelling an event while a label filter is active keeps the row visible with its new label, even if it no longer matches. This is deliberate, so the operator sees the confirmation and can correct it; "Làm mới" re-applies the filter.
  - The status "Sự kiện gần nhất" relies on `host.stats().lastEventAt`, which is `null` until the presence host is wired. It then shows "Chưa có".
- **Unresolved questions:**
  - Should the server expose gate labels in `/api/presence/status`, e.g. `label`? The UI currently shows "Cổng vào"/"Cổng ra" for legacy ids and "Cổng <id>" otherwise.
  - Is the 7-day text in "Ảnh đã xóa sau 7 ngày" acceptable while `PRESENCE_EVENT_RETENTION_DAYS` is configurable? An alternative is for the server to send `retentionDays` in status.
- **Dependencies on other agents/commits:** `feat/presence-p2` @ `3ab4912` (routes). The presence host/worker is not needed for the UI to load.
- **Requested integration action/order:**
  1. Merge `feat/presence-ui` after `feat/presence-p2` (already based on `3ab4912`; fast-forward-able onto it).
  2. Optional, App.tsx SSE owner: `server.ts` already broadcasts `presence_event`. If wanted, handle it in the central SSE handler in `App.tsx` and pass a `presenceRevision` counter prop to `<PresencePanel>`, which could then refresh or show "Có sự kiện mới". I did not add an `EventSource`, to keep SSE ownership central.
  3. db owner: the label-filter paging fix above.
  4. Rerun the full gates on the integrated branch. Verify on dev with a clip (status strip shadow notice, crop loads, label 2xx and 403 for a viewer token) before any staging deploy.
