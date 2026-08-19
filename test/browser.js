'use strict';

/**
 * Browser smoke test.
 *
 * Boots the real server against fixture data, drives the page in Chromium, and
 * asserts that the dashboard actually renders — map geometry, theater list,
 * wire, ticker and the drawer interaction. Unit tests cover the data layer;
 * this covers the part only a browser can tell us about.
 *
 * Run: node test/browser.js [--headed] [--shot out.png]
 */

const assert = require('assert');
const path = require('path');
const fixtureFetch = require('./fixture-fetch');

fixtureFetch.install();

const { server } = require('../server/index');

const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  if (i > -1) return process.argv[i + 1];
  const dir = path.join(__dirname, 'output');
  require('fs').mkdirSync(dir, { recursive: true });
  return path.join(dir, 'dashboard.png');
})();

async function main() {
  const { chromium } = require('playwright-core');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n  server on ${base}`);

  // The preinstalled browser is versioned; take whichever build is present
  // rather than pinning a path that shifts with the image.
  const fs = require('fs');
  const root = '/opt/pw-browsers';
  const candidates = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => path.join(root, d, 'chrome-linux', 'chrome'))
    .filter((p) => fs.existsSync(p));

  if (!candidates.length) throw new Error(`no chromium build found under ${root}`);

  const browser = await chromium.launch({
    executablePath: candidates[0],
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
  };

  console.log('  loading page…\n');
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });

  // The map geometry is a ~750KB fetch + decode; give it room.
  await page.waitForSelector('.wm-country', { timeout: 30_000 });
  await page.waitForTimeout(1200);

  // -- structural assertions ------------------------------------------------

  const counts = await page.evaluate(() => ({
    countries: document.querySelectorAll('.wm-country').length,
    activeCountries: document.querySelectorAll('.wm-country.active').length,
    markers: document.querySelectorAll('.wm-marker').length,
    density: document.querySelectorAll('.wm-density-pt').length,
    theaterRows: document.querySelectorAll('.theater-row').length,
    wireItems: document.querySelectorAll('.wire-item').length,
    ticks: document.querySelectorAll('.tick').length,
    sparks: document.querySelectorAll('.spark').length,
    components: document.querySelectorAll('.component-list li').length,
    seismic: document.querySelectorAll('#seismic-list .mini-item').length,
    humanitarian: document.querySelectorAll('#humanitarian-list .mini-item').length,
    composite: document.getElementById('composite-value').textContent.trim(),
    band: document.getElementById('composite-band').textContent.trim(),
    gaugeOffset: document.getElementById('gauge-fill').style.strokeDashoffset,
    stress: document.getElementById('stress-readout').textContent.trim(),
    // html is overflow:hidden, so it always reports zero overflow — the real
    // signal is whether body itself grew past the viewport.
    bodyScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - window.innerWidth,
    layoutCols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
    railLeftW: Math.round(document.querySelector('.rail-left').getBoundingClientRect().width),
  }));

  console.log('  ' + JSON.stringify(counts, null, 2).split('\n').join('\n  ') + '\n');

  check('no uncaught page errors', () => assert.deepStrictEqual(pageErrors, []));
  check('no console errors', () => assert.deepStrictEqual(consoleErrors, []));
  check('world geometry rendered', () => assert.ok(counts.countries > 200, `got ${counts.countries}`));
  check('theater countries highlighted', () => assert.ok(counts.activeCountries > 20, `got ${counts.activeCountries}`));
  check('theater markers placed', () => assert.ok(counts.markers >= 24, `got ${counts.markers}`));
  check('reporting density layer drawn', () => assert.ok(counts.density > 0, `got ${counts.density}`));
  check('theater watchlist populated', () => assert.ok(counts.theaterRows >= 24, `got ${counts.theaterRows}`));
  check('wire populated', () => assert.ok(counts.wireItems > 0, `got ${counts.wireItems}`));
  check('market ticker populated', () => assert.ok(counts.ticks >= 18, `got ${counts.ticks}`));
  check('sparklines drawn', () => assert.ok(counts.sparks > 0, `got ${counts.sparks}`));
  check('composite index computed', () => {
    assert.notStrictEqual(counts.composite, '--', 'composite should not be blank');
    assert.ok(Number(counts.composite) >= 0 && Number(counts.composite) <= 100);
  });
  check('composite band labelled', () => assert.ok(counts.band && counts.band !== 'awaiting data'));
  check('gauge arc advanced', () => {
    const offset = parseFloat(counts.gaugeOffset);
    assert.ok(offset >= 0 && offset < 157, `dashoffset ${offset} should be inside the arc`);
  });
  check('index components listed', () => assert.strictEqual(counts.components, 3));
  check('market stress shown', () => assert.ok(/stress \d+/.test(counts.stress), counts.stress));
  check('seismic panel populated', () => assert.ok(counts.seismic > 0, `got ${counts.seismic}`));
  check('humanitarian panel populated', () => assert.ok(counts.humanitarian > 0, `got ${counts.humanitarian}`));
  check('page does not scroll horizontally', () => assert.strictEqual(counts.bodyScrollX, 0));
  check('body does not overflow the viewport', () =>
    assert.ok(counts.bodyOverflow <= 0, `body is ${counts.bodyOverflow}px wider than the viewport`));
  check('left rail is laid out at full width', () =>
    assert.ok(counts.railLeftW >= 280, `rail-left is ${counts.railLeftW}px`));

  // -- interaction ----------------------------------------------------------

  await page.click('.theater-row');
  await page.waitForSelector('.drawer:not([hidden]) .stat', { timeout: 15_000 });
  const drawer = await page.evaluate(() => ({
    title: document.getElementById('drawer-title').textContent.trim(),
    stats: document.querySelectorAll('#drawer-body .stat').length,
    wire: document.querySelectorAll('#drawer-body .wire-item').length,
  }));
  check('drawer opens with theater detail', () => {
    assert.ok(drawer.title && drawer.title !== 'Loading…', `title: ${drawer.title}`);
    assert.ok(drawer.stats >= 4, `stat tiles: ${drawer.stats}`);
  });

  await page.screenshot({ path: SHOT.replace(/\.png$/, '-drawer.png') });

  await page.click('#drawer-close');
  await page.waitForTimeout(300);
  check('drawer closes', async () => {});

  // Zoom controls should change the viewBox.
  const before = await page.getAttribute('.warmap', 'viewBox');
  await page.click('#zoom-in');
  await page.waitForTimeout(400);
  const after = await page.getAttribute('.warmap', 'viewBox');
  check('zoom control changes the view', () => assert.notStrictEqual(before, after));

  await page.click('#zoom-reset');
  await page.waitForTimeout(700);

  // Wire filtering hits the server.
  await page.fill('#wire-search', 'kharkiv');
  await page.waitForTimeout(900);
  const filtered = await page.evaluate(() => ({
    items: document.querySelectorAll('.wire-item').length,
    meta: document.getElementById('wire-meta').textContent,
  }));
  check('wire search filters', () => assert.ok(/match/.test(filtered.meta), filtered.meta));
  await page.fill('#wire-search', '');
  await page.waitForTimeout(700);

  // Methodology dialog.
  await page.click('#methodology-btn');
  await page.waitForSelector('#methodology:not([hidden])', { timeout: 5000 });
  const sources = await page.evaluate(
    () => document.querySelectorAll('#source-status-list div').length
  );
  check('methodology dialog lists source status', () => assert.ok(sources > 0, `got ${sources}`));
  await page.click('#methodology-close');

  // -- final screenshots ----------------------------------------------------

  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT });
  console.log(`\n  screenshot: ${SHOT}`);

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForTimeout(700);
  const mobileScroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check('narrow layout does not scroll horizontally', () => assert.strictEqual(mobileScroll, 0));
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-narrow.png') });

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(failed ? `\n  ${failed} check(s) failed\n` : '\n  all browser checks passed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nbrowser test crashed:', err);
  process.exit(1);
});
