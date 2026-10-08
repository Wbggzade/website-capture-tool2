# Stage 4 — reliable job execution and recovery

Status: implemented in the current working checkout. This record describes local implementation and verification; it does not claim remote CI.

## Execution model

`job.mjs` owns the job lifecycle and queue. `JobController` exposes safe-boundary pause/resume/cancel and structured events for the future frontend. Page/state outcomes remain separate from lifecycle outcomes. Public reports retain result order and count discovered/attempted work, attempts, pending items, each item outcome, state outcomes and reached limits.

Per-item transient retries use bounded exponential delay for navigation/readiness/browser failures and selected HTTP responses. `Retry-After` seconds/date guidance is honored within the configured backoff ceiling; excessive server delay is reported as `limited`. Access denial, invalid configuration, unsupported interactions and uncertain/state-changing actions are not blindly retried. Each attempt uses a distinct screenshot filename and records status/history.

## Checkpoint and resume

After each meaningful job/capture boundary, the engine atomically writes:

- `manifest.json`: shareable, redacted progress/report data.
- `checkpoint.json`: private versioned execution data, including exact queue keys and private config needed to validate/reconstruct the queue, result/action-path history, in-flight attempt/replay paths and verified evidence paths.

Resume rejects absent, malformed, incompatible-version or config-mismatched checkpoints. It verifies PNG artifacts before skipping completed work; missing/corrupt evidence requeues the result. A process-interrupted `running` item is explicitly marked interrupted and retried only within its attempt budget. Existing completed results retain IDs/order and are not duplicated. In-flight Stage 3 state paths are replayed from the page URL with new attempt-specific filenames, not treated as success based on stale files.

The checkpoint is not encrypted and contains raw URLs/config values; keep the run directory local/private and never include it in a public snapshot. No browser cookies, passwords, MFA codes or CAPTCHA answers are saved.

## Access, pause and cancellation

The engine detects generic configured login/denied/challenge selectors and conservative visible access markers. The CLI waits for an operator to resolve the page manually. Pressing Enter/Continue only requests a verification attempt: the tool checks scope, access signals and readiness before retrying the affected item. Challenges that remain visible continue to wait; no solver or bypass is implemented.

Pause and cancellation take effect at explicit boundaries around readiness polling, scrolling, state replay and evidence capture. The in-flight browser operation is not forcibly interrupted. Cancellation stops scheduling, closes only job-owned tabs/session connections, preserves verified files and reports pending work. An attached browser is disconnected, not closed, and unrelated tabs are not closed.

## Outcome and error policy

- `captured`: required evidence and observed work completed without a partial warning.
- `partial`: at least some evidence exists but exploration/resources/state work was incomplete.
- `failed`: item operation failed or exhausted permitted transient retries.
- `blocked`: access/scope/security rules prevented the item.
- `skipped`: known redirect target already captured.
- `limited`: server rate guidance exceeds the configured wait ceiling or another item-level configured limit applies.
- Job lifecycle is `running`, `waiting-for-user-action`, `paused`, `cancelling`, `cancelled`, `complete` or `incomplete`; it is not inferred from screenshot presence.

Retries, limits, pending work, partial evidence, blocked access and PDF failures cannot produce a complete job. “Complete” applies only to work admitted/observed within configured scope and limits; it does not assert a complete website or infinite-feed archive.

## Verification and limits

Tests use localhost fixtures, no external accounts/sites and no authentication material. The final local run passed 40 unit/job tests and 16 Edge browser integration tests on Node 25.8.1. Coverage includes transient success/exhaustion, Retry-After, browser reconnect, export failure, pause/cancel, restart, interrupted state-path replay, artifact validation, incompatible checkpoints, URL redaction, login expiry and CAPTCHA detection/manual resolution. A retained localhost fixture also verified page/state screenshots and an eight-page ordered PDF; details are in [STAGE-3.md](./STAGE-3.md).

Node 25.8.1 and installed Edge were used locally. The checked-in Node 22/Chromium GitHub Actions workflow has not been verified remotely. The checkpoint format is currently version 1; incompatible or pre-Stage-4 runs without a private checkpoint must be started as a new job, not silently upgraded.

The frontend, browser-profile/session-state persistence, hard cancellation of active browser operations, automatic CAPTCHA solving and visual baseline comparison are not part of this stage.
