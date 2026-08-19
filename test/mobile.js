'use strict';

/**
 * Small-screen layout test.
 *
 * Guards the bug class that broke the phone layout: panels collapsing to zero
 * height. Fixed-height flex rails silently crushed their later children, so
 * the theater list, seismic and humanitarian panels rendered at 0px — present
 * in the DOM, invisible on screen, and completely missed by desktop tests.
 *
 * For every viewport and every tab this asserts that the panels the tab is
 * supposed to show are actually laid out with usable height, that nothing
 * overflows horizontally, and that touch targets are big enough.
 *
 * Run: node test/mobile.js [--shot-dir test/output]
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const fixtureFetch = require('./fixture-fetch');

fixtureFetch.install();

const { server } = require('../server/index');

const SHOT_DIR = (() => {
  const i = process.argv.indexOf('--shot-dir');
  const dir = i > -1 ? process.argv[i + 1] : path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

const VIEWPORTS = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-14', width: 390, height: 844 },
  { name: 'pixel-7', width: 412, height: 915 },
  { name: 'tablet-portrait', width: 820, height: 1180 },
];

/** Which panels must be visible and non-empty on each tab. */
const TABS = {
  situation: ['.panel-index', '.panel-theaters'],
  wire: ['.panel-wire', '.wire-filters'],
  markets: ['.ticker', '.ticker-track'],
  alerts: ['#panel-seismic', '#panel-humanitarian'],
};

/** Panels that must be hidden on a given tab, so tabs actually separate content. */
const HIDDEN_ON = {
  situation: ['.panel-wire', '#panel-seismic'],
  wire: ['#panel-seismic', '#panel-humanitarian', '.panel-theaters'],
  markets: ['.panel-theaters', '.panel-wire'],
  alerts: ['.panel-wire', '.panel-theaters'],
};

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`    \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`    \x1b[31m✗\x1b[0m ${name}\n        ${err.message}`);
  }
}

function findChromium() {
  const root = '/opt/pw-browsers';
  const hit = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => path.join(root, d, 'chrome-linux', 'chrome'))
    .find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`no chromium build found under ${root}`);
  return hit;
}

async function main() {
  const { chromium } = require('playwright-core');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  console.log('\n  small-screen layout\n');

  for (const vp of VIEWPORTS) {
    console.log(`  ${vp.name} (${vp.width}x${vp.height})`);

    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector('.wm-country', { timeout: 30_000 });
    await page.waitForTimeout(900);

    check('no uncaught page errors', () => assert.deepStrictEqual(pageErrors, []));

    // The map and the tab bar are the persistent chrome — both must be present
    // and usable at every size.
    const chrome = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) };
      };
      return {
        map: box('.mapzone'),
        tabbar: box('.tabbar'),
        tabs: [...document.querySelectorAll('.tab')].map((t) => {
          const r = t.getBoundingClientRect();
          return { label: t.dataset.tab, w: Math.round(r.width), h: Math.round(r.height) };
        }),
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        countries: document.querySelectorAll('.wm-country').length,
      };
    });

    check('no horizontal overflow', () =>
      assert.ok(chrome.bodyOverflowX <= 0, `body is ${chrome.bodyOverflowX}px too wide`));
    check('map is rendered and visible', () => {
      assert.ok(chrome.map.h > 120, `map is only ${chrome.map.h}px tall`);
      assert.ok(chrome.countries > 200, `only ${chrome.countries} countries drawn`);
    });
    check('tab bar is present with four tabs', () => {
      assert.ok(chrome.tabbar && chrome.tabbar.h > 0, 'tab bar not visible');
      assert.strictEqual(chrome.tabs.length, 4);
    });
    check('tab touch targets are at least 44px', () => {
      for (const t of chrome.tabs) {
        assert.ok(t.h >= 44, `${t.label} tab is ${t.h}px tall`);
        assert.ok(t.w >= 44, `${t.label} tab is ${t.w}px wide`);
      }
    });

    for (const [tab, mustShow] of Object.entries(TABS)) {
      await page.click(`.tab[data-tab="${tab}"]`);
      await page.waitForTimeout(400);

      const result = await page.evaluate(
        ({ mustShow, mustHide }) => {
          const measure = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { sel, missing: true };
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              sel,
              w: Math.round(r.width),
              h: Math.round(r.height),
              display: cs.display,
              // scrollHeight catches a panel that is laid out but has no content
              content: el.scrollHeight,
            };
          };
          return {
            selected: document.body.dataset.tab,
            shown: mustShow.map(measure),
            hidden: mustHide.map(measure),
            overflowX: document.body.scrollWidth - window.innerWidth,
            activeTabs: [...document.querySelectorAll('.tab[aria-selected="true"]')].map(
              (t) => t.dataset.tab
            ),
          };
        },
        { mustShow, mustHide: HIDDEN_ON[tab] }
      );

      check(`tab "${tab}" activates`, () => {
        assert.strictEqual(result.selected, tab);
        assert.deepStrictEqual(result.activeTabs, [tab], 'exactly one tab should be selected');
      });

      check(`tab "${tab}" panels have usable height`, () => {
        for (const p of result.shown) {
          assert.ok(!p.missing, `${p.sel} is missing from the DOM`);
          assert.notStrictEqual(p.display, 'none', `${p.sel} is display:none`);
          assert.ok(p.h > 20, `${p.sel} laid out at ${p.h}px tall`);
          assert.ok(p.content > 20, `${p.sel} has no content (scrollHeight ${p.content})`);
        }
      });

      check(`tab "${tab}" hides other sections`, () => {
        for (const p of result.hidden) {
          if (p.missing) continue;
          assert.ok(
            p.display === 'none' || p.h === 0,
            `${p.sel} should not be visible on the ${tab} tab (${p.h}px, ${p.display})`
          );
        }
      });

      check(`tab "${tab}" does not overflow`, () =>
        assert.ok(result.overflowX <= 0, `${result.overflowX}px too wide`));

      await page.screenshot({ path: path.join(SHOT_DIR, `mobile-${vp.name}-${tab}.png`) });
    }

    // The drawer is the one full-screen overlay; it must cover, not squeeze.
    await page.click('.tab[data-tab="situation"]');
    await page.waitForTimeout(300);
    await page.click('.theater-row');
    await page.waitForSelector('.drawer:not([hidden]) .stat', { timeout: 15_000 });
    const drawer = await page.evaluate(() => {
      const d = document.querySelector('.drawer');
      const r = d.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        vw: window.innerWidth,
        stats: document.querySelectorAll('#drawer-body .stat').length,
        overflowX: document.body.scrollWidth - window.innerWidth,
      };
    });
    check('theater drawer fills the screen', () => {
      assert.strictEqual(drawer.w, drawer.vw, 'drawer should span the full width');
      assert.ok(drawer.h > 300, `drawer is only ${drawer.h}px tall`);
      assert.ok(drawer.stats >= 4, `only ${drawer.stats} stat tiles`);
      assert.ok(drawer.overflowX <= 0, 'drawer must not cause horizontal overflow');
    });
    await page.screenshot({ path: path.join(SHOT_DIR, `mobile-${vp.name}-drawer.png`) });

    await page.close();
    console.log('');
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(failed ? `  ${failed} check(s) failed\n` : '  all small-screen checks passed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nmobile test crashed:', err);
  process.exit(1);
});
