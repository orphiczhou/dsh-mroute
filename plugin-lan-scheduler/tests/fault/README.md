# Scheduler fault injection

This directory contains deterministic fault injection at the
scheduler/transport boundary. It is intentionally narrower than a full
cluster chaos test: it makes crash, lost-ack, partition, stale lease,
malformed/oversized reply, concurrent tick and journal corruption repeatable
on one machine, and writes the raw journal/state files for independent audit.

## Run

```bash
node tests/fault/run.mjs
node tests/fault/check.mjs
```

`run.mjs` writes `tests/fault/artifacts/<timestamp>/` with:

- one `.journal.jsonl` and `.state.json` per scenario;
- `fault-report.json` with observed values and per-scenario pass/fail;
- a compact `tests/fault/fault-report.json` pointing at the latest run.

`check.mjs` re-implements the journal hash formula instead of importing the
scheduler's replay code, so it is an independent check of the raw artifacts.
It writes `independent-check.json` next to the run.

## Scenarios

| id | injection | expected |
|---|---|---|
| F1 | crash after `dispatch-started`, before send | restart requeues, old token invalid |
| F2 | send throws after possible delivery | retry uses a new lease token |
| F3 | two `ECONNREFUSED` | backoff/retry, then running |
| F4 | lease expiry | old token `stale-lease`, new token accepted |
| F5 | non-JSON reply | task failed, never promoted to success |
| F6 | 1 MiB+ reply | `reply-too-large`, task unchanged |
| F7 | two concurrent ticks | single-flight, one send |
| F8 | corrupt `state.json` + truncated journal tail | replay survives |

The live four-node smoke results are in `docs/02-fault-injection.md`.
