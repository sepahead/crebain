# City CPU and storage characterization — September 27, 2026

Six installed cases completed and passed separate verification of their original files.
All 144 route deadlines and 144 export deadlines were missed.
These results characterize finite execution on one shared host. They do not qualify real-time performance.

Author: Sepehr Mahmoudian.
The [JSON summary](native-city-cpu-storage-2026-09-27.json) records exact sources, measurements, and receipt digests.
Original captures, payloads, and command records remain private local evidence.
They describe observed bytes and actions, not signatures or loaded-code attestation.

## Workload and method

The installed client and producer use commit [`194cfb98`](https://github.com/sepahead/crebain/tree/194cfb984440370692d6f62dffb19a428c785d3b).
The runtime manifest digest starts with `c4045022`.
NCP SDK source remains `c0465d40`; Prisoma transcript source remains `7a1730e4`.

Each case uses one drone, sixteen solids, two pressure sources, and 24 ticks.
Source periods are one and two ticks. The first action sets the original attitude and height references; subsequent actions hold them.
The schedule uses a fixed 120 Hz origin. It does not reset late deadlines.
Every case uses fresh run, endpoint, and generation identities.

The CPU condition adds one owned helper with five milliseconds of CPU work per 50-millisecond period.
Its active limit is 30 seconds. It waits at most 40 seconds for preparation before starting work.
Both helpers exited normally after input closure. They completed 24 and 26 periods without a missed helper period.
This bounded load does not establish host saturation.

The storage condition inserts a 20-millisecond wait before two actual Journal synchronization calls.
The selected calls record the tick-eight request and tick-sixteen response.
The measurements separate the injected wait from the subsequent `fsync` call.
This models delayed calls, not disk or kernel failure.

Minimal and detailed instrumentation use the same application workload.
Detailed counters measure named caller invocations with wall, process CPU, and thread CPU clocks.
These inclusive spans can overlap. Summing them does not give total execution cost.

## Outcomes

The table follows the frozen execution order.
Route wall time starts at each planned tick deadline, so it includes accumulated backlog.
Caller thread CPU measures the corresponding route invocation.
Each median contains only 24 observations.

| Condition | Instrumentation | Median route wall time (ms) | Median caller thread CPU (ms) | Route/export misses | Retired sampled births |
| --- | --- | ---: | ---: | --- | ---: |
| Normal | Minimal | 482.936 | 32.674 | 24 / 24 | 4 |
| CPU load | Minimal | 482.813 | 32.590 | 24 / 24 | 5 |
| Storage delay | Minimal | 511.680 | 33.081 | 24 / 24 | 4 |
| Storage delay | Detailed | 571.395 | 39.093 | 24 / 24 | 4 |
| CPU load | Detailed | 535.233 | 38.943 | 24 / 24 | 5 |
| Normal | Detailed | 547.586 | 38.738 | 24 / 24 | 4 |

All six captures completed with 316 request/response pairs each.
The reader verified 216 original payloads totaling 230,400 bytes.
The 180 comparisons against the first case preserved identical payload bytes and stable typed meanings.
Fresh wire identities differ by design.
All 26 sampled process births retired. The observer sent no signals.

The native command completed in 98.488 seconds. Separate original-file verification completed in 9.956 seconds.
The campaign retained 6,368,960 artifact bytes within its declared 384 MiB allowance.
No case was retried or replaced.

## Limits

The source controls passed 38 methods. Independent review found a synchronization-time accounting gap; the corrected reader rejects inconsistent aggregates.
The earlier helper-startup deadline defect and both repairs remain in the private audit record.

The shared host also ran unrelated work and the NCP source gate.
Six ordered short cases do not isolate instrumentation overhead or establish tail-latency statistics.
The JSON retains all ticks and the separately declared subset after tick six.
No unfavorable observation was removed from the complete result.

The counters do not cover native CPU internals, all hashing, physical copies, or allocations.
Memory bounds, physical-storage behavior, tracking quality, other platforms, and complete v1 qualification remain unestablished.
