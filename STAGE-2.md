# Stage 2 — automatic discovery

> Historical Stage 2 implementation record. Its manifest-v2 and “controls deferred” details describe the Stage 2 endpoint, not the current application. Stage 3 added supported interaction/scroll exploration; Stage 4 advanced the public report and private checkpoint schemas. See [STAGE-3.md](./STAGE-3.md), [STAGE-4.md](./STAGE-4.md), and [README.md](./README.md) for current behavior.

## Implemented

- General visible-link discovery independent of course paths or category-card frameworks.
- Navigation-first, main-content-second, remaining-link order; breadth-first queue with stable numeric IDs, parent links, depth and status.
- Exact URL deduplication, preserved query variants and conventional hash-router states, ordinary heading-anchor collapse, and known redirect-target deduplication.
- Same-origin/path filtering, recognizable action-link exclusion, and asset/download/protocol filtering. All decisions appear in the graph.
- Bounded page count, depth, elapsed exploration time, links per page and controls per page. Limits produce incomplete reports rather than silently dropping work.
- Content-control inventory at this stage: tabs, details summaries, expandable controls, pagination candidates, unknown controls and excluded actions. The then-current Stage 2 build did not interact with controls.
- Stage 2's then-current manifest version 2 recorded ordered graph, opaque URL identities, pending items, limits and unexplored-state counts. The current public report is version 4 and resume state is stored separately in a private checkpoint.
- Same-document hash navigation support: a valid hash transition need not return a new HTTP document response.

## Verification

- 27 unit/job regression tests.
- Two real Edge browser integration tests, including a separate limit-constrained run.
- Local fixture verifies breadth-first ordering, links after an irrelevant card, query pagination, hash routes, cycles, redirect aliases, hidden details, excluded actions and PDF/PNG behavior.
- Real-browser testing exposed a visibility edge case: closed `details` descendants may have geometry despite not being displayed. Explicit ancestor checks keep those links deferred until a supported Stage 3 action opens the disclosure.
- Tests run locally on Node 25.8.1 and installed Edge. Node 22/Chromium CI is configured but has not run remotely.

## Boundaries

The discovery engine observes visible light-DOM links; Stage 3 can replay supported states and bounded document/inner-region scroll positions, with Stage 4 pause/cancel boundaries. Menus, frames, shadow roots and every late asynchronous update remain outside the guaranteed surface. Duration is bounded between operations and checkpoints; an in-flight browser operation is allowed to complete or time out.

Manual authentication is available through a dedicated browser attachment; Stage 4 also pauses for detected in-job access/challenge surfaces and verifies access after manual resolution. No CAPTCHA solver or visual comparison was added.

The original Desktop project and earlier source archives remain unchanged. Stage 5's frontend is not implemented.
