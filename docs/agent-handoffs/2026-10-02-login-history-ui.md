# Agent handoff

## Task

- **Title:** Sign-in history UI on the admin "Tài khoản" page (owner request 2026-10-02: "audit login history for user").
- **Owner/agent:** frontend agent (login-history-ui). Integration owner: Hermes (INT).
- **Acceptance criteria:**
  1. Each account row has a "Lịch sử đăng nhập" action. It opens a drawer listing that account's events (`userId` filter), newest first, with "Tải thêm" paging through `nextCursor`.
  2. A page-level "Toàn bộ lịch sử đăng nhập" view has no `userId` filter, so it shows unknown usernames, setup-token sign-ins and rate-limited addresses. It has a kind filter: all, or only failures (`sign-in-failed` + `locked` + `rate-limited`).
  3. Each row shows the time (vi-VN date with seconds), the kind as a coloured pill, the method ("Tài khoản" / "Mã khởi tạo"), the username, the reason in Vietnamese, the IP, and a short browser label with the full user-agent in a `title` tooltip. All of it is plain text.
  4. The page-level view has a summary: failures in the last 24 h and how many distinct IPs they came from. The label says when the count only covers the loaded rows.
  5. Empty, loading and error states. The server's error text is shown as-is. The page stays admin-only.
  6. Unit tests for the pure helpers.
- **Scope explicitly excluded:** the backend route and store (INT), `server.ts`, `src/server/**`, `src/types.ts`, shared agent context.

## Source control

