const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  assert(process.env.TEST_THREAD_TITLE, 'Set TEST_THREAD_TITLE to an existing thread (read-only navigation)');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'dark'});
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/', {waitUntil:'domcontentloaded'});
    await page.locator('[contenteditable=true]').first().waitFor({timeout:60000});
    const trigger = page.locator('[data-app-shell-sidebar-trigger]').first();
    const close = page.locator('.codex-web-close-sidebar');
    await trigger.tap();
    await close.waitFor({state:'visible'});
    await close.tap();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.tap();
    await page.locator('.app-shell-left-panel').getByText(process.env.TEST_THREAD_TITLE,{exact:true}).first().tap();
    await page.waitForTimeout(1800);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    const add = page.getByRole('button',{name:/添加文件等内容|Add files and more/i}).first();
    await add.waitFor({timeout:60000});
    const hit = await add.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    assert(hit, 'closed sidebar intercepts composer touch');
    await add.tap();
    assert.equal(await add.getAttribute('aria-expanded'), 'true');
    await page.getByText(/^(文件和文件夹|Files and folders)$/i).waitFor();
    assert.equal(await page.getByText(/^(退出登录|Log out)$/i).isVisible(), false, 'account menu opened instead of attachments');
    await page.keyboard.press('Escape');
    await trigger.tap();
    await close.waitFor({state:'visible'});
    await page.touchscreen.tap(370,300);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await page.setViewportSize({width:1280,height:844});
    await page.waitForTimeout(500);
    assert.equal(await close.isVisible(), false, 'mobile close control leaked into desktop');
    console.log('PASS: close button, navigation close, attachment touch, backdrop, desktop');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
