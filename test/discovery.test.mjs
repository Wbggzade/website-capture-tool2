import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { classifyLink, DiscoveryQueue } from '../src/discovery.mjs';
import { runJob } from '../src/job.mjs';

const configFor = discovery => validateConfig({ startUrl: 'https://example.test/docs', scopePath: '/docs', discovery });
test('all link candidates are classified independently, including links following irrelevant cards', () => {
  const config = configFor({});
  const queue = new DiscoveryQueue(config);
  queue.observe(queue.items[0], [
    { href: 'https://outside.test/promo', label: 'Promo card' },
    { href: '/docs/lesson', label: 'Lesson' },
    { href: '/docs/lesson', label: 'Repeated lesson' },
    { href: '/docs-other', label: 'Sibling path' },
    { href: '/docs/logout', label: 'Exit' },
    { href: '/docs/x?action=delete', label: 'Action' },
    { href: '/docs/manual.pdf', label: 'PDF' },
    { href: '/docs/export', download: true },
    { href: 'mailto:user@example.test' },
    { href: '/docs?mode=normal', label: 'Mode' }
  ], config.startUrl);
  assert.deepEqual(queue.edges.map(edge => edge.reason), ['out-of-scope', 'queued', 'duplicate', 'out-of-scope', 'excluded-action', 'excluded-action', 'asset', 'download', 'unsupported-url', 'queued']);
  assert.equal(queue.items.length, 3);
});
test('breadth-first discovery retains parents and discovery order while cycles terminate', () => {
  const queue = new DiscoveryQueue(configFor({}));
  const root = queue.next();
  queue.observe(root, [{ href: '/docs/a' }, { href: '/docs/b' }], root.key);
  const a = queue.next();
  queue.observe(a, [{ href: '/docs/a/child' }, { href: '/docs' }], a.key);
  assert.equal(queue.next().key, 'https://example.test/docs/b');
  const child = queue.next();
  assert.equal(child.parentId, a.id);
  assert.equal(child.depth, 2);
  assert.equal(queue.hasNext(), false);
  assert.equal(queue.edges.at(-1).reason, 'duplicate');
});
test('query pagination and SPA hash routes survive, ordinary anchors collapse', () => {
  const queue = new DiscoveryQueue(configFor({}));
  queue.observe(queue.items[0], [{ href: '?page=1' }, { href: '?page=2' }, { href: '#/products' }, { href: '#/account' }, { href: '#heading' }], queue.items[0].key);
  assert.equal(queue.items.length, 5);
  assert.equal(queue.edges.at(-1).reason, 'same-page-anchor');
  assert.equal(classifyLink({ href: 'https://example.test/docs#heading' }, queue.items[0].key, queue.config).url, 'https://example.test/docs');
});
test('page and depth limits are enforced when enqueueing, never silently truncated', () => {
  const pages = new DiscoveryQueue(configFor({ maxPages: 2 }));
  pages.observe(pages.items[0], [{ href: '/docs/a' }, { href: '/docs/b' }], pages.items[0].key);
  assert.equal(pages.items.length, 2);
  assert.deepEqual([...pages.limits], ['max-pages']);
  const depth = new DiscoveryQueue(configFor({ maxDepth: 0 }));
  depth.observe(depth.items[0], [{ href: '/docs/a' }], depth.items[0].key);
  assert.equal(depth.items.length, 1);
  assert.deepEqual([...depth.limits], ['max-depth']);
});
test('serialized graph distinguishes redacted query URLs without exposing their values', () => {
  const queue = new DiscoveryQueue(configFor({}));
  queue.observe(queue.items[0], [{ href: '/docs?key=private-one' }, { href: '/docs?key=private-two' }], queue.items[0].key);
  const graph = queue.report();
  assert.equal(graph.pages[1].url, graph.pages[2].url);
  assert.notEqual(graph.pages[1].urlId, graph.pages[2].urlId);
  assert.equal(JSON.stringify(graph).includes('private-'), false);
});
test('invalid and unknown discovery settings are rejected', () => {
  for (const discovery of [false, { enabled: 1 }, { maxPages: 0 }, { maxDepth: -1 }, { maxDurationMs: NaN }, { maxLinksPerPage: 0 }, { maxControlsPerPage: 0 }, { madeUp: 1 }]) {
    assert.throws(() => configFor(discovery), { code: 'INVALID_CONFIG' });
  }
});

async function fixture(t, discovery = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discovery-test-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const config = validateConfig({ startUrl: 'https://example.test/docs', scopePath: '/docs', outputDir, buildPdf: false, discovery, exploration: { enabled: false } });
  let currentUrl = config.startUrl;
  const page = { url: () => currentUrl, setViewportSize: async () => {}, route: async () => {}, close: async () => {} };
  const deps = {
    openBrowser: async () => ({ context: { newPage: async () => page }, close: async () => {} }),
    capturePage: async (_page, url) => { currentUrl = url; return { status: 'captured', warnings: [] }; },
    inspectPage: async () => ({ links: currentUrl === config.startUrl ? [{ href: '/docs/a' }] : [], controls: [], totals: { links: 1, controls: 0 } })
  };
  return { config, deps };
}
test('job expands its queue, checkpoints the graph and completes finite discovery', async t => {
  const { config, deps } = await fixture(t);
  const { report, runDir } = await runJob(config, deps);
  assert.equal(report.planned, 2);
  assert.equal(report.pending, 0);
  assert.equal(report.status, 'complete');
  assert.equal(report.results[1].parentId, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'))), report);
});
test('unexplored content controls prevent claiming complete website exploration', async t => {
  const { config, deps } = await fixture(t);
  deps.inspectPage = async () => ({ links: [], controls: [{ kind: 'tab', status: 'deferred' }], totals: { links: 0, controls: 1 } });
  const { report } = await runJob(config, deps);
  assert.equal(report.unexploredControls, 1);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.results[0].controls[0].id, '1-state-1');
});
test('failed discovery preserves screenshot result as partial', async t => {
  const { config, deps } = await fixture(t);
  deps.inspectPage = async () => { throw Error('DOM unavailable'); };
  const { report } = await runJob(config, deps);
  assert.equal(report.results[0].status, 'partial');
  assert.equal(report.results[0].warnings[0].code, 'DISCOVERY_FAILED');
  assert.ok(report.results[0].screenshot);
});
test('duration budget leaves unattempted items visible instead of dropping them', async t => {
  const { config, deps } = await fixture(t, { maxDurationMs: 100 });
  let clock = 0;
  deps.now = () => clock;
  deps.inspectPage = async () => { clock = 101; return { links: [{ href: '/docs/a' }], controls: [], totals: { links: 1, controls: 0 } }; };
  const { report } = await runJob(config, deps);
  assert.equal(report.pending, 1);
  assert.deepEqual(report.graph.limits, ['max-duration']);
  assert.equal(report.exitCode, 1);
});
test('discovery truncation and page budget cannot return a complete status', async t => {
  const { config, deps } = await fixture(t, { maxPages: 1 });
  const inspect = deps.inspectPage;
  deps.inspectPage = async () => ({ ...await inspect(), truncatedLinks: true, truncatedControls: true });
  const { report } = await runJob(config, deps);
  assert.deepEqual(report.graph.limits, ['max-links-per-page', 'max-controls-per-page', 'max-pages']);
  assert.equal(report.exitCode, 1);
});
