# Plan: one stranger record per face (step 1)

Status: PROPOSED 2026-09-29. Needs the owner's decisions in section 7 before any code is written.

## 1. Problem

Owner, on a gate frame with two strangers: "what happen if multi face in the same frame, can we separate to merge face with other image?"

Today the old engine (and the live gates run on it) writes **one DENIED access log per frame**. That log carries:
- the whole frame as `photoSnapshot`, with a green box burned in for **every** face (`annotateSnapshotWithBoxes`, server.ts:7911);
- **one** embedding: the best-quality face (`snapshotObservation`, server.ts:4886-4910; `applyRecognitionOutcome`, server.ts:4460-4478).

The face box is used only by the size filter and is never saved. Stranger grouping works per log (`clusterStrangerFaces`, src/server/strangers.ts:100-148; observation id `log:<id>`).

Consequences:
1. **Only one face per frame is grouped.** In a frame with two strangers, the second person joins no group and cannot be found again.
2. **Strangers beside an employee are not stored.** When somebody is recognised in the frame, the event is GRANTED and carries the employee's face. The unregistered companion gets only a notification (server.ts:4440).
3. **Resolving a frame is all-or-nothing.** Dismissing or merging a group retires the whole log, so the other people in that frame are retired with it.
4. **Enrolment works on the whole frame.** It is guarded since `62e162a`, which enrols only the face matching the stored embedding, but a face that has no stored embedding can never be enrolled.

## 2. Proposal

Keep **one access event per frame**: it is the immutable security fact and does not change. Add **one stranger-face record per unrecognised face** in that frame, with its own crop, box, scores and embedding. Group, resolve and enrol by face instead of by log.

The new engine (real-time pipeline) will write the same record when it goes live: one per person-track, with that person's best crop. Both engine flows then feed one stranger panel. The pipeline code already has the crop helper (src/server/pipeline/faceCrop.ts) and a `BestFrame.crop` field meant for this (contracts.ts:88-94).

## 3. Schema (additive)

New table `stranger_faces`, in PostgreSQL, SQLite and the JSON fallback, created the same way as the existing tables (`CREATE TABLE IF NOT EXISTS`, db.ts:1378-1391 / :1599-1609 / :1613-1638):

| Column | Type (PG) | Notes |
|---|---|---|
| id | VARCHAR(64) PK | `SF-<uuid>` |
| logId | VARCHAR(64) NOT NULL | The access event (DENIED, or GRANTED when an employee was in the frame) |
| faceIndex | INTEGER | Order within the frame |
| capturedAt | VARCHAR(64) | Frame time (UTC) |
| gate | VARCHAR(16) | ENTRY or EXIT |
| streamId | VARCHAR(64) | Camera stream |
| engine | VARCHAR(16) | `legacy` or `pipeline` |
| trackId | VARCHAR(64) NULL | Pipeline track, when there is one |
| box | JSONB | `[x1,y1,x2,y2]` in source pixels |
| sourceWidth / sourceHeight | INTEGER | Frame size |
| detectorScore, quality, edgeEnergy | REAL | The storage floors are applied per face |
| sizePx | INTEGER | Shorter side of the box |
| embedding | BYTEA | float32 LE, like `access_logs.faceEmbedding` |
| dims, modelTag | INTEGER, VARCHAR(128) | |
| crop | BYTEA | JPEG face crop from `faceCrop.ts` (288-384 px, about 20-40 KB). No burned-in box. |
| createdAt | VARCHAR(64) | |
| purgedAt | VARCHAR(64) NULL | Set when retention removes crop + embedding (row kept as a tombstone for audit) |

Indexes: `(capturedAt DESC, id DESC)` for keyset paging, and `(logId)`.

