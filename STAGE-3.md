# Stage 3 — content exploration and ordered capture

Status: implemented and reconciled with the current Stage 4 job/checkpoint APIs.

## Workflow

1. `runJob` opens one job-owned tab, checks the requested URL through `capturePage`, and records the initial page capture.
2. `captureSnapshot` waits for stable visible content, checks access/readiness, discovers visible scrollable regions, scrolls the document and bounded inner regions, and retains ordered viewport screenshots and DOM/link observations.
3. `combineInspections` merges observations without dropping distinct links or controls. `exploreContent` revalidates each supported control immediately before acting, replays its ancestor path from the target URL, verifies the associated state, and captures additional states in stable queue order.
4. Links found while scrolling and in revealed states are added to the existing breadth-first `DiscoveryQueue`; origin/path scope, query/hash identity, deduplication, parent IDs and page/depth/time budgets remain authoritative.
5. `job.mjs` persists the result and graph through the Stage 4 atomic manifest/private-checkpoint path. `export.mjs` assembles a PDF in page-result, state and artifact order.

## Supported controls and safety

- Native closed `<details>` disclosures are opened through their `open` property.
- Tabs and expandable controls require associated panels and expected ARIA state changes; the panel must become visible.
- Load-more/pagination is attempted only when the selector is explicitly configured in `exploration.paginationSelectors`. Repeated activation is bounded by state/time limits and must reveal new text.
- Controls are re-inspected before interaction; selector ambiguity, changed controls and unexpected navigation are failures/blocks.
- Unknown, disabled, excluded, form-submission and destructive controls are not activated. During exploration, non-read requests are aborted and popups are closed and reported.
- State records contain the action path, `parentPageId` and `parentStateId`. Repeated visible state fingerprints are observed/skipped instead of recaptured. Replay always starts from the page URL and reapplies only the recorded supported path.

## Scroll evidence and outcomes

The primary PNG is a full-page image when the measured document height is within `maxFullPageHeight`. For taller pages, the primary image is an overview and ordered viewport frames record kind, region, step, scroll position and measured region height. Scroll-region count, steps, content-settle time, image/font settling, page duration and screenshot operations are bounded.

Links observed during scroll steps are retained for discovery even if the DOM later removes or virtualizes those rows. If scrolling fails after a verified viewport, the first verified frame is preserved as a recovered overview and the page is marked partial. Removed regions, unstable content, resource timeouts/broken images, scroll-step/region limits and cancellation are explicit warnings/incomplete outcomes. A successful screenshot is not a claim that all page states or infinite content were explored.

## Stage 4 integration

`runJob` passes its controller, checkpoint callback and per-page deadline through navigation/readiness, scroll settling, resource waits, state replay and screenshot capture. Pause/cancel is observed between bounded browser operations; an in-flight navigation, resource wait or screenshot is allowed to finish or time out. Checkpoints retain the in-flight phase, action path, state progress and verified evidence paths. A graceful cancellation during exploration preserves completed evidence and discovery observations, returns a partial item, and queues it for safe replay on resume using a fresh attempt filename. A process interruption records the interrupted path and replays from the page URL; old files are never treated as fresh evidence.

Access/login/challenge errors propagate to the existing Stage 4 manual-resolution flow. Progress is saved before waiting; resumption requires scope, access-signal and readiness verification. Unresolved access remains waiting/cancelled/blocked, never captured.

## Verification

Automated fixtures cover nested disclosures and revealed links, working/no-op tabs, excluded POST actions, explicitly configured load-more, infinite growth, document/inner virtualized scrolling, removed scroll regions, manual authentication and challenge detection, cancellation/pause at scroll boundaries, and resumed nested action paths. The complete locally executed test totals are recorded in [STAGE-4.md](./STAGE-4.md); remote CI is not claimed as run.

Final local verification passed 40 unit/job tests and 16 Edge browser integration tests on Node 25.8.1. An additional retained localhost fixture run was used to inspect the collapsed page, nested-state screenshot and image-only PDF. The PDF contains eight A4 pages in the report's result/state order; tests also verify artifact order, page/state order, output dimensions and PDF page count. No remote CI run is claimed.

## Remaining limitations

- Only visible light-DOM controls/links are inspected. Menus, frames, shadow roots, canvas-only content and arbitrary script-driven widgets are not automatically explored.
- Readiness and stability are heuristics; a quiet DOM does not prove that all network or application work is complete.
- Virtualized content is observed only at sampled scroll positions and within configured limits. Infinite content is intentionally bounded.
- Image-only A4 PDF slicing is not searchable and can split text. It follows the report order but does not provide semantic page layout.
- The Stage 5 frontend and visual baseline comparison are not implemented.
