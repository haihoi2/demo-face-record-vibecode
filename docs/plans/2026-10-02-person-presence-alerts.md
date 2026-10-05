# Plan: person-presence alerts ("human exists, no face")

Status (2026-10-05): P1/P1b/P2 DONE; P3a BUILT (alerts: live mode, after hours + no face, first alert at once then one grouped message per 5 min per gate, offline notice); P3b (declarable channels, settings screen) next. Earlier: P1/P1b DONE, P2 STARTED 2026-10-03 (owner "đồng ý p2"; contract src/server/presence/contracts.ts, models YOLOX-Nano + RTMDet-tiny UNION-LOWRATE). All decisions taken 2026-10-02: 1 declarable channels (shared Eton channel for now), 2 no image in messages, 3 all hours / >= 3 s in view, 4 whole picture, 5 body pictures kept 7 days, 6 free licence only, 7 entry gate first. Nothing is built yet. Owner request: "to make sure not to miss a stranger or a thief, we also need a feature that quickly detects 'human exists' if faces cannot be detected; this should be a quicker thread and notify the other security group." Decisions needed are in section 9.

## 1. Why: what the cameras show today

- **Faces are the exception, not the rule.** In the 2026-09-29 replay of the NVR sequences, 93-96% of the people the real-time engine tracked at the entrance never yielded a usable face (back turned, bowed head, side view, too far, motion blur). At the exit the camera placement gives almost no faces at any detector size (2026-09-30 diagnostic).
- **Today, nobody without a usable face leaves a trace.** The door engine and the stranger records are built only on face detection (SCRFD). A person walking past with their back to the camera produces no event, no photo and no alert. A thief who avoids looking at the camera is exactly that case.
- **What exists to build on:**
  - Each gate already keeps one always-open camera stream (wave D). It decodes once and feeds the face engine and the door scan.
  - A motion check on the gate area.
  - Worker threads per gate.
  - The Eton chat-room webhook, with a stranger alert and cooldown/flood limits.
  - Append-only event tables.
  - The operator "label" pattern from blur reports.

## 2. What we build

A **presence detector** per gate, independent of faces:

1. It looks for **people (bodies)** in the camera picture several times a second.
2. It follows each person while they are in view (a simple tracker).
3. It links that person to whatever the face engines saw at the same time and place: a recognised employee, a stranger face, or no face.
4. When a person is in a watched zone, and no recognised employee accounts for them, it records a **presence event** with the best full-body picture. It then **alerts a separate security group** within seconds, without waiting for a face.
5. It **never opens a door** and never changes a door decision. It only records and alerts.

## 3. How it works

```
camera (one RTSP connection per gate, already open)
  -> FFmpeg split: gate-area frames (face engine) | full-picture JPEGs (door scan) | NEW small frames ~640 px, 4 fps
       -> presence worker thread (one per gate, low priority, own ONNX session)
            person detector -> tracker -> zone + duration rules
            -> link with face results (employee / stranger / none) in the same time window
            -> presence event (+ body crop) -> security-group alert (cooldown, flood cap)
```

- **Speed:** detection on a 640 px frame is far cheaper than face detection on 4K. Target from a person appearing to the alert: **2-3 seconds**, separate from the face path (the "quicker thread").
- **Model:** a CPU-friendly person detector run through **ONNX Runtime for Node.js** (1.30, the runtime that already runs the face models). None of the candidates has a Node.js library of its own; all of them run in Node.js only as ONNX. Candidates reviewed 2026-10-02 (owner list + RTMDet):

  | Model | In Node.js (via ONNX) | Licence in practice | Fit for CPU, ~4 frames/s/gate | P1 |
  |---|---|---|---|---|
  | YOLOX-Nano / Tiny (Megvii) | Easiest: official ONNX export and ONNX Runtime demo; we add NMS (as for SCRFD) | Apache-2.0, code and trained weights | Very good: lightest | **Main candidate** |
  | RTMDet-tiny (OpenMMLab) | ONNX export available | Apache-2.0 | As light as YOLOX, usually more accurate | Measure |
  | MediaPipe Object Detector: EfficientDet-Lite0 / Lite2 (Google) | No Node.js library; convert TFLite -> ONNX, built-in NMS usually does not convert, so we add NMS | Apache-2.0 | Light; Lite0 weak on small, far people | Measure |
  | RT-DETR-R18 (Baidu) | Official ONNX export, no NMS needed | Apache-2.0 **from Baidu's repository only**; the Ultralytics packaging is AGPL-3.0 - do not use it | More accurate, much heavier on CPU (~60 GFLOPs at 640 px) | Measure: accuracy vs CPU |
  | RF-DETR-Nano / Small (Roboflow) | ONNX export available | Main variants Apache-2.0; **check the licence of the exact variant** before use | DINOv2 backbone, heavier than YOLOX | Measure: accuracy vs CPU |
  | YOLO-NAS (Deci) | ONNX export possible | Code Apache-2.0, but the **pretrained weights have a separate non-commercial licence**; library largely unmaintained since Deci joined NVIDIA | — | **Excluded** |
  | Grounding DINO (IDEA) | Possible but complex (image + BERT text model) | Apache-2.0 | Hundreds of ms to seconds per image on CPU; "person" needs no text prompt | **Not for real time**; used offline to pre-label NVR footage for the evaluation set |
  | YOLOv8 / YOLO11 (Ultralytics) | — | AGPL-3.0 (commercial licence needed) | — | **Excluded** |

  The whole backend stays Node.js (owner question 2026-10-02): decoding (FFmpeg) and inference (ONNX Runtime, C++) dominate CPU whatever the host language, so a Python rewrite would not be lighter. Python is used only offline (evaluation, conversion), and as a small sidecar only if the chosen model cannot run as ONNX.
