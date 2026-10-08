# Stage 1 implementation record

Date: 8 October 2026.

> Historical foundation record. Stages 2–4 are now implemented in this checkout; the current CLI/report behavior and remaining work are documented in [README.md](./README.md), [STAGE-3.md](./STAGE-3.md), and [STAGE-4.md](./STAGE-4.md). The frontend remains unimplemented.

## Changed

Created a separate general-purpose source project. The original Desktop project was not edited, and its captured course material was not copied. Dependencies retain the original lockfile resolutions.

Separated configuration/URL rules, browser lifecycle, readiness checks, capture, PDF export, job reporting, and CLI orchestration. Modules have no top-level browser/file execution; the CLI is the explicit entry point.

Implemented consistent origin/path scope rules, query/hash-preserving identity, strict output-option validation, HTTP/access checks, propagated readiness timeouts, image-resource warnings, verified screenshot outputs, nonzero incomplete-run status, relative artifact references, per-run isolation and incremental manifests.

Reused the original Sharp + pdf-lib A4 image-slicing design with in-memory slices and generic filenames. Broad automatic button clicking and the course-specific discovery code were not carried into this foundation; they will be replaced by scoped discovery/exploration in the following stages.

## Verification

- 16 unit/job regression tests passed.
- Real Edge browser integration checks passed against a local fixture (six target-page scenarios), including PNG and PDF verification.
- Local Node version: 25.8.1. Node 22 is configured for CI but not executed locally.
- Original installed dependencies were copied for local testing because the sandbox denied npm cache access during offline installation. A clean `npm ci` in this sandbox was therefore not verified. The checked-in lockfile retains package versions/integrities from the source project.
- GitHub Actions workflow created; remote CI execution awaits publication.

## Remaining

Automatic discovery is Stage 2. Content interactions and long-page exploration are Stage 3. Manual authentication can be completed before capture through the attach mode; in-job login/CAPTCHA pause/resume is Stage 4. The minimal frontend comes in Stage 5. Visual comparison is deferred by user choice.
