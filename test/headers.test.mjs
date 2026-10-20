// web/public/_headers (what Cloudflare serves without the Worker) must carry the same security
// headers as src/headers.js, and wrangler.jsonc must keep the Worker off everything but the pages
// and the API (cost: crawlers asking for old spam links, the built JS/CSS, images).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMON_HEADERS, PAGE_CSP } from '../src/headers.js';

const root = new URL('../', import.meta.url);
const file = readFileSync(new URL('web/public/_headers', root), 'utf8');

/** The header lines of one _headers rule, as { lower-case name: value }. */
function rule(path) {
  const lines = file.split(/\r?\n/);
  const at = lines.indexOf(path);
  assert.notEqual(at, -1, `no ${path} rule`);
  const out = {};
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s+([^:]+):\s*(.*)$/);
    if (!m) break;
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

test('_headers: every response Cloudflare serves alone gets the common headers and the page CSP', () => {
  const all = rule('/*');
  for (const [name, value] of COMMON_HEADERS) assert.equal(all[name], value, name);
  assert.equal(all['content-security-policy'], PAGE_CSP);
});

test('_headers: the built files (named by content) are kept a year', () => {
  assert.equal(rule('/assets/*')['cache-control'], 'public, max-age=31536000, immutable');
});

test('wrangler.jsonc: the Worker runs only for the API and the pages', () => {
  const cfg = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
  const list = JSON.parse(cfg.match(/"run_worker_first":\s*(\[[^\]]*\])/)[1]);
  assert.ok(list.includes('/api/*') && list.includes('/') && list.includes('/host/*') && list.includes('/board/*') && list.includes('/admin/*'));
  assert.ok(!list.some((p) => p === '/*' || p.startsWith('/assets')), 'never the whole site or the built files');
});

test('robots.txt: SEO-tool crawlers are told to stay out; search engines are not', () => {
  const robots = readFileSync(new URL('web/public/robots.txt', root), 'utf8');
  assert.match(robots, /User-agent: dotbot[\s\S]*?Disallow: \/\r?\n/);
  assert.match(robots, /User-agent: \*\r?\nAllow: \//);
});
