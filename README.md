# Website Capture Tool

Release candidate for a local browser-capture engine with a loopback-only frontend. The project captures bounded website content with durable checkpoints, manual access handling and resumable job control while keeping discovery and browser automation in the local backend rather than in frontend JavaScript.

This repository is a source-only local utility and is not a public web service. It does not contain private course archives, personal accounts, private browsing state, or site authentication credentials. The browser is launched locally and all capture work is bounded by configuration and site scope.

## Purpose and supported scope

The tool is designed for controlled local capture of a single website or a small, in-scope subset of a site. It supports:

- explicit target URLs and bounded same-site discovery
- ordered capture of page and state results
- manual-access interruptions for login and CAPTCHA screens
- safe retries and checkpoint/resume recovery
- relative artifact output inside an isolated run directory
- a small local UI and a CLI-facing engine API

It does not guarantee universal website coverage, complete site mirroring, or automatic solving of CAPTCHAs or login flows. The tool is intentionally conservative: unknown controls are not activated, out-of-scope links are not accepted, and budgets are reported explicitly rather than hidden.

## Architecture and actual workflow

The implementation separates the engine from the UI:

- Frontend: [public/index.html](./public/index.html) and [public/styles.css](./public/styles.css)
- Local backend API: [src/server.mjs](./src/server.mjs)
- Capture and discovery engine: [src/job.mjs](./src/job.mjs), [src/discovery.mjs](./src/discovery.mjs), [src/exploration.mjs](./src/exploration.mjs)
- Controller and lifecycle: [src/controller.mjs](./src/controller.mjs)
- Checkpoints and resume: [src/checkpoint.mjs](./src/checkpoint.mjs)
- Browser automation: [src/browser.mjs](./src/browser.mjs), [src/capture.mjs](./src/capture.mjs)

The frontend starts a job, polls current state, receives structured progress events, and exposes the real lifecycle states used by the engine. The backend never invents a parallel workflow; it reflects the same job controller, manual-access pause flow, recovery checkpoints and result status model as the CLI.

## Current behavior

- Start from `startUrl` and optional additional URLs, then discover visible same-site links automatically.
- Explore in breadth-first order, with deterministic ordering and explicit limits.
- Explore supported disclosures, tabs, expandable panels and explicitly configured load-more controls; unknown and excluded controls have explicit reasons.
- Restrict targets and accepted captures to one origin and a configured path boundary.
- Preserve meaningful query parameters, fragments and trailing slashes in URL identity.
- Use visible-content readiness checks instead of course-specific words or required `main` elements.
- Reject HTTP errors, propagate readiness failures and flag recognizable access screens.
- Save a full-page PNG, verify image dimensions, and optionally assemble an image-only A4 PDF.
- Record broken or pending images as partial captures.
- Write each run into a fresh directory with relative artifact references and a manifest updated as the run progresses.
- Retry selected transient failures with bounded exponential backoff and honor `Retry-After` when it fits the configured budget.
- Keep lifecycle (`running`, `waiting-for-user-action`, `paused`, `cancelling`, `cancelled`, `complete`, `incomplete`) separate from page and state outcomes.
- Store a private versioned `checkpoint.json` beside the redacted public `manifest.json`; resume verifies artifacts and recaptures missing or corrupt evidence.
- Pause on detected login/access/CAPTCHA challenges when run through the CLI or controller API. An operator resolves them manually; the engine verifies access before retrying.
- Return a nonzero exit status for incomplete, cancelled, limited, blocked, failed or partial work, or export failures.

## Setup

Use Node.js 22 or newer. The project workflow is validated on Node 22 in CI and locally on Node 25.8.1.

```powershell
npm ci
Copy-Item capture.config.example.json capture.config.json
```

Edit `capture.config.json` to set the intended website and optional additional `urls`. Paths such as `outputDir` are resolved relative to the config file. The example is intentionally portable: it relies on the Playwright Chromium installation unless you explicitly set a different local browser channel.

```powershell
npx playwright install chromium
```

Run the local frontend on loopback:

```powershell
npm start
```

Then open http://127.0.0.1:3000 in a browser to start a capture. The frontend keeps the browser automation in the local backend and uses the existing capture engine for discovery, retries and checkpoint/recovery.

Run the CLI directly:

```powershell
npm run capture -- capture.config.json
```

Continue an interrupted or cancelled run with the same configuration:

```powershell
npm run capture -- --resume captures\<run-directory> capture.config.json
```

The CLI remains the engine’s lower-level interface; the UI is intentionally small and local-only.

`retry` defaults to 3 attempts, with a 500 ms exponential base and a 10 second maximum delay. `access` accepts generic CSS selector lists for login, denied-access and supported challenge surfaces. These are detection signals only; they do not solve CAPTCHA or enter credentials.

The engine API exports `createJobController()`, `runJob(...)` and `resumeJob(...)` from [src/controller.mjs](./src/controller.mjs) and [src/job.mjs](./src/job.mjs). A controller supports `pause()`, `resume()`, `cancel()`, `getState()` and `subscribe(listener)`. Pause and cancellation take effect at safe boundaries; an in-flight browser operation is not forcibly terminated.

