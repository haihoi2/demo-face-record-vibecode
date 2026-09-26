#!/usr/bin/env python3
"""Pick candidate passages for NVR test-clip export from the access log (READ-ONLY).

    docker exec smartface-postgres-18 psql -U smartface_user -d smartface_db -At -F $'\\t' -c \\
      "select id, timestamp, type, status, coalesce(\\"employeeId\\",'') from access_logs \\
       where timestamp > to_char(now() at time zone 'utc' - interval '7 days', 'YYYY-MM-DD\\"T\\"HH24:MI:SS')" \\
      | tests/master/harness/select-passages.py > /data/test-clips/candidates.json

Only a SELECT is run (by the caller). Input: TSV rows id, timestamp (UTC ISO),
type, status, employeeId. Logs of one gate less than GAP_S apart form one
passage. Output: a balanced sample over gate x people-count x outcome x
day/evening, plus empty-scene moments, each with a 15-20 s export window in
UTC. Labels are WEAK: they come from the legacy system being measured.

The output names employee ids (personal data): write it only under
/data/test-clips (0700), never into the repository.
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone

GAP_S = 20          # logs closer than this belong to one passage
PRE_S = 10          # clip starts this long before the first log (legacy logs 1-5 s after the face)
MIN_LEN_S, MAX_LEN_S = 15, 20
LOCAL = timezone(timedelta(hours=7))  # Asia/Ho_Chi_Minh
MIN_AGE = timedelta(minutes=10)       # the NVR must have finished writing
PER_CELL = 2
EMPTY_CLIPS = 5
CHANNEL = {"ENTRY": "2201", "EXIT": "501"}


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def main():
    rows = []
    for line in sys.stdin:
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 5:
            continue
        log_id, ts, gate, status, emp = parts[:5]
        if gate not in CHANNEL:
            continue
        try:
            rows.append((parse(ts), gate, status, emp or None, log_id))
        except ValueError:
            continue
    now = datetime.now(timezone.utc)
    rows = [r for r in rows if now - r[0] > MIN_AGE]
    rows.sort()

    passages = []
    for gate in CHANNEL:
        cur = None
        for t, g, status, emp, log_id in (r for r in rows if r[1] == gate):
            if cur and (t - cur["last"]).total_seconds() <= GAP_S:
                cur["logs"].append((t, status, emp, log_id))
                cur["last"] = t
            else:
                cur = {"gate": gate, "first": t, "last": t, "logs": [(t, status, emp, log_id)]}
                passages.append(cur)

    def summarise(p):
        granted = sorted({emp for _, s, emp, _ in p["logs"] if s == "GRANTED" and emp})
        denied = sum(1 for _, s, _, _ in p["logs"] if s != "GRANTED")
        people = len(granted) + denied
        local_hour = p["first"].astimezone(LOCAL).hour
        start = p["first"] - timedelta(seconds=PRE_S)
        length = min(MAX_LEN_S, max(MIN_LEN_S, (p["last"] - start).total_seconds() + 5))
        return {
            "gate": p["gate"],
            "nvrChannel": CHANNEL[p["gate"]],
            "startUtc": start.strftime("%Y%m%dT%H%M%SZ"),
            "endUtc": (start + timedelta(seconds=length)).strftime("%Y%m%dT%H%M%SZ"),
            "durationS": length,
            "firstLogUtc": p["first"].isoformat(),
            "logIds": [l[3] for l in p["logs"]],
            "grantedEmployeeIds": granted,
            "deniedLogs": denied,
            "peopleWeak": people,
            "peopleBucket": "1" if people <= 1 else "2" if people == 2 else "3+",
            "outcome": "granted" if granted else "denied-only",
            "light": "day" if 7 <= local_hour < 17 else "evening" if 17 <= local_hour < 22 else "night",
            "labelQuality": "weak",
        }

    summaries = [summarise(p) for p in passages]
    random.seed(20260926)
    cells = {}
    for s in summaries:
        if s["light"] == "night":
            continue
        cells.setdefault((s["gate"], s["peopleBucket"], s["outcome"], s["light"]), []).append(s)
    picked = []
    for key in sorted(cells):
        pool = cells[key]
        random.shuffle(pool)
        picked.extend(pool[:PER_CELL])

    # Empty scenes: daytime moments with no log at that gate for +-2 min.
    empties = []
    by_gate = {g: [r[0] for r in rows if r[1] == g] for g in CHANNEL}
    for gate, times in by_gate.items():
        for a, b in zip(times, times[1:]):
            if (b - a).total_seconds() > 600 and 7 <= a.astimezone(LOCAL).hour < 17:
                start = a + timedelta(minutes=3)
                empties.append({
                    "gate": gate, "nvrChannel": CHANNEL[gate],
                    "startUtc": start.strftime("%Y%m%dT%H%M%SZ"),
                    "endUtc": (start + timedelta(seconds=MIN_LEN_S)).strftime("%Y%m%dT%H%M%SZ"),
                    "durationS": MIN_LEN_S, "peopleWeak": 0, "peopleBucket": "0", "outcome": "empty",
                    "light": "day", "labelQuality": "weak", "logIds": [], "grantedEmployeeIds": [], "deniedLogs": 0,
                })
    random.shuffle(empties)
    picked.extend(empties[:EMPTY_CLIPS])

    counts = {}
    for s in picked:
        k = f'{s["gate"]}/{s["peopleBucket"]}/{s["outcome"]}/{s["light"]}'
        counts[k] = counts.get(k, 0) + 1
    json.dump({
        "generatedAt": now.isoformat(),
        "source": "access_logs (read-only), weak labels",
        "passagesSeen": len(summaries),
        "counts": counts,
        "candidates": picked,
    }, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
