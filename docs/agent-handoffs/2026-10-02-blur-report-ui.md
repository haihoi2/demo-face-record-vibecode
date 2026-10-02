# Agent handoff

## Task

- **Title:** Blur report UI in the stranger cluster panel. Owner request 2026-10-02: "add feature report blur to validate and optimize rather than delete"; "the blur report feature should be stored or tagged for you to review and enhance the accuracy".
- **Owner/agent:** frontend agent (blur-report-ui). Integration owner: Hermes (INT).
- **Acceptance criteria:**
  1. Per-face photos only (`photo.faceId` present) get a toggle, both on the tile and in the "Ảnh chính" detail area. The toggle reads "Báo ảnh mờ" / "Bỏ báo mờ" and uses `aria-pressed`.
     - Operators and admins see the toggle (`hasRole(useOperatorSession(), "operator")`). Viewers see only the badge.
     - Older whole-frame photos (no `faceId`) get no button and no badge.
  2. Report is `POST /api/strangers/faces/:faceId/blur-report` with body `{}`. Withdraw is `DELETE` on the same path. Both go through `operatorJsonFetch`, which handles 401, CSRF and credentials.
  3. The "Đã báo mờ" badge comes from `photo.blurReported === true`. It changes only after a confirmed 2xx `{ success: true, blurReported: boolean }` reply. A refusal or transport failure leaves it unchanged. Nothing is applied before the reply, so a failure has nothing to revert.
  4. Errors show the server's `error` text as-is (404, 400, 403). They appear in a live region with the prefix "Không lưu được báo ảnh mờ:".
  5. The copy says the photo is kept:
     - Tooltip: "Đánh dấu ảnh này là quá mờ để hiệu chỉnh bộ lọc. Ảnh không bị xóa."
     - Detail-area explainer: "Báo ảnh mờ chỉ gắn nhãn để hiệu chỉnh bộ lọc ảnh mờ; ảnh không bị xóa và không bị ẩn."
     - The success message says the same.
  6. Merge, register, dismiss and not-a-face are unchanged.
- **Scope explicitly excluded:**
  - The analysis screen. INT reads reports via `GET /api/strangers/blur-reports` (admin).
  - The note input field. The request builder already supports `{ note }` (trimmed, at most 200 characters), but the UI sends `{}`.
  - All backend routes and the store.

## Source control