- **Branch/worktree:** `feat/login-history-ui` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a21fe3379082a2148`
- **Base SHA:** `90be9c4` (`feat/login-hardening`, contract commit; unchanged at handoff)
- **Commit SHA(s):**
  - `099f665` feat(users-ui): sign-in history - per-account drawer and a page-level tab
  - plus the commit that adds this handoff
- **Rebased/updated before handoff:** yes. `feat/login-hardening` was still at `90be9c4`, so no rebase was needed.

## Ownership

- **Files owned:** `src/components/UsersPage.tsx`, `src/components/LoginHistory.tsx` (new), `src/utils/loginEvents.ts` (new), `tests/loginHistoryUi.test.ts` (new), this handoff.
- **Files forbidden/not touched:** `server.ts`, `src/server/**` (`src/server/loginEvents.ts` is only imported by the test, to check the kind list), `src/types.ts`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`.
- **`server.ts` touched:** no
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** no. The only shared-context file is this handoff, as the task requested.

## Changes

- **Files changed:**
  - `src/utils/loginEvents.ts` (new, pure). It mirrors the contract types; the browser bundle does not import the server module, and a test checks the mirrored kinds against `LOGIN_EVENT_KINDS`. It contains:
    - labels: kind, tone/pill class, reason, method; `formatLoginTime`; `userAgentLabel`
    - request and response: `buildLoginEventsUrl` (clamps limit to 1..200), `parseLoginEventsPage` (drops malformed rows; falls back to the last row id as the cursor; an empty page has no more), `loginEventsErrorText` (server text first; status 0 is a network failure, not a refusal)
    - paging: `appendLoginEventsPage` (deduplicates by id; stops if a page brings nothing new), `streamToAdvance`, `mergeLoginEventStreams`
    - filter and summary: `streamsForFilter`, `parseLoginKindFilter`, `summarizeLoginFailures`
  - `src/components/LoginHistory.tsx` (new):
    - `LoginHistoryPanel`: kind filter, refresh, summary, a `role="status"` live region, table, "Tải thêm", and loading, empty and error states with "Thử lại". One hook owns the requests; a response that arrives after the filter changed or the panel unmounted is dropped.
    - `LoginHistoryDrawer`: a right-side `role="dialog"` with `aria-modal`. Focus moves in on open, Tab is trapped, Escape and the backdrop close it, and focus returns to the button that opened it.
  - `src/components/UsersPage.tsx`:
    - WAI-ARIA tabs "Tài khoản" / "Toàn bộ lịch sử đăng nhập" (arrows, Home and End).
    - The existing content is unchanged inside the "Tài khoản" tab panel. Its inner lines were not re-indented, to keep the diff narrow.
    - A History icon button per account (`title` and `aria-label`) opens the drawer.
    - The header "Làm mới" button is shown on the accounts tab only; the history panel has its own.
- **Behavior changed:** the admin page gains the two views above. Account management works exactly as before.
- **"Only failures" filter:** the contract filters by one `kind`, so the UI runs one query per failure kind (3 streams) and merges them. A row is shown only when no unfinished stream could still hold a newer row, so the list stays in server order (`at DESC, id DESC`) without gaps. "Tải thêm" advances the stream that holds the list back. The filter also offers each single kind, which is one stream.
- **API/event contracts added or changed:** none. The UI consumes `GET /api/users/login-events` exactly as in `src/server/loginEvents.ts`.
- **Schema/migration changed:** none.
- **Environment/configuration changed:** none.
- **Security/privacy impact:**
  - Read-only UI. It never stores events, credentials or tokens in browser storage.
  - Username, IP and user-agent are attacker-controlled. They are rendered as React text and attributes only; there is no `dangerouslySetInnerHTML`, and a test checks for that. The browser label strips control characters and caps unknown strings at 24 characters.
  - Authorization stays with the server. The tab is admin-only (`TAB_MIN_ROLE.users === "admin"`, which the test asserts). A 401 goes through the `operatorJsonFetch` sign-in retry. A 403 or other refusal is shown with the server's text and never as an empty list.

## Verification

All gates ran in Docker against the final tree (image rebuilt after the last source change).

```text
command: docker build --target tester -t smartface-tests:login-ui .
result:  exit 0 (the builder stage runs `npm run build`)

command: docker run --rm --entrypoint npx smartface-tests:login-ui tsc --noEmit
result:  exit 0

command: docker run --rm --entrypoint npm smartface-tests:login-ui run lint
result:  exit 0

command: docker run --rm smartface-tests:login-ui            (npm test)
result:  exit 0 - tests 1044, suites 212, pass 1036, fail 0, cancelled 0, skipped 8

command: docker run --rm --entrypoint node smartface-tests:login-ui --import tsx --test tests/loginHistoryUi.test.ts
result:  exit 0 - tests 44, suites 9, pass 44, fail 0

command: docker run --rm --entrypoint npm smartface-tests:login-ui run build
result:  exit 0 - "built in 15.40s" (Vite's usual >500 kB chunk-size warning; not an error)
```

- **Not run and why:**
  - Integration tests: no route exists on this base yet, and the UI adds none.
  - Browser/E2E: the endpoint is not implemented on this base, and the live service must not be touched.
- **Manual verification:** none in a browser. Verified by unit tests, source checks, the typecheck and the production build.

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** revert `099f665`. It only adds UI.
- **Backward compatibility:** against a server without the route, the history views show the server's error text, for example HTTP 404. Account management is unaffected.
- **Data retention/deletion impact:** none in the browser; events are held only in component state while the view is open.
- **Deployment/restart required:** a rebuild is needed to ship it, together with INT's backend. Do not deploy without the owner's approval.

## Risks and follow-up

- **Known risks:**
  - "Only failures" makes 3 requests per page.
  - The 24 h summary uses the browser clock. Clock skew moves the window edge, and the label says it covers loaded rows only.
  - The user-agent label is a heuristic. The full string is always in the tooltip.
- **Unresolved questions / requests for INT (backend, not done here):**
  1. Optional: accept `kind=failures`, or a comma list, on the route. The UI would then switch "only failures" to one stream; that is a one-line change in `streamsForFilter`.
  2. Per-account drawer: `sign-in-failed` (`bad-password`, `disabled`) and `locked` rows for an existing account must carry `userId`, or they will not appear in that account's drawer. They still appear in the page-level view.
  3. Errors as `{ success: false, error: "<Vietnamese text>" }`: 403 for non-admin, 400 for a bad `kind`, `limit` or `before`. A `before` cursor whose row was purged by retention should get a clear 400 text; the UI shows it as-is.
  4. Send `nextCursor` whenever `hasMore` is true. The UI falls back to the last row's id.
  5. Security rule "actor-attributed audit for sensitive reads": consider recording that an admin read the sign-in history, since IP and user-agent are personal data.
- **Dependencies on other agents/commits:** INT's backend on `feat/login-hardening` (route, store, event writes).
- **Requested integration action/order:** merge after INT's backend route lands on `feat/login-hardening`. Then rerun the full Docker gates and check in a dev browser (not staging, not live): the per-account drawer, the page-level tab with each filter, "Tải thêm", and a non-admin refusal.
