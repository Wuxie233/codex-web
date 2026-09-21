const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'dark'});
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/', {waitUntil:'domcontentloaded'});
    await page.locator('[contenteditable=true]').first().waitFor({timeout:60000});
    const trigger = page.locator('[data-app-shell-sidebar-trigger]').first();
    await trigger.tap();
    const archive = page.locator('.app-shell-left-panel').getByRole('button',{name:/^(归档聊天|Archive chat)$/}).first();
    if (await archive.count() === 0) {
      const projects = page.locator('.app-shell-left-panel [class~="group/folder-row"]');
      await projects.first().waitFor();
      for (let i = 0; i < await projects.count(); i++) {
        await projects.nth(i).tap({position:{x:40,y:15}});
        try { await archive.waitFor({timeout:3000}); break; } catch {}
      }
    }
    await archive.waitFor({timeout:60000});
    const state = await archive.evaluate(e => {
      let opacity = 1;
      for(let n=e;n;n=n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      const r=e.getBoundingClientRect();
      return {opacity, width:r.width, height:r.height, icon: getComputedStyle(e.querySelector('svg')).display, text: getComputedStyle(e, '::after').content};
    });
    assert(state.opacity > 0.9 && state.width > 0 && state.width < 44 && state.height > 0 && state.height < 44, JSON.stringify(state));
    assert.notEqual(state.icon, 'none', 'original archive icon remains visible');
    assert(['none', 'normal', '""'].includes(state.text), 'no added text label');
    await archive.tap();
    const dialog = page.locator('.codex-web-archive-confirm');
    await dialog.waitFor();
    await dialog.getByRole('button',{name:/^(取消|Cancel)$/}).tap();
    assert.equal(await dialog.count(),0);
    assert.equal(await archive.count(),1);
    await archive.tap();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(),0);
    // Confirm only a DOM fixture: never archive a real user's thread.
    await page.evaluate(() => {
      const fixture = document.createElement('button');
      fixture.id = 'archive-test-fixture';
      fixture.setAttribute('aria-label', 'Archive chat');
      window.archiveTestCalls = 0;
      fixture.onclick = () => { window.archiveTestCalls++; };
      document.querySelector('.app-shell-left-panel').append(fixture);
      fixture.click();
    });
    await dialog.getByRole('button', {name:'Archive', exact:true}).click();
    assert.equal(await page.evaluate(() => window.archiveTestCalls), 1);
    await dialog.waitFor({state:'detached'});
    await page.evaluate(() => {
      const fixture = document.querySelector('#archive-test-fixture');
      fixture.click();
      fixture.remove();
    });
    await dialog.getByRole('button', {name:'Archive', exact:true}).click();
    assert.equal(await page.evaluate(() => window.archiveTestCalls), 1);
    console.log('PASS: visible native archive icon, cancel/Escape, single replay and detached target');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
