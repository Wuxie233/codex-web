const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox']});
 try {
  const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'dark'});
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8214/');
  await page.locator('[contenteditable=true]').first().waitFor({timeout:60000});
  await page.locator('[data-app-shell-sidebar-trigger]').first().tap();
  const list = page.locator('.codex-web-directory-groups');
  await list.locator('[data-workspace-path]').first().waitFor({timeout:60000});
  const select = list.locator('select');
  await page.waitForFunction(() => document.querySelector('.codex-web-directory-groups select')?.options.length > 2, null, {timeout:60000});
  const choices = await select.locator('option').evaluateAll(options=>options.slice(1).map(o=>({value:o.value,path:JSON.parse(o.value)[1]})));
  const choice = choices.find(o=>o.path);
  assert(choice);
  await select.selectOption(choice.value);
  await page.waitForFunction(path => [...document.querySelectorAll('[data-workspace-path]')].every(e=>e.dataset.workspacePath===path),choice.path);
  assert.equal(await list.locator('[data-workspace-path]').count(),1);
  assert((await list.locator('[data-app-action-sidebar-thread-row]').count()) > 0);
  await select.selectOption('');
  assert((await list.locator('[data-workspace-path]').count()) > 1);
  const archive = list.getByRole('button',{name:/^(归档聊天|Archive chat)$/}).first();
  await archive.tap();
  await page.locator('.codex-web-archive-confirm').getByRole('button',{name:/^(取消|Cancel)$/}).tap();
  assert.equal(await page.locator('.codex-web-archive-confirm').count(),0);
  const row = list.locator('[data-app-action-sidebar-thread-row]').first();
  await row.tap({position:{x:30,y:25}});
  await page.waitForFunction(()=>document.querySelector('[data-app-shell-sidebar-trigger]')?.getAttribute('aria-expanded')==='false');
  await page.locator('[contenteditable=true]').first().waitFor();
  assert.equal(await page.locator('[data-app-shell-sidebar-trigger]').first().getAttribute('aria-expanded'),'false');
  console.log('PASS: directory groups, workspace filtering, archive cancellation and original thread navigation');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