- **Linking to faces:** a face box inside the person box in the same frame, or within the track's lifetime, links them. A recognised employee closes the case; a stranger face follows the existing stranger flow and gets a link from the presence event; no face at all is the new "person without a face" case.
- **Zones and duration:** per gate, reusing the gate-area editor. Rules such as "a person in the zone for at least N seconds" and "count only tracks that pass the door line" suppress passers-by in the background. After-hours rules can be stricter (any person = alert).
- **Fail-safe:** if the detector or stream is down, the gate shows "presence detection offline", and the security group gets one "offline" notice (not silence).

## 4. Data

- New append-only table `presence_events`:
  - gate, track id, start and end time, duration, person count;
  - zone hit, face outcome (`none` / `stranger` / `employee`) with linked access-log and face ids;
  - best body crop (JPEG), alert status and time, model tag.
- Operator labels on events, same pattern as blur reports: "đúng" (real person, no face), "báo nhầm" (false alarm: shadow, reflection, forklift, poster), "người quen" (an employee). These labels are the data I use to tune thresholds and zones.
- Body crops are personal data. They get the same governance as stranger faces:
  - operator+ access with the existing image guard;
  - audit of reads;
  - retention `PRESENCE_EVENT_RETENTION_DAYS` = 7 days for crops (owner decision), the event row kept as numbers;
  - no embeddings or re-identification across days in this phase.

## 5. Notifications to the security group

