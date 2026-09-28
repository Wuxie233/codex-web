const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/';
const artifactDir = process.env.TEST_ARTIFACT_DIR;
const rowSelector = '.app-shell-left-panel [data-app-action-sidebar-thread-row]';
const menuTitleSelector = '[data-codex-web-touch-thread-title]';
const report = { mode: process.env.TEST_ASSET_ROOT ? 'candidate-assets' : 'live', checks: [], assets: [] };
const record = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log(JSON.stringify({ name, ...details }));
};

async function screenshot(page, name, sidebarOnly = false) {
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  const target = sidebarOnly ? page.locator('.app-shell-left-panel') : page;
  await target.screenshot({ path: path.join(artifactDir, `${name}.png`) });
}

async function routeCandidate(page) {
  if (!process.env.TEST_ASSET_ROOT) return;
  const root = path.resolve(process.env.TEST_ASSET_ROOT);
  const allowed = new Set((process.env.TEST_ASSET_PATHS || '/assets/preload.js,/assets/app-initial-236e1501144c.js,/assets/app-primary-6b28e06666ff.js').split(','));
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!allowed.has(pathname)) return route.continue();
    const relative = pathname.replace(/^\//, '');
    const candidates = [path.join(root, 'webview-delivery', relative), path.join(root, 'asar/webview', relative), path.join(root, relative)];
    const file = candidates.find(candidate => fs.existsSync(candidate));
    assert(file, `Candidate asset missing: ${pathname}`);
    report.assets.push(pathname);
    return route.fulfill({ path: file, contentType: 'application/javascript' });
  });
}

async function openSidebar(page, width) {
  if (width <= 768) {
    const trigger = page.locator('[data-app-shell-sidebar-trigger]').first();
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.tap();
  }
  const projects = page.locator('.app-shell-left-panel [class~="group/folder-row"]');
  await projects.first().waitFor({ timeout: 60000 });
  if (await page.locator(rowSelector).count() === 0) {
    for (let index = 0; index < await projects.count(); index++) {
      await projects.nth(index).click({ position: { x: 40, y: 20 } });
      try {
        await page.locator(rowSelector).first().waitFor({ timeout: 4000 });
        break;
      } catch {}
    }
  }
  await page.locator(rowSelector).first().waitFor({ timeout: 60000 });
}