## Configuration

`startUrl` is required. `urls` contains additional absolute URLs treated as depth-zero seeds; the starting URL is always captured first. Exact duplicates are removed without reordering. `scopePath` defaults to `/`; `/docs` permits `/docs`, `/docs/` and descendants, but not `/docs-other`.

## Discovery and ordering

Discovery defaults to on. Set `discovery.enabled` to `false` for explicit-URL-only capture.

The defaults are 50 pages, depth 3, 120 seconds for the crawl, 500 visible links per page, and 100 visible controls per page. Crawl time is checked between page operations. Per-page exploration also has its own deadline; pause/cancel is observed at readiness polling, scroll and state-replay boundaries. An individual browser request, image/font wait, or screenshot is allowed to finish within its own timeout.

The engine collects all visible anchors rather than stopping at the first nonempty category selector. It preserves query variants and conventional `#/route` / `#!/route` fragments. Ordinary heading fragments collapse to their document URL. Other SPA fragment conventions need future configuration. Links hidden behind supported content controls are observed when the state is opened.

The queue assigns stable IDs and parent/depth values when a URL is admitted. Repeated links and cycles are recorded without re-enqueueing. Known successfully captured redirect targets are skipped when subsequently dequeued. A redirected alias may itself still be captured when its destination was not known in advance. IDs are deterministic for the same seeds and observed DOM, not guaranteed across changing website content.

The graph records accepted, duplicate, out-of-scope, excluded-action, asset and download links. Recognizable logout, delete, checkout and similar URLs/labels are excluded. This is a conservative heuristic, not a guarantee that an arbitrary GET URL has no side effects. Forms, unknown buttons and unconfigured pagination are not activated; only supported disclosures/tabs/expanders and explicitly configured load-more controls can be explored.

Control records include their parent page, stable order, label, type, status and selector hint. Every action re-inspects the live page and checks selector uniqueness and eligibility before interaction. Controls are classified as explored, deferred, unclassified or excluded. Forms, disabled controls, destructive/unknown controls and non-opted-in pagination are not activated. Password entry and CAPTCHA completion remain manual.

## Content states and long pages

The initial page capture is retained. The engine then explores supported `<details>` disclosures, ARIA tabs, associated expandable panels, and only the load-more selectors explicitly listed in `exploration.paginationSelectors`. State jobs are processed in stable discovery order; nested states record their action path, parent state and parent page. Selector hints are revalidated during replay, state changes are checked before success, and repeated visible states are deduplicated. Unsupported or failed states remain in the report rather than being called captured.

Document scrolling and up to `exploration.maxScrollRegions` visible inner scroll regions are explored within step and duration limits. The engine waits for visible-content stability and image/font settling, re-checks access/readiness, and captures ordered viewport frames so lazy-loaded or virtualized rows that later disappear can still be represented. A verified full-page PNG is used below `maxFullPageHeight`; taller pages use an overview plus ordered viewport segments. Each artifact records its kind, order, and, for scroll frames, region/step/scroll position. PDF assembly follows result, state and artifact order. Infinite growth, removed regions, instability and missing resources are reported as partial/incomplete evidence, not completeness.

Links observed while scrolling or replaying a state are merged into the existing breadth-first discovery queue. A bounded capture does not imply that every lazy item or page on a site was found.

Reaching any discovery budget marks the result incomplete. Pending queued pages and omitted-link reasons remain visible in the report. Link/control extraction is bounded; omitted candidates cannot all be enumerated after the extraction limit. Reports include observed totals so truncation is explicit.

`readinessSelector` defaults to `body`. For dynamic sites, choose a CSS selector that identifies loaded content rather than a loading placeholder. Stability checks do not prove that every application request has finished.

`timeoutMs` controls navigation/readiness/screenshot timeouts individually; `imageTimeoutMs` bounds the image/font wait. PNG capture is required. Conflicting or old configuration fields are rejected instead of silently ignored.

Fresh launched sessions use a controlled viewport, English locale, UTC timezone and light theme. Attached sessions inherit the browser's environment; only the new capture tab's viewport is set.

## Manual authentication

You can retain an already-authorized session by attaching to a dedicated browser launched with a local debugging port and a separate profile. Finish login yourself before starting the capture. Do not use your ordinary personal browser profile.

Replace the `browser` section with:

```json
{ "mode": "attach", "endpoint": "http://127.0.0.1:9222" }
```

The tool creates its own tab in the first available context, closes that tab after the run, and disconnects its attachment. It does not export cookies or automate credentials. In launch mode, it owns and closes the browser.

Detected login, access-denied and supported challenge surfaces pause an active job for manual resolution in the dedicated browser. After Continue/Enter, the engine verifies scope, configured access signals and readiness; if those checks still fail, it remains waiting. Complete credentials, MFA and CAPTCHA manually. The engine does not record challenge input, solve challenges, or bypass access controls. Redirected pages outside configured scope cannot be accepted as captures; request routing is not a network-isolation guarantee.

## Outputs and outcomes