- **Notification channels (owner decision 2026-10-02):** admins can declare **additional notification channels** (name, type, URL; today's type is the Eton chat-room webhook), and each alert type is routed to a channel:
  - stranger face (today's alert),
  - presence without a face,
  - presence detection offline.

  **For now every alert type uses the existing shared channel** (the current Eton chat room). Moving security alerts to their own group later is a settings change, not a code change.
  - New channels are admin-only, destination-guarded like the existing webhook (allowlist, no loopback/metadata/unintended private targets), audited, and their URLs/tokens are never shown back (masked like the door-controller token).
  - The existing webhook settings become channel "Eton (chung)" automatically, so nothing changes for current alerts.
  - A "send test" button per channel.
- **Message:** gate, time, duration, "không thấy mặt" / "người lạ" / count, and a link to the event in the dashboard (login required).
  - If the chat accepts an attached image, the crop can be attached. That's an owner decision, because it sends a person's picture outside the system.
- **Flood control:**
  - one alert per person track;
  - per-gate cooldown;
  - a max-per-minute cap with a summary ("+5 sự kiện khác");
  - de-duplication with stranger alerts for the same person.
- **Schedules:** working hours vs after hours. For example: after hours, every person; working hours, only people without a face who stay longer than N s in a restricted zone.

## 6. Interface

- **"Hiện diện" (presence) panel:** recent events per gate with body crop, time, duration and face outcome, and buttons for the three labels. Filters by gate, outcome, label and time.
- **Live indicator:** a badge in the top bar for unacknowledged events, like "Cụm Người Lạ".
- **Per-gate settings (admin):** on/off, zone, minimum duration, schedule, destination, and test alert.
- **Health:** detector state, fps and last event on the engine card.

## 7. Phases and effort

| Phase | What | Output | Effort |
|---|---|---|---|
| P0 | Owner decisions (section 9) | decisions recorded here | — |
| P1 | Model choice offline (no change to the running system): export/convert YOLOX-Nano/Tiny, RTMDet-tiny, EfficientDet-Lite0/Lite2, RT-DETR-R18, RF-DETR-Nano to ONNX; build an evaluation set from NVR footage of both gates, day and night (8-day retention window), pre-labelled with Grounding DINO and checked by hand; compare (1) recall of people - missing nobody comes first, (2) false alarms per hour, (3) ms per frame on this host's CPU under ONNX Runtime for Node.js | short report + chosen model file | 2-3 days |
| P2 | Presence worker + third stream output + tracker + linking + `presence_events` store; **shadow** (record only, no alerts) on both gates | events visible in the panel, no messages sent | 3-4 days |
| P3 | Notification channels (declare more channels, route each alert type; existing webhook migrated as "Eton (chung)"), alert rules, schedules, panel with labels, settings, health | alerts to a test channel on dev, then the shared channel | 3-4 days |
| P4 | Shadow on live for ~1 week, tune zones and durations from labels, then switch alerts on | go-live with measured false-alarm rate | 1 week elapsed |

Each phase goes through the usual gates (typecheck, lint, unit, integration on SQLite and PostgreSQL), a dev test, and your "deploy …" before staging.

Owners: face-engine agent (P1 model evaluation, detector wrapper), INT (worker, linking, server routes, alerts), data-migrations (store), frontend (panel, settings), security-tester (auth, SSRF on the new destination, crop access, flood limits).

## 8. Costs and risks

- **CPU:** a nano-size detector at 640 px and 4 fps on two gates is expected at well under one core, plus a small extra FFmpeg scale output. To be measured in P1/P2. Host: 18 vCPU, load ~10 today.
- **False alarms:** shadows, reflections on glass, posters, forklifts, people far behind the gate.
  - Mitigated by zones, minimum duration, a door-line rule, the shadow phase and labels.
  - Some will remain, so the cooldown and summary messages matter.
- **Missed people:** a thief who stays out of the camera's view can't be caught by any software. The exit camera placement already limits coverage there; this plan adds detection, not coverage.
- **Privacy:** more pictures of people are stored and sent. Retention, access control and the decision to attach images (section 9) must be set before go-live.
- **Licence:** avoid AGPL detectors unless a commercial licence is bought.

## 9. Owner decisions needed before P2

1. ~~**Destination for the security group**~~ **Decided 2026-10-02:** admins can declare more notification channels; for now all alerts use the existing shared Eton channel (section 5).
2. ~~**Send the person's picture in the message**~~ **Decided 2026-10-02: NO** - messages carry text and a login-protected link only; no image leaves the system.
3. **Decided 2026-10-02, revised 2026-10-03 after P1:** a person in view for at least 3 s is **recorded at all times**, but **messages are sent only outside working hours**; during working hours events are recorded only (visible in the panel, no message). Reason: P1 found people in view in >= 70 % of frames in 11 of 14 working clips, mostly without a visible face, so "all hours" would message the group almost continuously. Minimum time in view (owner, 2026-10-03, after P1b found a lights-off intruder in view only 2.75 s): **3 s during working hours, 1 s after hours**. Working hours (owner, 2026-10-03): **07:00-19:00 local, every day** for now (weekends not specified; configurable per gate, with a holiday/override switch). Messages go out 19:00-07:00. Original options:
   a. after hours, every person;
   b. working hours, only people without a face staying ≥ N s (default 5 s);
   c. which hours count as "after hours".
4. ~~**Zones**~~ **Decided 2026-10-02: whole picture** (no drawn zone; the 3 s rule filters passers-by).
5. ~~**Retention of body pictures**~~ **Decided 2026-10-02: 7 days** (`PRESENCE_EVENT_RETENTION_DAYS=7`; the event row stays as numbers).
6. ~~**Model licence**~~ **Decided 2026-10-02: free licence only** (Apache-2.0 models; candidate list in section 3). P1 started the same day.
7. **Decided 2026-10-02: entry gate first.** Presence detection is built and switched on for the entry gate; the exit camera stays as it is for now (it can be added as a second gate later with the same settings).
8. **Decided 2026-10-05 (owner "go with your choice", after two mornings of shadow data: 93 would-be messages, 61 of them 06:19-07:00 on 04/10, none 19:00-04:00):**
   - group alerts: per gate, the first alert at once, then at most one message per 5 minutes summarising the events meanwhile (`PRESENCE_ALERT_WINDOW_SECONDS=300`);
   - keep the 19:00-07:00 window for now; revisit after the after-hours events (especially 04:10 on 05/10) are labelled;
   - a face seen as a stranger is not alerted again (the stranger alert covers it); an event is decided 3 s after it starts (`PRESENCE_ALERT_HOLD_MS`) so a door scan a moment later still counts;
   - "offline" notice after 2 minutes without pictures on a live gate, and "online" when back (`PRESENCE_OFFLINE_AFTER_SECONDS=120`).
   Messages start only when a gate is switched to `PRESENCE_MODE_<GATE>=live`.