async function titleMetrics(row) {
  return row.evaluate(el => {
    const title = el.querySelector('[data-thread-title]');
    const box = title.getBoundingClientRect();
    const style = getComputedStyle(title);
    const buttons = [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return {
      rowHeight: el.getBoundingClientRect().height,
      titleHeight: box.height,
      titleWidth: box.width,
      lineHeight: parseFloat(style.lineHeight),
      titleRight: box.right,
      actionLeft: buttons.length ? Math.min(...buttons.map(button => button.left)) : null,
      horizontalOverflow: el.scrollWidth > el.clientWidth + 1,
    };
  });
}

async function checkBoundaryTitles(page, width) {
  const row = page.locator(rowSelector).first();
  await row.scrollIntoViewIfNeeded();
  const content = row.locator('[data-thread-title] [data-marquee-content] > span').first();
  const original = await content.textContent();
  try {
    for (const [kind, text] of [
      ['short', '短标题'],
      ['long-cjk', '这是一条需要完整阅读的侧边栏标题'.repeat(7)],
      ['unbroken-path', 'src/components/averylongcomponentnamewithoutspaces'.repeat(5)],
    ]) {
      await content.evaluate((el, value) => { el.textContent = value; }, text);
      await page.waitForTimeout(100);
      const metrics = await titleMetrics(row);
      const expectedLines = kind === 'short' ? 1 : 2;
      assert(Math.abs(metrics.titleHeight - metrics.lineHeight * expectedLines) <= 2,
        `${width} ${kind}: title must use ${expectedLines} line(s), got ${metrics.titleHeight}/${metrics.lineHeight}`);
      assert(!metrics.horizontalOverflow, `${width} ${kind}: row overflows horizontally`);
      if (metrics.actionLeft !== null) assert(metrics.titleRight <= metrics.actionLeft + 1, `${width} ${kind}: title overlaps actions`);
      record('DOM-only title boundary', { width, kind, ...metrics });
      await screenshot(page, `titles-dom-${width}-${kind}`, true);
    }
  } finally {
    await content.evaluate((el, value) => { el.textContent = value; }, original);
  }
}

async function stationaryLongPress(page, row, cdp, width) {
  await row.scrollIntoViewIfNeeded();
  const title = row.locator('[data-thread-title]');
  const box = await title.boundingBox();
  assert(box && box.width > 0, 'title touch target exists');
  const selectedBefore = await page.locator(`${rowSelector}[data-app-action-sidebar-thread-selected="true"]`).evaluateAll(rows => rows.map(row => row.getAttribute('data-app-action-sidebar-thread-id')).sort().join(','));
  const sidebarTrigger = page.locator('[data-app-shell-sidebar-trigger]').first();
  const expandedBefore = await sidebarTrigger.getAttribute('aria-expanded');
  await page.evaluate(() => {
    window.__sidebarTouchTrace = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu']) {
      document.addEventListener(type, event => window.__sidebarTouchTrace.push({
        type, pointerType: event.pointerType, onTitle: !!event.target.closest?.('[data-thread-title]'),
      }), { capture: true, once: true });
    }
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await page.waitForTimeout(1000);
  const openedWhileHeld = await page.getByRole('menu').count() > 0;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const selectedAfter = await page.locator(`${rowSelector}[data-app-action-sidebar-thread-selected="true"]`).evaluateAll(rows => rows.map(row => row.getAttribute('data-app-action-sidebar-thread-id')).sort().join(','));
  assert.equal(selectedAfter, selectedBefore, 'releasing long press must not navigate');
  assert.equal(await sidebarTrigger.getAttribute('aria-expanded'), expandedBefore, 'releasing long press must not close sidebar');
  const trace = await page.evaluate(() => window.__sidebarTouchTrace);
  record('CDP stationary long press', { width, openedWhileHeld, trace });
  assert(openedWhileHeld, `${width}: stationary touch must open original menu before release`);
  await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 3000 });
}

async function checkRealMenu(page, width, cdp) {
  // The longest already-loaded real title exercises the React menu data path.
  const index = await page.locator(rowSelector).evaluateAll(rows => rows.reduce((best, row, index) =>
    (row.getAttribute('data-app-action-sidebar-thread-title') || '').length >
    (rows[best].getAttribute('data-app-action-sidebar-thread-title') || '').length ? index : best, 0));
  const row = page.locator(rowSelector).nth(index);
  const original = await row.getAttribute('data-app-action-sidebar-thread-title');
  await stationaryLongPress(page, row, cdp, width);
  const title = page.locator(menuTitleSelector);
  assert.equal(await title.textContent(), original, 'menu must retain the complete original real title');
  const metrics = await title.evaluate(el => ({
    whiteSpace: getComputedStyle(el).whiteSpace,
    wordBreak: getComputedStyle(el).overflowWrap,
    clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
    box: el.getBoundingClientRect().toJSON(),
  }));
  const menuBox = await page.getByRole('menu').first().boundingBox();
  record('Real menu geometry', { width, menuBox, titleBox: metrics.box });
  await screenshot(page, `titles-real-menu-${width}`);
  assert.equal(metrics.whiteSpace, 'normal', 'menu title wraps');
  assert(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1, 'menu stays in viewport');
  assert(menuBox.y >= 0 && menuBox.y + menuBox.height <= page.viewportSize().height + 1, 'menu stays within viewport height');
  record('Real title retained in original menu', { width, titleCharacters: original.length, titleHeight: metrics.box.height, menuWidth: menuBox.width });

  // This deliberately changes only rendered text, never the real thread title.
  await title.evaluate(el => { el.textContent = '完整标题边界检查'.repeat(120); });
  const boundary = await title.evaluate(el => ({
    height: el.clientHeight, scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
    lineClamp: getComputedStyle(el).webkitLineClamp,
  }));
  assert(boundary.scrollHeight > boundary.height, 'very long menu title has scrollable content');
  assert(['auto', 'scroll'].includes(boundary.overflowY), 'menu title supplies vertical scrolling');
  assert(!boundary.lineClamp || boundary.lineClamp === 'none', 'full menu title is not clamped');
  await title.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert(await title.evaluate(el => el.scrollTop) > 0, 'full title can scroll to its end');
  const lastAction = page.getByRole('menu').first().getByRole('menuitem').last();
  await lastAction.scrollIntoViewIfNeeded();
  const lastActionBox = await lastAction.boundingBox();
  assert(lastActionBox.y >= 0 && lastActionBox.y + lastActionBox.height <= page.viewportSize().height + 1, 'original last menu action stays reachable');
  record('DOM-only menu title overflow', { width, ...boundary });
  await page.keyboard.press('Escape');
  await page.getByRole('menu').first().waitFor({ state: 'hidden' });
  await openSidebar(page, width);
}

