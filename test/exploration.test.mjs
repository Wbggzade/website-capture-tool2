import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { actionFor, combineInspections } from '../src/exploration.mjs';

const config = validateConfig({ startUrl: 'https://example.test' });
test('only supported content controls with sufficient semantics receive actions', () => {
  assert.equal(actionFor({ kind: 'disclosure', open: false }, config).action, 'open-details');
  assert.equal(actionFor({ kind: 'tab', panelId: 'panel', panelExists: true, selected: 'false' }, config).action, 'select-tab');
  assert.equal(actionFor({ kind: 'expandable', panelId: 'panel', panelExists: true, expanded: 'false' }, config).action, 'expand');
  assert.equal(actionFor({ kind: 'tab' }, config).status, 'unclassified');
  assert.equal(actionFor({ kind: 'unknown' }, config).status, 'unclassified');
  assert.equal(actionFor({ kind: 'pagination', selector: '#more' }, config).status, 'unclassified');
});
test('explicit pagination opt-in never overrides exclusions, disabled or form controls', () => {
  const configured = validateConfig({ startUrl: 'https://example.test', exploration: { paginationSelectors: ['#more'] } });
  assert.equal(actionFor({ kind: 'pagination', selector: '#more' }, configured).action, 'paginate');
  for (const override of [{ status: 'excluded' }, { disabled: true }, { inForm: true }]) {
    assert.equal(actionFor({ kind: 'pagination', selector: '#more', ...override }, configured).status, 'excluded');
  }
});
test('already-visible states are observed without clicking again', () => {
  assert.equal(actionFor({ kind: 'disclosure', open: true }, config).status, 'observed');
  assert.equal(actionFor({ kind: 'tab', selected: 'true', panelId: 'panel', panelExists: true }, config).status, 'observed');
});
test('repeated scroll observations deduplicate and signal aggregate extraction limits', () => {
  const configured = validateConfig({ startUrl: 'https://example.test', discovery: { maxLinksPerPage: 1, maxControlsPerPage: 1 } });
  const combined = combineInspections([
    { links: [{ href: '/a' }], controls: [{ selector: '#a', label: 'A', kind: 'tab' }] },
    { links: [{ href: '/a' }, { href: '/b' }], controls: [{ selector: '#a', label: 'A', kind: 'tab' }, { selector: '#b', label: 'B', kind: 'tab' }] }
  ], configured);
  assert.equal(combined.links.length, 1);
  assert.equal(combined.controls.length, 1);
  assert.equal(combined.truncatedLinks, true);
  assert.equal(combined.truncatedControls, true);
});
test('exploration budgets reject invalid and misspelled options', () => {
  for (const exploration of [false, { maxStates: 0 }, { maxScrollSteps: 0 }, { maxStateDepth: 0 }, { maxScrollRegions: -1 }, { maxDurationMs: 0 }, { settleTimeoutMs: 100, settleIntervalMs: 100 }, { paginationSelectors: [''] }, { madeUp: true }]) {
    assert.throws(() => validateConfig({ startUrl: 'https://example.test', exploration }), { code: 'INVALID_CONFIG' });
  }
});
