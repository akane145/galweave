// 实际导入、编辑、收藏、下载与译间兼容验证。测试文件只写系统临时目录。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.GALNOTE_PLAYWRIGHT || 'playwright');
const root = mkdtempSync(join(tmpdir(),'galweave-obsidian-browser-'));
const browser = await chromium.launch({channel:'chrome',headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page = await context.newPage(); const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('dialog',dialog=>dialog.accept());
try {
  await page.goto(process.env.GALWEAVE_TEST_URL || 'http://127.0.0.1:1421/');
  await page.locator('#fileInput').setInputFiles({name:'obsidian-smoke.ks',mimeType:'text/plain',buffer:Buffer.from('☆0000☆紬☆「待ってた？」\n★0000☆紬☆「等了吗？」\n☆0001☆☆彼女は笑った。\n★0001☆☆她笑了。\n')});
  await page.locator('textarea.trans').first().waitFor();
  await page.locator('#btnProof').click();
  await page.locator('.pr-notes-btn').first().click();
  await page.locator('.pr-notes-type').first().selectOption('suggestion');
  await page.locator('.pr-notes-input').first().fill('这里省略的主语是对方，需要保留疑问语气。');
  await page.locator('.pr-notes-input').first().press('Enter');
  await page.locator('textarea.trans').first().fill('你在等我？');
  await page.locator('#btnMissing').click();
  await page.locator('[data-pv="log"]').click();
  await page.locator('.obsidian-collect').first().waitFor({timeout:3500});
  assert.match(await page.locator('#pv-log').innerText(),/等了吗/);
  await page.locator('.obsidian-collect').first().click();
  const modal=page.locator('dialog.obsidian-export'); await modal.waitFor();
  assert.equal(await modal.locator('[name="before"]').inputValue(),'「等了吗？」');
  assert.equal(await modal.locator('[name="after"]').inputValue(),'「你在等我？」');
  await modal.locator('[name="project"]').fill('联动测试作品');
  await modal.locator('[name="route"]').fill('共通线');
  await modal.locator('[name="note"]').fill('根据上句判断，这里询问的是对方是否在等自己。\n```\n保留围栏字符。');
  await modal.locator('[name="tags"]').fill('主语判断，人物口吻');
  await modal.locator('[name="status"]').selectOption('confirmed');
  await modal.locator('[name="note"]').press('Control+z'); // 原生撤销不能触发脚本撤销。
  assert.equal(await page.locator('textarea.trans').first().inputValue(),'你在等我？');
  await modal.locator('[name="note"]').fill('人工确认的心得\n```\n保留围栏字符。');
  await modal.locator('[name="tags"]').fill('主语判断，人物口吻');
  await modal.getByRole('button',{name:'收藏到库',exact:true}).click();
  await modal.locator('.obsidian-feedback').filter({hasText:'授权'}).waitFor();
  assert.equal(await modal.locator('[name="note"]').inputValue(),'人工确认的心得\n```\n保留围栏字符。');
  const downloadEvent=page.waitForEvent('download');
  await modal.getByRole('button',{name:'下载 Markdown',exact:true}).click(); const download=await downloadEvent;
  const downloaded=join(root,download.suggestedFilename()); await download.saveAs(downloaded);
  const markdown=readFileSync(downloaded,'utf8'); assert.match(markdown,/galnote: 1/);assert.match(markdown,/人工确认的心得/);
  if(process.env.GALNOTE_STORE_MODULE){
    const {Store}=await import(pathToFileURL(process.env.GALNOTE_STORE_MODULE).href);const store=new Store(join(root,'vault'));
    writeFileSync(join(root,'vault','校对案例',download.suggestedFilename()),markdown);
    const list=store.list(); assert.equal(list.warnings.length,0); assert.equal(list.records.length,1);
    assert.equal(list.records[0].before,'「等了吗？」');assert.equal(list.records[0].project,'联动测试作品');
    assert.equal(list.records[0].status,'confirmed');assert.deepEqual(list.records[0].tags,['主语判断','人物口吻']);
    const edited=store.save({...list.records[0],note:'从译间补充心得'});assert.equal(edited.note,'从译间补充心得');
  }
  await page.screenshot({path:join(root,'obsidian-preview.png'),fullPage:true});
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.obsidian-collect').first().click();await modal.waitFor();
  assert.equal(await modal.locator('[name="project"]').inputValue(),'联动测试作品');
  assert.equal(await modal.locator('[name="route"]').inputValue(),'共通线');
  const againEvent=page.waitForEvent('download');await modal.getByRole('button',{name:'下载 Markdown',exact:true}).click();
  assert.equal((await againEvent).suggestedFilename(),download.suggestedFilename());
  await modal.getByRole('button',{name:'取消',exact:true}).click();await modal.waitFor({state:'detached'});
  assert.equal(await page.locator('textarea.trans').first().inputValue(),'你在等我？');
  const reportEvent=page.waitForEvent('download');
  await page.locator('#btnExportProofReport').click();const reportDownload=await reportEvent;
  const reportPath=join(root,reportDownload.suggestedFilename());await reportDownload.saveAs(reportPath);
  const reportText=readFileSync(reportPath,'utf8');
  for(const text of ['日文原文','修改前的译文','当前修改后的译文','我的修改意见','待ってた？','等了吗？','你在等我？','这里省略的主语是对方'])assert.ok(reportText.includes(text),text);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,root,download:downloaded,report:reportPath,browserErrors:errors},null,2));
} finally {await browser.close();}