`stranger_resolutions` gets `faceIds JSONB NOT NULL DEFAULT '[]'` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). A resolution then retires faces (`face:<id>`), logs (`log:<id>`, today's rows), or both.

Storage estimate: about 300-400 stranger faces a day at about 30 KB is 10-15 MB/day, compared with 200-900 MB/day for whole-frame photos today.

## 4. Behaviour

**Writing (old engine, `applyRecognitionOutcome`)**
- For each **unrecognised** face in the chosen frame that passes the stranger floors (size >= 60 px, quality >= 0.25, detector >= 0.80, edge energy >= 0.16), write one `stranger_faces` row with its crop.
- The per-person stranger cooldown (`strangerCaptureDecision`) applies per face.
- The DENIED access log is written exactly as today, keeping its single embedding for compatibility.
- An unrecognised face in a GRANTED frame gets a face row linked to the GRANTED event. It is never an access decision: the door outcome is untouched.

**Grouping**
- Observations are the face rows (`face:<id>`), plus old DENIED logs that have no face rows (`log:<id>`), so history keeps working.
- Cluster id and version are computed from observation ids exactly as today.

**Panel**
- Each photo tile is the face crop (`GET /api/strangers/faces/:id/image`, viewer and up, like `/api/logs/:id/image`).
- "Xem khung hình" opens the full frame (`/api/logs/:logId/image`), or the NVR clip where recorded. This follows the owner's decision to show faces and link to the recording for context.

**Resolve / dismiss / merge / restore / retire-non-faces**
- These accept `clusterObservationIds` (`face:` and `log:` ids). `clusterLogIds` keeps working for old clients and old rows.
- Resolving one face in a two-person frame leaves the other face in its own group.

**Enrolment (quick-register / merge)**
- Uses the chosen face row: detection runs again on its **crop** (one face), matched against the row's embedding (`chooseEnrolFaces`).
- The whole frame is never used for a face that has a row.

**Lookup / deep links**
- `#strangers/<logId>` still works: it opens the group of the first face of that event.
- `#strangers/face/<faceId>` targets a single face.

**Pipeline (when live)**
- A `stranger` TrackOutcome writes one face row (`engine: pipeline`, `trackId`, crop from `BestFrame.crop`) linked to the DENIED event of that passage.

## 5. Migration, rollback, compatibility

- **Forward:** additive only. A new table and a new column with a default. No backfill (see decision 3). Old DENIED logs stay log-level observations until retention removes them.
- **Rollback to the current image:** the old code ignores `stranger_faces` and `faceIds`.
  - The panel goes back to one embedding per log.
  - Resolutions made per face have empty `logIds`, so those captures reappear as open groups after a rollback. Nothing is lost; they can be resolved again.
  - Employees and templates created in the meantime stay valid.
- **API compatibility:** additive fields and routes. Existing clients keep sending `clusterLogIds`.
- **Access history:** unchanged. Face rows are adjudication inputs; they never rewrite or replace an access event.

## 6. Security and privacy (biometric data)

- **Access:**
  - Face crops and embeddings are readable by viewer and up through the image route only. Embeddings never leave the server; `publicAccessLog`-style redaction applies to the new rows.
  - Every mutation is operator or admin, CSRF-protected, and actor-attributed through the existing resolution events.
- **Retention:** `purgedAt` plus a daily purge job that clears `crop` and `embedding` from unresolved face rows older than the retention period (decision 1). The row is kept for audit.
  - Faces that became an employee template are copied into `face_templates` and follow the employee's lifecycle.
  - Dismissed faces are purged on the same clock.
  - A legal-hold flag is out of scope until the owner asks for it.
- **Collection:** fewer bytes than today (crop vs whole frame). It also collects companions of employees (decision 2).

## 7. Owner decisions needed

1. **Retention for unresolved stranger faces** (crop + embedding): recommend **30 days**. The whole-frame photo retention decision is still open and can be set at the same time.
2. **Record strangers who walk in beside a recognised employee** (tailgating): recommend **yes**. Today they leave no record except a notification.
3. **Backfill existing photos:** recommend **no**. Old photos have boxes burned in and are whole frames; they keep working at log level.
4. **Panel shows face crops, with a link to the full frame / NVR clip:** recommend **yes**.

## 8. Work plan and gates

| # | Work | Files | Owner |
|---|---|---|---|
| 1 | Table, column, repository methods (PG, SQLite, JSON), purge job | src/server/db.ts, src/types.ts | data-migrations |
| 2 | Per-face writer with crops and per-face floors/cooldown | server.ts, src/server/strangers.ts | INT (server.ts) |
| 3 | Face-level grouping, validation, resolve/restore/retire/lookup, image route, auth rule | server.ts, src/server/strangers.ts, src/server/auth.ts | INT |
| 4 | Enrolment from the face crop | server.ts, src/server/enrolFace.ts | INT |
| 5 | Panel: crop tiles, full-frame link, observation ids | src/components/StrangerClusterModal.tsx, src/types.ts | frontend |
| 6 | Tests (below) | tests/** | security-tester |

About 2-3 days in total, in one wave, with db.ts and server.ts each owned by one writer.

Tests:
- A two-stranger frame yields two face rows and two groups. Resolving one leaves the other open.
- A stranger beside a granted employee yields a face row, and the door outcome is unchanged.
- Floors are applied per face.
- Old log-level rows still group, resolve and restore.
- Rollback: rows written by the new code are ignored safely by the old schema reader.
- Purge clears crop and embedding and keeps the row.
- Viewer, operator and admin boundaries on the new routes; no embedding appears in any response.
- PostgreSQL and SQLite parity (length limits, JSONB).

Gates: typecheck, unit, build, integration on SQLite and PostgreSQL. Then a dev demo on the harness with a two-person scripted clip, then the owner's confirmation before staging.
