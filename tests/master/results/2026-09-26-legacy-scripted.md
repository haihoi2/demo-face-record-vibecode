### legacy (2026-09-26T20:15:38.855Z)

| Run | Gate | Persons | Latency p50 / p95 | Missed | Logs/person/passage | Exactly-1-log | False accepts | False rejects | Phantom logs |
|---|---|---|---|---|---|---|---|---|---|
| legacy | ENTRY | 36 | 5.05 s / 5.52 s | 88.9% (32) | 0.08 | 11.1% | 0 | 1 | 0 |
| legacy | EXIT | 36 | 3.10 s / 4.58 s | 77.8% (28) | 0.26 | 22.2% | 0 | 2 | 0 |
| legacy | ALL | 72 | 3.76 s / 5.52 s | 83.3% (60) | 0.17 | 16.7% | 0 | 3 | 0 |

| CPU phase | mean cores | p95 cores | samples |
|---|---|---|---|
| off | 0.01 | 0.03 | 21 |
| idle | 0.6 | 1.43 | 44 |
| busy | 0.5 | 1.52 | 491 |

| Gate | looks | failed | look start-to-start p50 / p95 | frame grab p50 | scan duration p50 |
|---|---|---|---|---|---|
| ENTRY | 141 | 3 | 8.04 s / 9.66 s | 3.91 s | 5.03 s |
| EXIT | 182 | 4 | 5.95 s / 7.01 s | 2.15 s | 2.93 s |
