# Agent handoff

## Task

- **Title:** Stranger group editing - split photos into their own group, take photos out of a group, undo both
- **Owner/agent:** Hermes (integration owner)
- **Acceptance criteria:**
  - Operator/admin picks photos in a group ("Sửa cụm") and chooses "Tách thành cụm mới" or "Bỏ khỏi cụm".
  - Split photos form their own group and never rejoin the old one automatically; a split group shows "Đã tách thủ công" and "Gộp lại".
  - Removed photos are hidden (DISMISS), never deleted; access history unchanged.
  - Both are append-only, actor-attributed, and undone through /api/strangers/restore (toast "Hoàn tác", or "Gộp lại").
  - Operator role + CSRF; picked photos must belong to the group on screen (membership/version); a split leaves at least one photo.
- **Scope explicitly excluded:** permanent deletion of biometric crops (retention purge unchanged); new sightings of a split person join the unsplit side (a split group does not grow).

## Source control

- **Branch/worktree:** `feat/cluster-edit` / `.claude/worktrees/cluster-edit`
- **Base SHA:** 96e5fd0
- **Commit SHA(s):** see `git log 96e5fd0..feat/cluster-edit`
- **Rebased/updated before handoff:** yes (base = current main)

## Ownership

- **Files owned:** `server.ts`, `src/server/db.ts`, `src/server/strangers.ts`, `src/server/auth.ts`, `src/components/StrangerClusterModal.tsx`, `src/utils/clusterEdit.ts` (new), `tests/clusterEdit.test.ts` (new), `tests/integration/strangerClusterEdit.test.ts` (new), this handoff
- **Files forbidden/not touched:** `src/types.ts` (the `split` field is typed locally in the modal)
- **`server.ts` touched:** yes
- **Other hotspot touched:** `src/server/db.ts` (single writer: Hermes)

## Changes

- **Behavior changed:**
  - New resolution action `SPLIT` (stranger_resolutions/events, existing text columns). `getRetiredStrangerObservationIds` ignores SPLIT; `getStrangerSplitPartitions` gives each observation its newest split.
  - `clusterStrangerObservations` only joins observations of the same split partition; a group made of one split's photos carries `split: { clusterId, observationIds }`.
  - The stranger window cache key includes the splits.
  - `restore` accepts DISMISS or SPLIT (`isRestorableResolutionAction`).
- **API/event contracts added or changed:**
  - `POST /api/strangers/clusters/:clusterId/split` and `/remove-photos` `{ clusterVersion, clusterObservationIds, selectedObservationIds, reason? }` -> `{ success, resolution, undo: { clusterId, clusterObservationIds } }`. 400 malformed/empty/split-all, 409 stale/unknown group or non-member.
  - Clusters gain optional `split`. SSE `stranger_split` (no UI consumer yet).
  - Auth rule: operator for both routes.
- **Schema/migration changed:** no (new action value in existing VARCHAR(32)/TEXT columns)
- **Environment/configuration changed:** no
- **Security/privacy impact:** no new data collected; nothing deleted; actor recorded on every edit and undo.

## Verification

```text
command: npm run lint / npm test / npm run build (smartface-tests:cedit, --cpus 2.5)
result: lint clean; unit 1205 tests, 1196 pass, 0 fail, 9 skipped; build ok
command: integration suite, fresh gateway on SQLite
result: 381 tests, 345 pass, 0 fail, 36 skipped (the synthetic-face test skips without PERSISTENCE_PG_URL)
command: integration suite, fresh gateway on postgres:18-alpine (tmpfs)
result: 381 tests, 376 pass, 0 fail, 5 skipped; "split, re-join, remove and undo" ran on synthetic faces
```

- **Not run and why:** no browser screenshot of the new controls (UI compiled and type-checked only).
- **Manual verification:** none on live data.

## Data and deployment

- **Forward migration:** none
- **Rollback or compensation:** previous image. SPLIT rows written meanwhile would be read by the old code as ordinary adjudications and HIDE those photos; undo every split ("Gộp lại") before rolling back, or restore them after.
- **Backward compatibility:** additive routes/fields.
- **Data retention/deletion impact:** none (crops still purged by retention).
- **Deployment/restart required:** yes (owner approval)

## Risks and follow-up

- **Known risks:** a split group does not take new sightings; they join the unsplit side or form a new group.
- **Unresolved questions:** none
- **Dependencies on other agents/commits:** none
- **Requested integration action/order:** merge to main, deploy on "deploy cluster-edit".