```text
captures/<timestamp>-<unique-id>/
  manifest.json
  checkpoint.json             # private; do not share
  screenshots/0001.png
  screenshots/0002.png
  archive.pdf                 # when enabled and usable captures exist
```

Page outcomes are `captured`, `partial`, `failed`, `blocked`, `skipped` (known redirect duplicates), and `limited` (for example, a Retry-After delay beyond the configured maximum). Explored states have their own outcomes and action paths. Job lifecycle is separate: `running`, `waiting-for-user-action`, `paused`, `cancelling`, `cancelled`, `complete`, or `incomplete`. Item failures normally leave other queued work eligible to continue; manual access challenges wait for verified resolution; exhausted time/page/state/retry budgets and export failures make the job incomplete; cancellation stops new work and preserves evidence already captured.

`complete` means all admitted pages were captured or deduplicated, export succeeded, no configured exploration limit was reached, and no deferred/unclassified controls remain. It does not prove that an entire website was explored: this bounded crawl only reports observed pages/states. It does not cover every frame, shadow root, asynchronous update, infinite feed item or site. A discovery failure preserves verified screenshot evidence as partial.

Manifest version 4 is shareable progress metadata: it includes ordered graph/results, lifecycle, item/state outcome counts, attempts, events, limits, pending work and unexplored-control counts. Query/hash variants receive opaque URL IDs so they remain distinguishable although displayed values are redacted. The separate `checkpoint.json` is private and includes raw queue/configuration state required for faithful resume; it is not encrypted. Keep the whole run directory private and do not publish or commit checkpoints. Do not put credentials in configuration or URLs.

Reports omit query values and fragments and do not serialize raw browser exception strings. Screenshot pixels and URL paths can still contain private content: inspect results before sharing. Capture only content you are authorized to access and publish; attribution and redistribution permissions are separate from access.

The PDF preserves the original image-slicing approach. It is not searchable text; fixed page boundaries can cut text or code. Generated outputs are ignored by Git.

## Verification

```powershell
npm test
$env:CAPTURE_TEST_CHANNEL = 'msedge'
npm run test:browser
```

For bundled Chromium, leave `CAPTURE_TEST_CHANNEL` unset and install Chromium first. Browser tests use owned local HTTP fixtures, not external sites or personal accounts. They cover capture failures and export, navigation order, query/hash routes, redirected aliases, supported controls, bounded scrolling, retries, manual login resolution, challenge detection, cancellation and resume.

Final local verification for the reconciled Stage 3/4 implementation: 40 unit/job tests and 16 Edge browser integration tests passed on Node 25.8.1. One additional focused browser run was retained for visual inspection of page/state screenshots and the image-only PDF. Remote GitHub Actions/Node 22/Chromium CI has not been run.

GitHub Actions runs unit/job tests and the local fixture browser checks on Node 22 and Chromium. The workflow is configured; no GitHub run has occurred yet.

## Boundaries and release status

1. **Foundation — implemented:** modules, validation, explicit captures, regression tests and CI configuration.
2. **Discovery — implemented:** same-site queue, page/control inventory, limits, deterministic ordering and loop prevention.
3. **Exploration — implemented:** supported content states, bounded scrolling, ordered viewport evidence and explicit pagination. See [STAGE-3.md](./STAGE-3.md).
4. **Execution/recovery — implemented:** safe-boundary controls, bounded retries, private checkpoints, resume, manual access recovery and structured reports. See [STAGE-4.md](./STAGE-4.md).
5. **Frontend — implemented:** loopback-only local UI, progress and lifecycle reporting, result links and safe artifact access. See [STAGE-5.md](./STAGE-5.md).
6. **Release verification — implemented locally:** compatibility checks, regression updates and release documentation. See [STAGE-6.md](./STAGE-6.md).

This is a release candidate, not a production-ready or public-facing deployment. Visual comparisons remain deferred. Only the listed revalidated content controls are interacted with. No complete/infinite-page guarantee is made. This is a local tool, not a hardened public URL-fetching service; subresource requests are not an SSRF security boundary.

## QA case study

A real defect surfaced during release verification: the example browser config assumed a Windows-specific `msedge` channel even though the project workflow installs Chromium and its local tests run cross-platform. That made a fresh source copy appear to require a browser that many setups do not have. The fix was to make the example configuration portable and add a regression test that validates the browser launch config without an explicit channel. This keeps the project reproducible from a clean `npm ci` install and ensures future config changes do not silently reintroduce a machine-specific assumption.

Another release-risk issue was outdated documentation: the README still described the frontend as future work even though the stage was already implemented. That wording was corrected to describe the actual loopback UI and release-candidate status, and the project documentation was aligned with verified behavior rather than aspirational plan text.

## CV-ready project description

Local website capture and reporting engine for bounded browser-based content collection. Built with Node.js and Playwright to validate page readiness, discover same-site navigation, replay supported content states, handle manual access pauses, resume interrupted jobs from private checkpoints, and export shareable reports with relative artifacts and explicit incomplete-status labeling. Includes a loopback-only frontend, structured lifecycle controls and regression coverage for URL validation, discovery limits, retries, cancellation/resume, access handling and artifact safety.
