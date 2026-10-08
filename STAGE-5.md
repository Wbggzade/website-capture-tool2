# Stage 5 — small local frontend for the capture engine

Status: implemented in the current working checkout.

## Scope

This stage adds a lightweight local web UI that starts, monitors and controls the existing Node.js capture engine without moving discovery, checkpointing or content exploration logic into browser JavaScript.

The frontend keeps the runner on loopback, uses the real job controller and respects the existing lifecycle states (`running`, `paused`, `waiting-for-user-action`, `cancelled`, `complete`, `incomplete`). It exposes a small backend API that matches the engine's event flow instead of inventing a separate workflow.

## Frontend design

The interface is intentionally small and restrained: a single URL form, a compact status panel, a narrow set of control buttons and result links when files are available. The design is described as provisional because the final visual direction was not supplied.

Accessible behaviour is built in from the start:

- labelled input and controls
- visible focus styling
- clear validation messages
- keyboard-friendly buttons and form flow
- responsive layout for narrow screens
- no fabricated percentages while the total discoverable work remains unknown

## Backend and API

The UI is served from the local backend at `http://127.0.0.1:3000` and is intentionally bound to loopback. It exposes:

- `GET /api/health` for readiness checks
- `POST /api/jobs` to start a new capture job
- `GET /api/jobs/:id` for current job state and counts
- `GET /api/jobs/:id/events` for a server-sent event stream of job progress
- `POST /api/jobs/:id/control` for pause/resume/cancel/continue actions
- `GET /api/jobs/:id/artifacts?path=...` for validated file delivery within the run directory only

A reserved job ID is opaque to the browser and file access is constrained to the specific job run directory so arbitrary paths are rejected.

## URL validation

Frontend and backend validation both rely on the platform URL parser and explicit HTTP/HTTPS checks. Input can be normalized from a bare domain to `https://` automatically, but unsupported protocols, malformed URLs, and credentials in the URL are rejected.

The backend checks the URL again before starting the engine, and the interface distinguishes invalid syntax from a syntactically valid but unreachable site using the browser/server validation path.

## Access and resume flow

When the engine emits `user-action-required`, the UI shows the manual-access instructions and exposes a Continue action. The job does not claim completion until the engine resumes and the lifecycle is updated through the same controller and event reporting path used by the CLI.

## Startup

```powershell
npm ci
npm start
```

Then open:

`http://127.0.0.1:3000`

## Remaining considerations

- The frontend is intentionally small and local-only; it is not a public deployment.
- The UI persists the last active job ID in browser storage for reconnect after refresh, but it does not attempt to restore jobs across a process restart.
- Visual baseline comparison remains out of scope for this stage.
