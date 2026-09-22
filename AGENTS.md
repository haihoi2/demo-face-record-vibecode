# SmartFace Gate Watch — Shared Agent Context

## Product

This repository implements an on-premise facial access-control gateway and operator dashboard. It combines a React/Vite browser UI, an Express/TypeScript backend, PostgreSQL with local fallbacks, FFmpeg camera capture, SCRFD face detection, ArcFace embeddings, multi-observation fusion, access logging, SSE, webhooks, and door-controller integration.

Production traffic currently follows:

```text
Cloudflare -> OpenResty -> 192.168.6.52:8080 -> smartface-local-gateway
```

Application source is copied into the Docker image at build time. Only `./data` is mounted at `/app/data`; a Git pull does not update the running container until it is rebuilt.

## Source map

- `server.ts`: Express entry point and integration hotspot.
- `src/server/db.ts`: PostgreSQL, SQLite, and JSON persistence.
- `src/server/faceEmbedding.ts`: SCRFD/ArcFace ONNX pipeline.
- `src/server/faceFusion.ts`: gallery matching and decision fusion.
- `src/server/faceWorker*.ts`: worker execution and queueing.
- `src/server/strangers.ts`: stranger grouping logic.
- `src/App.tsx`: top-level React state and navigation.
- `src/components/**`: camera, scanner, employee, stranger, lock, and configuration UI.
- `src/utils/api.ts`: browser API helper.
- `src/utils/offlineEngine.ts`: demo/offline behavior; never treat it as a physical-security authority.
- `tests/**`: unit and integration tests.

## Security invariants

- A browser decision, local storage value, demo path, Gemini result, or synthetic/hash matcher must never authorize a physical door.
- Explicit backend recognition rejection is authoritative and must not become local success.
- Door-controller credentials and physical device commands belong backend-side.
- Do not expose raw embeddings, passwords, tokens, RTSP credentials, or credential-bearing URLs.
- Production unlock requires a healthy real ONNX engine, server-owned thresholds, a compatible template model, and an explicit access-policy decision.
- Preserve immutable access-event history. Later stranger resolution should append adjudication/provenance instead of rewriting the original security fact.
- Treat stranger images and embeddings as biometric data requiring authorization, audit, retention, and deletion controls.

## Ownership and coordination

Hermes is the integration owner unless the task explicitly names another integrator.

For each implementation wave, assign one temporary writer for each hotspot:

- `server.ts`
- `src/server/db.ts`
- `src/types.ts`
- shared context under `AGENTS.md`, `CLAUDE.md`, `.claude/**`, and `docs/agent-handoffs/**`

Every task must declare `server.ts touched: yes/no`. If `yes`, only the designated backend integrator may proceed. Other agents propose route or orchestration changes in their handoff rather than editing `server.ts`.

Agents should use narrow commits, avoid unrelated formatting/import sorting/line-ending changes, and never overwrite another agent's uncommitted work. Frontend agents consume agreed API contracts and must not add temporary backend behavior. Test agents add black-box coverage without refactoring production files unless explicitly assigned.

## Work protocol

Before editing:

1. Read this file and relevant files in `.claude/rules/`.
2. Check `git status --short --branch` and the current commit.
3. Record task scope, owned files, forbidden files, acceptance commands, and contract changes.
4. Inspect existing tests before changing behavior.

During work:

- Characterize current behavior before refactoring.
- Keep production, demo, offline, and simulation behavior explicit and separate.
- Validate input at route boundaries; keep identity matching separate from access authorization and door actuation.
- For schema changes, include migration, rollback, compatibility, and data-retention notes.
- Do not restart, deploy, mutate live production data, or rotate secrets unless the user explicitly approves that action.

Before handoff:

1. Rebase or update from the agreed base.
2. Run the applicable containerized gates.
3. Review the diff for unrelated changes and secrets.
4. Complete `docs/agent-handoffs/TEMPLATE.md`.

## Authoritative verification

The host checkout may not have `node_modules`; Docker is the reproducible gate:

```bash
docker compose --profile test build tests
docker compose --profile test run --rm tests
docker compose --profile test run --rm --entrypoint npm tests run lint
docker compose --profile test run --rm --entrypoint npm tests run build
```

Run integration tests only in an isolated test environment with non-production data and explicit database settings. Never aim mutating tests at the live PostgreSQL service.

Basic read-only health checks:

```bash
docker compose ps
curl -fsS http://192.168.6.52:8080/api/health
curl -fsS https://stg-gate-watch.vota.vn/api/health
```

## Deployment

Manual application update flow:

```bash
cd /opt/etonlab/dev/demo-face-record-vibecode
git pull --ff-only
docker compose up -d --build
```

Do not deploy merely because tests pass. Deployment requires explicit user approval, a clean reviewed commit, rollback notes, and post-deployment health verification.
