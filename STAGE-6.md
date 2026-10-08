# Stage 6 — release candidate verification and preparation

Status: release candidate with local verification complete; remote GitHub Actions execution remains unverified from this environment.

## 1. Requirements-to-tests matrix

| Requirement area | Implementation evidence | Verification |
| --- | --- | --- |
| URL validation and input safety | [src/url.mjs](./src/url.mjs), [src/server.mjs](./src/server.mjs) | `node --test test/*.test.mjs` (`URL validation accepts bare domains...`) |
| Same-site scope and ordering | [src/url.mjs](./src/url.mjs), [src/discovery.mjs](./src/discovery.mjs) | `node --test test/*.test.mjs` (`scope accepts...`, `breadth-first discovery...`) |
| Discovery limits and budgets | [src/job.mjs](./src/job.mjs), [src/discovery.mjs](./src/discovery.mjs) | `node --test test/*.test.mjs` (`duration budget...`, `page and depth limits...`) |
| Readiness and access detection | [src/readiness.mjs](./src/readiness.mjs) | `node --test test/*.test.mjs` (`authentication failure...`, `generic ready pages...`) |
| Retry, cancellation and recovery | [src/job.mjs](./src/job.mjs), [src/controller.mjs](./src/controller.mjs) | `node --test test/*.test.mjs` and `node --test test/*.integration.mjs` (`retry exhaustion...`, `cancellation...`, `resume...`) |
| Manual challenge handling | [src/controller.mjs](./src/controller.mjs), [src/job.mjs](./src/job.mjs) | `node --test test/*.integration.mjs` (`expired login pauses...`, `supported CAPTCHA challenge...`) |
| Frontend job API and UI validation | [src/server.mjs](./src/server.mjs), [public/index.html](./public/index.html) | `node --test test/*.test.mjs` (`frontend serves...`, `duplicate submissions...`) |
| Artifact validation and relative file access | [src/server.mjs](./src/server.mjs) | `node --test test/*.test.mjs` (`successful captures...`) |
| Browser automation and fixture coverage | [test/browser.integration.mjs](./test/browser.integration.mjs), [test/exploration.integration.mjs](./test/exploration.integration.mjs), [test/recovery.integration.mjs](./test/recovery.integration.mjs) | `node --test test/*.integration.mjs` |
| Startup and workflow reproducibility | [README.md](./README.md), [capture.config.example.json](./capture.config.example.json) | local `npm ci`, `npm start`, CLI smoke check |

## 2. Unsupported behavior and misleading claims

The implementation remains intentionally bounded and should not be described as universal website capture or complete site mirroring. The tool does not claim:

- full-page or full-site completeness beyond configured discovery and state budgets
- automatic solution of login, MFA, or CAPTCHA flows
- support for arbitrary browser profiles or credential persistence
- publication or public deployment as a hosted service
- visual baseline comparison or pixel-perfect rendering validation

Important release notes:

- A discovered page can be `incomplete` even when a valid screenshot exists, because budgets, pending work and warnings remain visible in the report.
- A page may be `partial` because of broken images, resources, or unsupported page state; this is not equivalent to a successful capture.
- Manual access challenges intentionally pause the job and require human verification; the tool does not bypass or record the challenge answer.
- Relative artifact paths are valid only within a run directory, and browsers may only request paths through the server.

## 3. Defects fixed during this stage

1. Portable example browser configuration
   - Defect: [capture.config.example.json](./capture.config.example.json) assumed a machine-specific Edge channel even though the supported workflow installs Chromium and the CI workflow uses a portable browser path.
   - Fix: removed the explicit `msedge` channel from the example and kept the config portable by relying on the Playwright default Chromium unless a local override is intentionally configured.
   - Regression guard: added a config test to ensure no explicit browser channel is required for a normal launch config.

2. Outdated project status documentation
   - Defect: the README still described the frontend as future work even though the local UI and job API were already implemented.
   - Fix: aligned the documentation with the verified implementation and the release-candidate status.

## 4. Reproducibility evidence

Fresh-source verification steps executed locally:

```powershell
npm ci
npx playwright install chromium
npm test
node --test test/*.integration.mjs
npm start
```

Observed results:

- `npm test` passed: 45/45 tests
- `node --test test/*.integration.mjs` passed: 16/16 tests
- `npm start` served the local UI successfully at http://127.0.0.1:3000
- CLI configuration and resume flows were reviewed against the example config and the current engine behavior

The repository includes a CI workflow at [.github/workflows/test.yml](./.github/workflows/test.yml), but remote GitHub Actions execution was not run from this environment. The local equivalent of that workflow was executed directly and passed.

## 5. Compatibility evidence and fixture review

The project was validated against a controlled fixture set covering:

- ordinary linked pages and navigation
- query pagination and conventional hash routes
- nested disclosures, tabs and supported menus
- lazy loading, long pages and scrollable/virtualized regions
- broken resources and server errors
- login expiry and simulated challenge screens
- interrupted jobs and recovery

Additional smoke checks used the real browser and local fixtures, not private or personal accounts. External smoke tests are intentionally scoped to suitable public targets with bounded settings; they are not a claim of universal support.

## 6. Artifact inspection

Representative generated outputs from local capture runs were inspected for:

- valid relative artifact references
- consistent ordering of page and state results
- incomplete-run labeling when budgets or warnings prevented completion
- absence of duplicated evidence caused by retried or resumed work
- screenshot/PDF generation only when the underlying capture data was usable

The private checkpoint file remains separate from the shareable manifest and is intentionally not treated as public output. Generated captures were removed from the source tree to keep the release candidate source-only.

## 7. CI and release hygiene

The project-level CI file is present and was reviewed for correctness:

- [./.github/workflows/test.yml](./.github/workflows/test.yml)

It validates the expected unit and browser coverage on Node 22 and uses the browser installation step required by the Playwright-based tests. The local equivalent was executed successfully, but remote execution remains unverified in this environment.

Source-only release hygiene steps applied:

- generated capture output directories were excluded and cleaned from the working tree
- dependencies remain local installs rather than committed source files
- private checkpoints and captured content are not treated as publishable release assets
- required dependency notices remain in the project files and lockfile
- no personal credentials, session state, or private account data were included in generated reports or documentation

## 8. Unresolved issues and readiness assessment

Unresolved issues remain deliberately documented and bounded:

- no remote CI verification from GitHub Actions in this environment
- the capture engine is heuristic and bounded, not a universal website crawler
- neither the frontend nor the engine claims visual parity or pixel-perfect baselines
- manual user access remains required for login/MFA/CAPTCHA flows
- long or stateful sites may remain incomplete by design when budgets or access controls are reached

Readiness assessment:

- Ready for local source review and controlled validation: yes
- Ready for public deployment: no
- Ready for automated release publication without explicit review: no
- Ready for local engineering use under bounded, permitted targets: yes

## 9. Release candidate checklist

- [x] Requirements reviewed against implementation and test coverage
- [x] Unsupported behavior documented clearly
- [x] Browser configuration made reproducible from a fresh install
- [x] Docs updated to reflect implemented Stage 5 frontend and Stage 6 verification
- [x] Unit and browser/integration tests run successfully locally
- [x] CI workflow reviewed and equivalent local checks executed
- [x] Generated captured content excluded from source-only package
- [x] Public release hygiene and known limitations documented
- [ ] Remote GitHub Actions verification (pending external access)
