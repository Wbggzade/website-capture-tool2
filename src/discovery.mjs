import { createHash } from 'node:crypto';
import { displayUrl, inScope, urlKey } from './url.mjs';

const actionWords = /(?:^|[\s/_?&=.-])(logout|log-out|signout|sign-out|delete|remove|unsubscribe|checkout|purchase|buy|submit|send|reset|revoke)(?:$|[\s/_?&=.-])/i;
const assetPath = /\.(?:pdf|zip|rar|7z|exe|dmg|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|woff2?)(?:$)/i;
export const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function classifyLink(link, baseUrl, config) {
  if (!link.href || link.href.trim().startsWith('#') && !/^#!?\//.test(link.href.trim())) return { reason: 'same-page-anchor' };
  let url;
  try { url = urlKey(new URL(link.href, baseUrl).href); } catch { return { reason: 'unsupported-url' }; }
  if (!inScope(url, config.startUrl, config.scopePath)) return { reason: 'out-of-scope', url };
  const parsed = new URL(url);
  if (parsed.hash && !/^#!?\//.test(parsed.hash)) parsed.hash = ''; // Ordinary in-page anchors do not create new pages.
  url = parsed.href;
  if (link.download) return { reason: 'download', url };
  if (assetPath.test(parsed.pathname)) return { reason: 'asset', url };
  let actionText = `${parsed.pathname}${parsed.search} ${link.label ?? ''}`;
  try { actionText = decodeURIComponent(actionText); } catch { /* malformed escapes remain literal */ }
  if (actionWords.test(actionText)) return { reason: 'excluded-action', url };
  return { url };
}

// Bounded in-memory graph. Raw URLs are needed for navigation but never serialized.
export class DiscoveryQueue {
  constructor(config) {
    this.config = config;
    this.items = [];
    this.seen = new Map();
    this.cursor = 0;
    this.edges = [];
    this.limits = new Set();
    this.aliases = new Map();
    this.observedBatches = new Set();
    for (const url of config.urls) this.add(url, null, 0, 'Explicit target');
  }
  static restore(config, snapshot) {
    const queue = Object.create(DiscoveryQueue.prototype);
    queue.config = config;
    queue.items = snapshot.items.map(item => ({ ...item }));
    queue.seen = new Map(queue.items.map(item => [item.key, item]));
    queue.cursor = 0;
    queue.edges = snapshot.edges.map(edge => ({ ...edge }));
    queue.limits = new Set(snapshot.limits);
    queue.aliases = new Map(snapshot.aliases);
    queue.observedBatches = new Set(snapshot.observedBatches ?? []);
    return queue;
  }
  add(url, parentId, depth, label = '') {
    const key = urlKey(url);
    if (this.seen.has(key)) return { reason: 'duplicate', targetId: this.seen.get(key).id };
    if (depth > this.config.discovery.maxDepth) { this.limits.add('max-depth'); return { reason: 'max-depth' }; }
    if (this.items.length >= this.config.discovery.maxPages) { this.limits.add('max-pages'); return { reason: 'max-pages' }; }
    const item = { id: this.items.length + 1, key, parentId, depth, label: label.slice(0, 160), status: 'pending' };
    this.items.push(item);
    this.seen.set(key, item);
    return { targetId: item.id, reason: 'queued' };
  }
  next() {
    while (this.cursor < this.items.length) {
      const item = this.items[this.cursor++];
      if (item.status === 'pending') { item.status = 'running'; return item; }
    }
    return null;
  }
  hasNext() { return this.items.slice(this.cursor).some(item => item.status === 'pending'); }
  snapshot() {
    return { items: this.items.map(item => ({ ...item })), edges: this.edges.map(edge => ({ ...edge })),
      limits: [...this.limits], aliases: [...this.aliases], observedBatches: [...this.observedBatches] };
  }
  observe(item, links, baseUrl, batchKey = null) {
    const batchId = batchKey === null ? null : `${item.id}:${batchKey}`;
    if (batchId && this.observedBatches.has(batchId)) return;
    if (batchId) this.observedBatches.add(batchId);
    for (const link of links) {
      const candidate = classifyLink(link, baseUrl, this.config);
      const outcome = candidate.reason ? { reason: candidate.reason } : this.add(candidate.url, item.id, item.depth + 1, link.label);
      this.edges.push({ parentId: item.id, label: (link.label ?? '').slice(0, 160),
        ...(candidate.url ? { url: displayUrl(candidate.url), urlId: fingerprint(candidate.url) } : {}), ...outcome });
    }
  }
  report() {
    return { pages: this.items.map(({ key, ...item }) => ({ ...item, url: displayUrl(key), urlId: fingerprint(key) })),
      links: this.edges, limits: [...this.limits] };
  }
}

export async function inspectPage(page, config) {
  return page.evaluate(({ maxLinksPerPage, maxControlsPerPage }) => {
    const visible = el => {
      // Closed details may retain geometry for descendants even though they are not shown.
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.localName === 'details' && !ancestor.open) {
          const summary = [...ancestor.children].find(child => child.localName === 'summary');
          if (!summary?.contains(el)) return false;
        }
      }
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
    };
    const label = el => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    const rank = el => el.closest('nav,[role="navigation"]') ? 0 : el.closest('main,[role="main"]') ? 1 : 2;
    const anchors = [...document.querySelectorAll('a[href]')].filter(visible).map((el, order) => ({ el, order }));
    anchors.sort((a, b) => rank(a.el) - rank(b.el) || a.order - b.order);
    const links = anchors.slice(0, maxLinksPerPage).map(({ el }) => ({ href: el.href, label: label(el), download: el.hasAttribute('download') }));
    // Snapshot selector hints only: Stage 3 must revalidate controls before interacting.
    const selectorFor = el => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        const tag = el.localName;
        const siblings = [...el.parentElement.children].filter(sibling => sibling.localName === tag);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(el) + 1})`);
        el = el.parentElement;
      }
      return `html > ${parts.join(' > ')}`;
    };
    const elements = [...document.querySelectorAll('button,[role="button"],[role="tab"],summary,[aria-expanded]')].filter(visible);
    const controls = elements.slice(0, maxControlsPerPage).map(el => {
      const text = label(el);
      const role = el.getAttribute('role');
      let kind = 'unknown';
      if (el.matches('summary')) kind = 'disclosure';
      else if (role === 'tab') kind = 'tab';
      else if (el.hasAttribute('aria-expanded')) kind = 'expandable';
      else if (/^(?:load|show) more\b|^next(?: page)?$/i.test(text)) kind = 'pagination';
      const submit = (el.tagName === 'BUTTON' && el.type === 'submit' && !!el.form);
      const risky = submit || /\b(delete|remove|buy|purchase|checkout|submit|send|logout|sign out|unsubscribe|reset|revoke)\b/i.test(text);
      const status = risky ? 'excluded' : kind === 'unknown' ? 'unclassified' : 'deferred';
      return { kind, label: text, selector: selectorFor(el), status,
        reason: risky ? 'state-changing-or-form-action' : kind === 'unknown' ? 'unknown-behavior' : 'stage-3-interaction',
        expanded: el.getAttribute('aria-expanded'), selected: el.getAttribute('aria-selected'),
        open: el.localName === 'summary' ? el.parentElement.open : null,
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
        inForm: !!el.closest('form'), panelId: el.getAttribute('aria-controls'),
        panelExists: !!document.getElementById(el.getAttribute('aria-controls') ?? '') };
    });
    return { links, controls, totals: { links: anchors.length, controls: elements.length },
      truncatedLinks: anchors.length > maxLinksPerPage, truncatedControls: elements.length > maxControlsPerPage };
  }, config.discovery);
}
