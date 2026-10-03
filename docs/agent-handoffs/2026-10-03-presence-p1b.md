# Agent handoff

## Task

- **Title:** Presence alerts P1b: combine YOLOX-Nano and RTMDet-tiny; night recall.
- **Owner/agent:** face-engine agent. Integration owner: Hermes (INT).
- **Acceptance criteria:**
  - Combinations measured from the saved detections, with no new inference: UNION, CASCADE-A at 0.5 and 1 fps, CASCADE-B. For each: recall at 3 s and 1 s, false alarms, CPU.
  - One design recommended, with numbers, plus the per-gate CPU budget at 2 fps.
  - Night recall measured on INT's two lights-off entry clips.
  - The report's P1b section updated and pushed.
- **Scope explicitly excluded:** production code, deploy, live containers, NVR access.

## Source control

- **Branch/worktree:** `eval/presence-p1` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a87784e1f9ac10216`.
- **Base SHA:** `494ba25` (origin/main).
- **Commit SHA(s):** see `git log 494ba25..` (tools, then report and handoff).
- **Rebased/updated before handoff:** yes. Fast-forward only, pushed to origin main.

## Ownership

- **Files owned:**
  - `tools/presence-eval/combine.py` (new);
  - `tools/presence-eval/{extract_frames.py,pool_labels.py,README.md}`;
  - `docs/plans/2026-10-02-presence-p1-report.md` (new section 0, corrected NVR time note in section 8);
  - this file.
- **Files forbidden/not touched:** `server.ts`, `src/**`, `tests/**`, `package*.json`, `Dockerfile`, the plan file, `AGENTS.md`, `CLAUDE.md`, `.claude/**`.
- **`server.ts` touched:** no.
- **Other hotspot touched:** no. Only this new handoff file.

## Changes

- **Behavior changed:** none in the product.
  - `extract_frames.py --add` merges new clips into the manifest without re-extracting the old ones.
  - `pool_labels.py --clips` pools and reviews selected clips only.
  - `combine.py` re-scores combinations of two models from saved detections.
- **API/event contracts:** none. The P2 proposal stands: the `[1,N,5]` detector contract, with RTMDet in its own asynchronous worker.
- **Schema/migration/environment:** none.
- **Security/privacy:**
  - Footage stayed under `/data/test-clips` (mode 0700).
  - New frames (night clips), crops and contact sheets were deleted at the end.
  - Kept: label JSON (empty ground truth for the two night clips) and the detection runs.

## Verification

```text
command: docker run --rm --cpus 2.5 -v <worktree>/tools:/app/tools:ro presence-p1-tester nice -n 19 npm run lint
result: exit 0
command: python3 tools/presence-eval/combine.py --work /data/test-clips/presence-p1
result: tables in report section 0 (21 day/evening clips, 8.2 min; 2 night clips, 5.0 min)
```

- **Not run and why:**
  - `npm test` and `npm run build`: no change to `src/`, `tests/`, or any TypeScript file since the P1 gates (only Python, docs and the README).
  - Night recall: the clips contain no person (see risks).
- **Manual verification:** I checked by eye that nobody is in the two night clips: full-resolution crops, plus a motion-difference curve against a positive control, plus Grounding DINO.

## Data and deployment

- **Forward migration / rollback:** none / revert the commits (tools and docs only).
- **Data retention:** the new runs were merged into the existing `runs/*__entry`, and the night clips' ground truth was added to `labels/gt.json`. Delete everything with the clips (2026-10-27).
- **Deployment/restart required:** no.

## Risks and follow-up

- **Known risks:**
  - **Night recall is still unmeasured.** The "night" clips were exported 7 h off: the camera's clock and NVR export times are local time (UTC+7), not UTC.
  - **Thin night margin.** RTMDet 960's highest night score (a cabinet object by the IR lamp) is 0.27, against its 0.30 threshold.
- **Process notes (own mistakes, corrected):**
  - The P1 cleanup removed the docker images, so the first night runs failed with exit 125. I rebuilt the images from cache.
  - For a few minutes two heavy jobs overlapped (the end of an RTMDet 1280 run and Grounding DINO, about 5 CPUs). That breached the 2.5-CPU cap. Nothing else ran in parallel afterwards.
- **Unresolved questions:**
  - Re-export the night windows in local time: ENTRY 2201, 2026-10-03 05:07:00-05:08:30 and 05:20:50-05:24:20.
  - Confirm that the face-engine log times are true UTC.
- **Requested integration action:**
  1. P2: build UNION-LOWRATE (YOLOX-Nano 960 @0.55 at 2 fps, plus RTMDet-tiny 960 @0.30 at 0.5 fps, asynchronous, union, 2 s tracker bridging), at about 0.7 core per gate.
  2. Re-export the night windows, then I re-run night recall with `combine.py`.

## Addendum 2026-10-03 (night recall on INT's re-export)

- **Data:**
  - INT re-exported in camera local time: `entry-2201-local-20261003T050700Z.mp4` (IR, then dawn colour, then lamps on) and `entry-2201-local-20261003T052050Z.mp4` (lit).
  - INT confirmed the time base: the NVR and the camera clock use local time; face-engine logs are true UTC.
- **Method:**
  - frames extracted with `extract_frames.py --add`;
  - YOLOX-Nano and RTMDet-tiny run on all inputs (2.5 CPUs, nice 19, one job at a time) and merged into the entry runs;
  - Grounding DINO at 0.5 fps (05:07 clip) and 0.25 fps (05:20 clip);
  - pooled with `pool_labels.py --clips`; 11 corrections by eye plus 14 anchored boxes extending the IR walker (frames 105-110);
  - the IR walker's 5 fragment tracks merged into one (recorded under `patches` in `labels/gt.json`);
  - lighting phases in `labels/light-segments.json`; `combine.py` scores each phase on its own.
- **Result:**
  - One person in IR, in view 2.75 s: no 3 s alert is possible under the decided rule.
  - Detected for at least 1 s by RTMDet-tiny 960, UNION and UNION-LOWRATE; YOLOX-Nano 960 alone saw him under 1 s at 2 fps (scores 0.71, 0.57 and 0.63 at 4 fps).
  - Dawn (lamps off, colour): 1/1 for every design.
  - Early morning, lit: UNION-LOWRATE 8/11 and 6/6 walking through, RTMDet 7/11, YOLOX 6/11.
  - No false alarms anywhere.
- **Recommendation unchanged:** UNION-LOWRATE.
- **Still open:** a real night recall rate. Only one lights-off person exists so far.
- **Changed files:**
  - `tools/presence-eval/combine.py` (light segments);
  - `tools/presence-eval/README.md`;
  - `docs/plans/2026-10-02-presence-p1-report.md` (section 0 night recall; P1 sections 4, 5 and 8 night lines);
  - this file.
- **Verification:** `combine.py` at 2 fps and 4 fps (tables in report section 0). No TypeScript changed, so the gates were not re-run.
- **Not pushed** (push is blocked for this agent); INT pushes.
