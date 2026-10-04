# Agent handoff

## Task

- **Title:** Stranger merge refused face templates with `template-cap` because camera-adaptation templates were counted; the refusal reason was not shown
- **Owner/agent:** Hermes (integration owner)
- **Acceptance criteria:**
  - The merge enrolment check counts only templates that take a FACE_TEMPLATE_MAX slot (not `adaptation`), the same rule `enforceTemplateCap` already used.
  - A full employee (12) still takes a photo better than their worst template; the worst is evicted after the commit. A photo no better than all 12 is refused as `template-cap`.
  - Every refusal code has operator-readable words (toast, bell notification), and the server logs the refusal.
  - When the person is already recognised, the toast and notification no longer say "enrollment thất bại" / "quyền mở cửa chưa được kích hoạt".
- **Scope explicitly excluded:** adaptation policy (per-camera cap), quick-register path behaviour (a new employee has no templates), schema.

## Source control

- **Branch/worktree:** `fix/template-cap` / `.claude/worktrees/template-cap`
- **Base SHA:** 31e7e35
- **Commit SHA(s):** see `git log 31e7e35..fix/template-cap`
- **Rebased/updated before handoff:** yes (base = current main)

## Ownership

- **Files owned:** `server.ts`, `src/server/templateCap.ts` (new), `src/utils/templateReject.ts` (new), `src/components/StrangerClusterModal.tsx`, `tests/templateCap.test.ts` (new), `tests/shadowResults.test.ts`, `tests/integration/strangers.test.ts`, this handoff
- **Files forbidden/not touched:** `src/server/db.ts`, `src/types.ts`, schema
- **`server.ts` touched:** yes
- **Other hotspot touched:** no

## Changes

- **Evidence (live, read-only, 2026-10-04):** ÁNH OB's three merges today were stored with `enrollmentRejected = template-cap`; she has 8 slot-taking templates (7 merge, 1 enrollment) + 5 adaptation = 13. Since 2026-09-29, 146 merges were refused `template-cap`.
- **Behavior changed:**
  - `prepareTemplateFromImage` no longer refuses on the total count; after the face/quality checks it asks `templateCapRefuses(existing, quality, FACE_TEMPLATE_MAX)`.
  - `/api/strangers/merge` runs `enforceTemplateCap(target.id)` after a commit that added a template, then settles the deletes.
  - Notification title/body/type depend on whether a template was made and whether the employee is recognition-ready; the reason comes from `templateRejectReason`.
  - Toast: template made / repeated request / already recognised (no new template, reason) / not recognised (unchanged wording, reason).
- **API/event contracts added or changed:** merge response gains `faceTemplateEvicted: string[]` (additive).
- **Schema/migration changed:** no
- **Environment/configuration changed:** no
- **Security/privacy impact:** none on access decisions; templates stay capped at FACE_TEMPLATE_MAX slot-taking + per-camera adaptation cap. History stays append-only.

## Verification

```text
command: docker build --target tester -t smartface-tests:tcap . ; npm run lint ; npm test ; npm run build (in the image, --cpus 2.5)
result: lint (tsc) clean; unit 1182 pass, 0 fail; build ok
command: integration suite against a fresh gateway, SQLite and fresh postgres:18-alpine (tmpfs)
result: SQLite 377 tests, 342 pass, 0 fail, 35 skipped; PostgreSQL 18 377 tests, 372 pass, 0 fail, 5 skipped
```

- **Not run and why:** no real-face end-to-end merge on a full employee (needs biometric fixtures); covered by unit tests of the pure rule plus wiring assertions.
- **Manual verification:** live read of resolution metadata and template sources for ÁNH OB (above).

## Data and deployment

- **Forward migration:** none
- **Rollback or compensation:** redeploy the previous image; no data written differently except more templates being accepted (they remain within the cap).
- **Backward compatibility:** additive response field; older UI ignores it.
- **Data retention/deletion impact:** a merge into a full employee may now evict that employee's lowest-quality slot-taking template (same as manual enrolment already did).
- **Deployment/restart required:** yes (owner approval)

## Risks and follow-up

- **Known risks:** employees refused earlier keep their current templates; the operator can re-merge or enrol again to add one.
- **Unresolved questions:** none
- **Dependencies on other agents/commits:** none
- **Requested integration action/order:** merge to main, deploy on "deploy template-cap".
