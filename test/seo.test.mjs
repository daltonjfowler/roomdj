// src/seo.js + web/public robots/sitemap + page tags: public pages indexable on roomdj.com only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { cleanPath, robotsTag } from '../src/seo.js';

test('cleanPath: the public pages .html addresses only', () => {
  assert.deepEqual(['/index.html', '/about.html', '/legal.html', '/setup.html'].map(cleanPath), ['/', '/about', '/legal', '/setup']);
  for (const p of ['/', '/about', '/host/index.html', '/404.html', '/toString', '/constructor']) assert.equal(cleanPath(p), null, p);
});

test('robotsTag: public pages on roomdj.com yes; teacher page, board, admin, API and other hosts no', () => {
  for (const p of ['/', '/about', '/setup', '/legal', '/screens/board.jpg', '/social.jpg']) assert.equal(robotsTag(`https://roomdj.com${p}`, p), null, p);
  for (const p of ['/host/', '/host', '/board/', '/admin/', '/api/config']) assert.equal(robotsTag(`https://roomdj.com${p}`, p), 'noindex, nofollow', p);
  assert.equal(robotsTag('https://classqueue.daltonjfowler.workers.dev/', '/'), 'noindex, nofollow', 'no duplicate site');
  assert.equal(robotsTag('http://127.0.0.1:8792/', '/'), 'noindex, nofollow');
  assert.equal(robotsTag('https://roomdj.com/hosting-tips', '/hosting-tips'), null, 'only the real private paths');
});

test('robots.txt, sitemap and page tags agree', () => {
  const robots = readFileSync(new URL('../web/public/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /Disallow: \/api\//);
  // Crawlable, so their noindex header is seen (a Disallow would hide it).
  for (const d of ['/host/', '/board/', '/admin/']) assert.doesNotMatch(robots, new RegExp(`Disallow: ${d}`), d);
  assert.match(robots, /Sitemap: https:\/\/roomdj\.com\/sitemap\.xml/);
  const sitemap = readFileSync(new URL('../web/public/sitemap.xml', import.meta.url), 'utf8');
  for (const p of ['/', '/about', '/setup', '/legal']) assert.ok(sitemap.includes(`<loc>https://roomdj.com${p}</loc>`), p);
  for (const [file, path] of [['../web/index.html', '/'], ['../web/public/about.html', '/about'], ['../web/public/setup.html', '/setup'], ['../web/public/legal.html', '/legal']]) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(html.includes(`<link rel="canonical" href="https://roomdj.com${path}">`), `${file} canonical`);
    assert.ok(html.includes('og:image" content="https://roomdj.com/social.jpg"'), `${file} og:image`);
    assert.ok(!/name="robots" content="noindex/.test(html), `${file} indexable`);
  }
  for (const file of ['../web/host/index.html', '../web/board/index.html', '../web/admin/index.html']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /name="robots" content="noindex/, file);
  }
});
