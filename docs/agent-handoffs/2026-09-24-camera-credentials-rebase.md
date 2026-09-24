# Agent handoff

## Task

- **Title:** Rebase `agent/build/ci-baseline` onto the fail-closed API boundary and finish the camera-credential removal
- **Owner/agent:** Claude
- **Acceptance criteria:** the build branch replays onto the new base with conflicts resolved; no camera credentials remain in tracked source; all four gates green from the rebased branch.
- **Scope explicitly excluded:** deployment, `.env` edits on this host, rotating the camera account on the device itself.

## Source control

- **Branch/worktree:** `agent/build/ci-baseline` @ `/opt/etonlab/dev/demo-face-record-vibecode-wt/build-release-ci`
- **Base SHA before:** `14f58b3` (all of the branch's work was uncommitted)
- **New base:** `c5310e5` (tip of `agent/backend/stranger-ci-baseline`)
- **Commit SHA(s):** `8032ab9` (replayed), `2f15f5e`, `aefb264`
- **Rebased/updated before handoff:** yes — `git rebase --onto agent/backend/stranger-ci-baseline 14f58b3`

## Ownership

- **Files owned:** `Dockerfile`, `package.json`, `local-test.md`, `.env.example`, `src/components/CameraStreamConfigPage.tsx`, `src/components/CameraDashboard.tsx`, `src/server/db.ts` (RTSP default constants only), `tests/integration/streams.test.ts`, `docker-compose.yml`
- **Files forbidden/not touched:** `server.ts`
- **`server.ts` touched:** no
- **Other hotspot touched:** `src/server/db.ts` — two new constants and six default RTSP values, no behavioural change to persistence

## Changes

- **Files changed:** 8 in the replayed commit, plus 3 in the two follow-ups.
- **Behavior changed:** gate defaults are empty unless `CAMERA_ENTRY_RTSP_URL` / `CAMERA_EXIT_RTSP_URL` are set. UI presets, placeholders and the setup guide use `camera.example.invalid`. The positive multi-stream NVR integration case reads `INTEGRATION_NVR_RTSP_URLS` and skips when unset.
- **API/event contracts added or changed:** none.
- **Schema/migration changed:** none.
- **Environment/configuration changed:** `CAMERA_ENTRY_RTSP_URL`, `CAMERA_EXIT_RTSP_URL` (documented in `.env.example`, wired in `docker-compose.yml`), `INTEGRATION_NVR_RTSP_URLS` (test-only, documented in `local-test.md`).
- **Security/privacy impact:** the Hikvision viewer account and its password were committed in six places across components, defaults, docs and tests. It is now absent from tracked source. **The account itself still needs rotating on the camera — removing it from Git does not un-disclose it, and it remains in this repository's history.**

## Verification

```text
command: git grep for the committed camera account name and password
result:  no matches in tracked source

command: docker compose --profile test build tests
result:  exit 0

command: docker compose --profile test run --rm --entrypoint npm tests run typecheck
result:  exit 0, no diagnostics

command: docker compose --profile test run --rm tests
result:  exit 0 — tests 149, pass 145, fail 0, skipped 4

command: isolated gateway on :3101 + npm run test:integration
result:  exit 0 — tests 133, pass 127, fail 0, skipped 6

command: docker compose --profile test run --rm --entrypoint npm tests run build
result:  exit 0 — dist/server.cjs 381.2kb, dist/faceWorker.cjs 7.8kb
```

- **Skip count moved from 5 to 6 deliberately.** The positive NVR scan previously embedded the live NVR URLs and skipped only when the cameras were unreachable. It now skips unless `INTEGRATION_NVR_RTSP_URLS` names two streams. Export that variable to exercise it against real cameras.
- **Not run and why:** nothing against live PostgreSQL or the live gateway.

## Conflict resolution record

The replay auto-merged `docker-compose.yml`, `package.json`, `src/server/db.ts`, both camera components and `tests/integration/streams.test.ts`. One conflict, in `Dockerfile`: both branches had independently made the install unconditional `npm ci`, and only the preceding comment differed. Resolved to the base's wording; the `RUN` line was identical on both sides.

Absorbed as already-present in the new base, so the replayed commit shrank from 15 files to 8: `package-lock.json` (verified byte-identical to the committed one), the `bun.lock` deletion, both `Dockerfile` install lines, and `--test-concurrency=1`.

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** revert `aefb264`, `2f15f5e`, `8032ab9`. Existing gate configuration is stored in the database and is unaffected — the changed values are compile-time defaults for a fresh install.
- **Backward compatibility:** a fresh deployment with no `CAMERA_*_RTSP_URL` starts with unconfigured gates instead of pre-filled ones. An existing deployment keeps its stored configuration.
- **Data retention/deletion impact:** none.
- **Deployment/restart required:** yes, as part of the combined merge.

## Risks and follow-up

- **Known risks:** the camera credential is still recoverable from Git history; removing it from the working tree is not rotation. A fresh install now needs the two camera variables or the gates come up empty.
- **Unresolved questions:** whether to rewrite history or rotate the camera account — rotation is the sound answer and belongs to whoever administers the NVR.
- **Dependencies on other agents/commits:** contains `agent/backend/stranger-ci-baseline` as ancestry. Merge this branch and the other one together.
- **Requested integration action/order:** merge `agent/build/ci-baseline` into `main` as a single unit; do not merge the backend branch separately.