- **Branch/worktree:** `feat/blur-report-ui` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a0a29c033320553e3`
- **Base SHA:** `120dfe7` (`feat/blur-report`, contract `src/server/blurReports.ts`)
- **Commit SHA(s):** `b6e62d4` (feature + tests), plus this handoff commit
- **Rebased/updated before handoff:** yes. `feat/blur-report` is still at `120dfe7`, so no rebase was needed.

## Ownership

- **Files owned:**
  - `src/components/StrangerClusterModal.tsx`
  - `src/utils/blurReports.ts` (new)
  - `tests/blurReportUi.test.ts` (new)
  - this handoff
- **Files forbidden/not touched:** `server.ts`, `src/server/**`, `src/types.ts`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`
- **`server.ts` touched:** no
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** no. Only this new handoff file was added under `docs/agent-handoffs/`, as assigned.

## Changes

- **Files changed:**
  - `src/utils/blurReports.ts`: pure helpers.
    - `canBlurReport`
    - `isBlurReported`
    - `blurReportPath`
    - `blurReportRequest`
    - `normalizeBlurNote`
    - `readBlurReportResult`
    - `applyBlurState`
    - `blurReportSuccessText`
    - the copy constants
  - `src/components/StrangerClusterModal.tsx`:
    - **Tile:** a top-right icon toggle. Its accessible name stays "Báo ảnh mờ: ảnh khuôn mặt N"; `aria-pressed` and the tooltip change with the state. The tile also shows a "Đã báo mờ" badge in the bottom overlay.
    - **"Avatar chính" badge:** moves down (`top-8`) when the toggle is present, so the two don't overlap.
    - **"Ảnh chính" detail area:** a badge, a text toggle with `aria-pressed` ("Báo ảnh mờ" / "Bỏ báo mờ" / "Đang lưu..."), and the explainer.
    - **Live region:** one always-mounted region, `#blur-report-notice`. It is `polite` for success, which clears after 4 s, and `assertive` for errors, which stay until dismissed.
    - **During a request:** the button is disabled and `aria-busy` is set.
  - `tests/blurReportUi.test.ts`: 16 tests in 5 suites.
    - The request builder, response reader and `applyBlurState` (badge state).
    - Eligibility checks.
    - Source checks: role gating, `aria-pressed`, and that the state is applied only after the reply is read and the failure early return.
- **Behavior changed:** only what is listed above. A confirmed reply updates `photo.blurReported` in the `clusters` and `selectedCluster` state. The cluster is not reloaded and no photo or cluster is removed.
- **API/event contracts added or changed:** none. This only consumes the 120dfe7 contract.
- **Schema/migration changed:** none.
- **Environment/configuration changed:** none.
- **Security/privacy impact:**
  - Hiding the toggle from viewers only affects what is shown. The server must enforce the operator role and CSRF.
  - Nothing is stored in the browser (no localStorage, no note, no embedding).
  - Only the face id is sent.
  - A 4xx/5xx or transport failure is never treated as success.

## Verification

All commands ran in the tester image, built from this worktree at `b6e62d4` content.

```text
command: docker build --target tester -t smartface-tests:blur-ui .
result:  exit 0

command: docker run --rm --entrypoint npx smartface-tests:blur-ui tsc --noEmit
result:  exit 0

command: docker run --rm --entrypoint npm smartface-tests:blur-ui run lint
result:  exit 0

command: docker run --rm --entrypoint npm smartface-tests:blur-ui test
result:  exit 0 - tests 1068, suites 220, pass 1060, fail 0, cancelled 0, skipped 8
         (the 5 new blur-report suites, 16 tests, all ok)

command: docker run --rm --entrypoint npm smartface-tests:blur-ui run build
result:  exit 0 (vite client + server/worker/pipeline-worker bundles)
```

- **Not run and why:**
  - Integration tests (`tests/integration`): the backend routes for this contract are not on this branch, and this change is UI-only.
  - Browser/component render tests: the repo has no DOM test harness. The coverage is pure-helper tests plus source inspection, following the existing `*Ui.test.ts` pattern.
- **Manual verification:** none. No live or dev service was touched, per the task.

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** revert `b6e62d4`. No data is involved.
- **Backward compatibility:**
  - Against a server without the routes, POST/DELETE return 404. The UI then shows the server's error text (or "HTTP 404") and the badge does not change.
  - A cluster payload without `blurReported` shows no badge.
- **Data retention/deletion impact:** none from the UI. Reports are append-only labels on the server; see the contract.
- **Deployment/restart required:** yes for the change to be visible, but only after INT integrates the backend and the user approves deployment. Not deployed.

## Risks and follow-up

- **Known risks:**
  - **`src/types.ts` is missing the field.** `StrangerPhoto` has no `blurReported` field, so `isBlurReported` reads it defensively; only a literal `true` counts.
  - **Tile toggle is icon-only (`Focus` icon).** Its full meaning is in the tooltip and accessible name. The detail area has the visible text and the explainer.
  - **Visible text changes with `aria-pressed`.** In the detail area the visible label switches between "Báo ảnh mờ" and "Bỏ báo mờ" (as specified) while `aria-pressed` is also set, so a screen reader may announce "Bỏ báo mờ, pressed". The tile button avoids this with a fixed accessible name.
  - **One shared notice.** If two different faces are toggled at the same time, the notice shows the most recent reply.
- **Unresolved questions:** should operators be able to enter a note (at most 200 characters)? The helper supports it, but there is no input field yet.
- **Dependencies on other agents/commits:**
  - The backend implementation of the 120dfe7 contract: the POST/DELETE routes, `blurReported: true` on per-face photos in `GET /api/strangers/clusters`, the operator role and CSRF.
- **Requested integration action/order:**
  1. Merge the backend blur-report routes first, then this branch. The only overlap is `src/server/blurReports.ts`, which this branch does not change.
  2. `src/types.ts` owner: add `blurReported?: boolean` to `StrangerPhoto` ("per-face only; true while the newest blur-report row is `blur`"). After that, `isBlurReported` can drop its cast; behavior does not change.
  3. Backend: return `faceId` in the POST/DELETE reply, as the contract says. The UI treats a reply naming a different face as a failure. A reply without `faceId` is accepted.
  4. After integration, rerun the full gates and run a dev-only browser check before staging:
     - an operator reports and withdraws;
     - a viewer sees the badge only;
     - an unknown face returns 404 and its text is shown;
     - the photo remains in the cluster.
