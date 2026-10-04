# Agent handoff

## Task

- **Title:** Merge comparison dialog: compare photos before every merge of a stranger cluster into an existing employee (owner request 2026-10-04)
- **Owner/agent:** frontend agent (Claude), integration owner Hermes (INT)
- **Acceptance criteria:**
  - Every merge into an existing employee (suggestion button "Gộp vào <tên>" on the card, in the create form and in the merge form; merge-form submit after a roster search) opens a comparison dialog first. `POST /api/strangers/merge` is sent only from "Xác nhận gộp".
  - Two columns: left "Người lạ" (active/primary photo large + thumbnails, capture time, gate/camera name); right "<name> (<code>)" (registration photo, recognised face crops with time / gate label / match score, then "Khung hình đã tạo mẫu").
  - Suggestion score with strength ("Độ giống 55% - yếu") and the caution text, only when the target is the suggested employee.
  - No samples and no template frames: "Chưa có ảnh nhận diện tại cổng của nhân viên này - chỉ có ảnh đăng ký"; confirming still allowed.
  - "Xác nhận gộp" (primary) and "Hủy"; Escape and click outside cancel (not while sending); focus moves in, is trapped, returns to the opener; keyboard accessible; loading, error (server text as-is, transport failure named) and retry; a failed load does not block confirming.
  - Images open larger on click (existing `ImageZoomDialog`).
  - Merge payload and backend contract unchanged.
- **Scope explicitly excluded:** backend, `server.ts`, `src/server/**`, `src/types.ts`, shared agent context; deployment.

## Source control

