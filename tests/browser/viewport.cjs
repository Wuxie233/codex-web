// Run against a running local server; Playwright and Chromium are test tools only.
// PLAYWRIGHT_MODULE may point at an existing installation instead of node_modules.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    await page.addInitScript(() => {
      Object.defineProperty(visualViewport, 'height', {get: () => window.testVisibleHeight ?? 650});
      Object.defineProperty(visualViewport, 'scale', {get: () => window.testViewportScale ?? 1});
    });
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/', {waitUntil: 'domcontentloaded'});
    await page.locator('[contenteditable=true]').first().waitFor({timeout: 60000});
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({width, height: 800});
      for (const zoom of [1, 1.25]) {
        for (const height of [650, 450, 740]) {
          await page.locator('[contenteditable=true]').first().focus();
          await page.evaluate(({height, zoom}) => {
            window.testVisibleHeight = height;
            document.documentElement.style.setProperty('--codex-window-zoom', String(zoom));
            visualViewport.dispatchEvent(new Event('resize'));
          }, {height, zoom});
          await page.waitForTimeout(1000);
          const bounds = await page.evaluate(() => {
            const root = document.querySelector('#root > .relative.flex.flex-col');
            const editor = document.querySelector('[contenteditable=true]');
            return {root: root?.getBoundingClientRect().bottom, editor: editor?.closest('[class*="_ComposerLayoutRoot_"]')?.getBoundingClientRect().bottom};
          });
          assert(bounds.root > 0 && bounds.root <= height + 1, `root overflow ${JSON.stringify({width,zoom,height,bounds})}`);
          assert(bounds.editor > 0 && bounds.editor <= height + 1, `composer overflow ${JSON.stringify({width,zoom,height,bounds})}`);
        }
      }
    }
    const before = await page.evaluate(() => document.documentElement.style.getPropertyValue('--codex-web-visible-height'));
    await page.evaluate(() => {
      window.testViewportScale = 2;
      window.testVisibleHeight = 300;
      visualViewport.dispatchEvent(new Event('resize'));
    });
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--codex-web-visible-height')), before, 'pinch zoom must not reflow shell');
    console.log('PASS: tablet/phone widths, toolbar/keyboard heights, app zoom, pinch zoom');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
