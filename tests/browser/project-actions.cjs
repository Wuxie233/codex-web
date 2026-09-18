const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']});
  try {
    for (const width of [1280, 390, 535]) {
      const touch = width < 768;
      const page = await browser.newPage({viewport: {width, height: 900}, hasTouch: touch, isMobile: touch});
      await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/');
      await page.locator('[contenteditable=true]').first().waitFor({timeout: 60000});
      if (touch) await page.locator('[data-app-shell-sidebar-trigger]').first().tap();
      // Requires at least one existing local project; never create or delete one.
      const button = page.locator('.app-shell-left-panel [class~="group/folder-row"] button[aria-haspopup="menu"]').first();
      await button.waitFor();
      if (!touch) {
        await button.focus();
      }
      if (touch) await button.tap({timeout: 5000});
      else await button.click({timeout: 5000});
      const menu = page.getByRole('menu');
      await menu.waitFor({timeout: 5000});
      assert(await menu.getByRole('menuitem').count() > 0);
      if (touch) {
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44);
      }
      await page.keyboard.press('Escape');
      await menu.waitFor({state: 'hidden'});
      // Escape also dismisses the narrow-screen sidebar overlay.
      if (touch && !await button.isVisible()) {
        await page.locator('[data-app-shell-sidebar-trigger]').first().tap();
      }
      if (touch) await button.tap();
      else await button.click();
      await menu.waitFor();
      await menu.getByRole('menuitem', {name: /^(编辑|Edit)$/}).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({state: 'hidden'});
      await page.close();
      console.log(`PASS ${width}px: project menu opens, dismisses, and reopens`);
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