async function checkScroll(page, width, cdp) {
  const scroll = page.locator('.app-shell-left-panel .overflow-y-auto').first();
  const oldStyle = await scroll.getAttribute('style');
  await scroll.evaluate(el => el.style.setProperty('max-height', '220px', 'important'));
  try {
    await page.locator(rowSelector).first().scrollIntoViewIfNeeded();
    const scrollBox = await scroll.boundingBox();
    const xy = await page.locator(rowSelector).evaluateAll((rows, box) => {
      for (const row of rows) {
        const title = row.querySelector('[data-thread-title]');
        const rect = title.getBoundingClientRect();
        const top = Math.max(rect.top, box.y);
        const bottom = Math.min(rect.bottom, box.y + box.height);
        if (bottom - top > 12) return { x: rect.x + Math.min(30, rect.width / 2), y: (top + bottom) / 2 };
      }
    }, scrollBox);
    assert(xy, 'visible row available for scroll gesture');
    const before = await scroll.evaluate(el => el.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [xy] });
    await page.waitForTimeout(350);
    for (let distance = 10; distance <= 100; distance += 10) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: xy.x, y: xy.y - distance }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    const delta = await scroll.evaluate(el => el.scrollTop) - before;
    assert(delta > 20, 'gesture starting on title must scroll the sidebar');
    assert.equal(await page.getByRole('menu').count(), 0, 'vertical gesture must not open a menu');
    record('CDP vertical scroll without menu', { width, holdMs: 350, scrollDelta: delta, constrainedViewport: true });
  } finally {
    await scroll.evaluate((el, style) => { if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style); }, oldStyle);
  }
}