- **Branch/worktree:** `feat/merge-compare-ui` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a6782b0814e473278`
- **Base SHA:** `5478e98` (tip of `feat/merge-compare`, "feat(employees): face-samples route ...")
- **Commit SHA(s):** `417af16` feat(strangers): compare photos before every merge into an existing employee; plus this handoff commit
- **Rebased/updated before handoff:** yes (base tip unchanged at `5478e98`; HEAD descends from it)

## Ownership

- **Files owned:** `src/components/StrangerClusterModal.tsx`, `src/components/MergeCompareDialog.tsx` (new), `src/utils/mergeCompare.ts` (new), `tests/mergeCompareUi.test.ts` (new), this handoff
- **Files forbidden/not touched:** `server.ts`, `src/server/**`, `src/types.ts`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`
- **`server.ts` touched:** no
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** no

## Changes

- **Files changed:**
  - `src/utils/mergeCompare.ts`: pure helpers: `readFaceSamples` (validates the face-samples body, drops non-identifier and duplicate ids, newest first, caps 8/4, builds `/api/strangers/faces/:faceId/image` and `/api/logs/:logId/image`), `faceSamplesLoadError` (HTTP refusal text as-is; status 0 named as a connection failure; 2xx without `success` is an error), captions/labels (`sampleCaptionParts`, `templateFrameCaptionParts`, `templateSourceLabel`, `suggestionStrengthLabel`, `employeeHeading`, `registrationPhotoState/Text`, `noSamplesNotice`, `compareSuggestion`).
  - `src/components/MergeCompareDialog.tsx`: `MergeCompareView` (markup, all state in props) and `MergeCompareDialog` (loads face samples through `operatorJsonFetch`, gate labels through `/api/camera-streams/config` best effort as AccessLogs does, focus management, Escape/backdrop/Tab trap, zoom). Rendered in a portal on `document.body` (z-60; zoom stays z-70 above it).
  - `src/components/StrangerClusterModal.tsx`: `compareOpen` state; `handleOpenMergeSuggestion` and the merge-form compact suggestion now open the dialog; `handleSubmitMerge` validates and opens the dialog only; the previous request body moved unchanged into `sendMerge` (called only from the dialog's confirm; on failure the existing `alert` runs and the dialog stays open); suggestion-button and submit-button titles explain the confirmation step.
  - `tests/mergeCompareUi.test.ts`: 25 tests (helpers, static render of the view via `react-dom/server`, panel wiring / unchanged payload / no mutation in the dialog).
- **Behavior changed:** merging a stranger cluster into an existing employee now needs one more click ("Xác nhận gộp") after viewing both sides. The quick-register (create) flow and dismiss are unchanged.
- **API/event contracts added or changed:** none. Consumes the existing `GET /api/employees/:id/face-samples` and the existing protected image routes.
- **Schema/migration changed:** none
- **Environment/configuration changed:** none
- **Security/privacy impact:** the dialog shows biometric images only through `ProtectedImage` (cookie session, blob URLs revoked on unmount); no `<img>` with API paths, nothing stored in local/session storage, no raw embeddings. Ids from the JSON are put into image paths only if they match a plain identifier pattern (else dropped) and are URL-encoded. The face-samples read is audited server-side (actor logged by the route). The dialog sends no mutation; the server still decides the merge.

## Verification

Image built from the worktree: `docker build --target tester -t smartface-tests:merge-ui .` (exit 0). Each run with `--cpus 2`, one at a time.

```text
command: docker run --rm --cpus 2 smartface-tests:merge-ui npx tsc --noEmit
result: exit 0

command: docker run --rm --cpus 2 smartface-tests:merge-ui npm run lint
result: exit 0 (tsc --noEmit)

command: docker run --rm --cpus 2 smartface-tests:merge-ui npm test
result: exit 0 - tests 1182, suites 247, pass 1173, fail 0, cancelled 0, skipped 9 (pre-existing self-skips)

command: docker run --rm --cpus 2 smartface-tests:merge-ui npm run build
result: exit 0 - vite client built (pre-existing >500 kB chunk warning), server/faceWorker/pipelineWorker/presenceWorker bundles built

command: docker run --rm --cpus 2 smartface-tests:merge-ui node --import tsx --test tests/mergeCompareUi.test.ts tests/accuracyUi.test.ts tests/strangerPhotosUi.test.ts tests/protectedImage.test.ts tests/blurReportUi.test.ts
result: exit 0 - 81 pass, 0 fail
```

- **Not run and why:** integration tests (`npm run test:integration`) - no backend change; the face-samples route already has `tests/integration/employeeFaceSamples.test.ts` on the base branch. No browser (interactive DOM) test runner exists in the repo; dialog behaviour is covered by a static render plus source-level wiring checks.
- **Manual verification:** not done in a browser (no dev UI run against a non-production backend in this task). Recommended on the dev stack before staging: suggestion "Gộp vào ..." opens the dialog; Hủy / Escape / outside click send nothing (network tab); roster search + "Gộp Vào Nhân Viên Này" opens it; Xác nhận gộp sends one `POST /api/strangers/merge` with the same body as before; an employee with no recent crops shows the plain notice; a 4xx from face-samples shows the server text and confirm stays enabled.

## Data and deployment

- **Forward migration:** none
- **Rollback or compensation:** revert `417af16` (frontend only).
- **Backward compatibility:** against a server without the face-samples route the dialog shows the refusal text (e.g. HTML/404 message) and the registration photo; confirming still works.
- **Data retention/deletion impact:** none (reads only; the server logs the read).
- **Deployment/restart required:** yes for the UI to change (image rebuild); not done. Per project memory: dev test first, explicit owner confirmation before staging.

## Risks and follow-up

- **Known risks:**
  - A suggestion merge opens the dialog with the placeholder target (no `photoUrl`) until the debounced roster search swaps in the record; the registration slot shows "Có ảnh đăng ký - đang lấy từ danh sách nhân viên…" meanwhile. If the search does not return that employee, the slot stays in that state (merge still possible, same as before).
  - The adopt-photo checkbox lives in the merge form; a merge confirmed straight from a suggestion button uses its current value (default off). The dialog states when it is on.
  - Strength wording for scores at or above 0.55 is "khá" (new wording); below it "yếu", matching the panel's existing weak line.
- **Unresolved questions:** owner may want different wording for the non-weak strength ("khá").
- **Dependencies on other agents/commits:** `5478e98` (face-samples route) must be integrated first or together.
- **Requested integration action/order:** merge `feat/merge-compare` then `feat/merge-compare-ui` (fast-forward on top of `5478e98`); rerun the four Docker gates on the integrated branch; dev-stack manual check above before any staging deploy.