async function checkReadOnlyActions(page, width) {
  const row = page.locator(`${rowSelector}:not([data-app-action-sidebar-thread-selected="true"])`).first();
  assert(await row.count() > 0, 'an unselected real thread is required to verify navigation');
  await row.scrollIntoViewIfNeeded();
  const id = await row.getAttribute('data-app-action-sidebar-thread-id');
  const archive = row.locator('button:is([aria-label="归档聊天"], [aria-label="Archive chat"])');
  await archive.tap();
  const dialog = page.locator('.codex-web-archive-confirm');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).tap();
  await dialog.waitFor({ state: 'hidden' });
  assert(await page.locator(rowSelector).evaluateAll((rows, value) => rows.some(row => row.getAttribute('data-app-action-sidebar-thread-id') === value), id), 'cancel keeps real thread');
  record('Archive confirmation canceled', { width });
  await row.locator('[data-thread-title]').tap();
  await page.waitForFunction(({ selector, value }) => [...document.querySelectorAll(selector)].some(row =>
    row.getAttribute('data-app-action-sidebar-thread-id') === value && row.getAttribute('data-app-action-sidebar-thread-selected') === 'true'), { selector: rowSelector, value: id });
  assert.equal(await page.getByRole('menu').count(), 0, 'short tap navigates without menu');
  record('Short tap selects existing thread', { width });
  if (width <= 768) {
    const trigger = page.locator('[data-app-shell-sidebar-trigger]').first();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'navigation closes mobile drawer');
    await trigger.tap();
    await page.locator('.codex-web-close-sidebar').tap();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'original close control works');
    await trigger.tap();
    const panel = await page.locator('.app-shell-left-panel').boundingBox();
    await page.touchscreen.tap((panel.x + panel.width + width) / 2, 300);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'backdrop closes drawer');
    record('Navigation, close control and backdrop close drawer', { width });
  }
}

(async () => {
  const started = Date.now();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    for (const width of [390, 820, 1280]) {
      const touch = width !== 1280;
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch, colorScheme: 'dark',
        ...(process.env.TEST_AUTH_FILE ? { httpCredentials: { username: process.env.TEST_AUTH_USER || 'codex', password: fs.readFileSync(process.env.TEST_AUTH_FILE, 'utf8').trim() } } : {}),
      });
      const page = await context.newPage();
      try {
        await routeCandidate(page);
        await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
        await page.locator('[contenteditable=true]').first().waitFor({ timeout: 60000 });
        await openSidebar(page, width);
        const panel = await page.locator('.app-shell-left-panel').boundingBox();
        if (touch) {
          assert(panel.width > 280, 'touch sidebar provides enough title space');
          assert(panel.width <= width - 48, 'sidebar leaves room for backdrop or conversation');
          record('Touch sidebar width', { width, sidebarWidth: panel.width, remainingWidth: width - panel.width });
          await screenshot(page, `titles-real-sidebar-${width}`, true);
          const cdp = await context.newCDPSession(page);
          try {
            await checkRealMenu(page, width, cdp);
            await checkBoundaryTitles(page, width);
            await checkScroll(page, width, cdp);
            await checkReadOnlyActions(page, width);
          } finally { await cdp.detach(); }
        } else {
          const row = page.locator(rowSelector).first();
          await row.scrollIntoViewIfNeeded();
          await page.mouse.move(width - 20, 100);
          const rail = row.locator('.absolute:has(button)').first();
          assert.equal(await rail.evaluate(el => getComputedStyle(el).opacity), '0', 'desktop actions stay hover-only');
          assert.equal(await row.evaluate(el => getComputedStyle(el.closest('.touch-none') || el).touchAction), 'none', 'desktop drag semantics remain');
          await row.click({ button: 'right' });
          await page.getByRole('menu').first().waitFor();
          if (await page.locator(menuTitleSelector).count()) assert.equal(await page.locator(menuTitleSelector).isVisible(), false, 'touch title header stays hidden on desktop');
          await screenshot(page, 'titles-desktop-menu');
          await page.keyboard.press('Escape');
          record('Desktop hover, drag styling and original context menu unchanged', { width, sidebarWidth: panel.width });
        }
      } finally { await context.close(); }
    }
    if (process.env.TEST_ASSET_ROOT) assert(['/assets/preload.js', '/assets/app-initial-236e1501144c.js', '/assets/app-primary-6b28e06666ff.js'].every(asset => report.assets.includes(asset)), 'candidate assets were actually intercepted');
    report.passed = true;
  } finally {
    await browser.close();
    report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (artifactDir) { fs.mkdirSync(artifactDir, { recursive: true }); fs.writeFileSync(path.join(artifactDir, 'sidebar-titles-report.json'), JSON.stringify(report, null, 2)); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
