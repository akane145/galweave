// 连接专门启动在临时目录中的 Galweave WebView2。先核验 app_dir，绝不使用个人实例。
/* global window, document -- 仅在 Playwright 页面回调中使用 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const root=process.env.GALWEAVE_DESKTOP_TEST_ROOT;
assert.ok(root,'必须指定隔离的 GALWEAVE_DESKTOP_TEST_ROOT');
const relativeRoot=relative(realpathSync(tmpdir()),realpathSync(root));assert.ok(relativeRoot && !relativeRoot.startsWith('..') && !resolve(root).includes('galweave - 副本'));
const require=createRequire(import.meta.url);const {chromium}=require(process.env.GALNOTE_PLAYWRIGHT||'playwright');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9432');
try{
  const context=browser.contexts()[0];const page=context.pages().find(p=>p.url().includes('tauri.localhost'))||context.pages()[0];
  assert.ok(page,'未找到测试 WebView');
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
  const appDir=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('app_dir'));
  assert.equal(realpathSync(appDir),realpathSync(root),'只允许临时副本应用');
  const vault=join(root,'测试库');mkdirSync(join(vault,'.obsidian'),{recursive:true});
  writeFileSync(join(root,'obsidian-export.json'),JSON.stringify({vault,projects:[]}));
  const script=join(root,'test.ks');writeFileSync(script,'☆0000☆紬☆「待ってた？」\n★0000☆紬☆「等了吗？」\n\n☆0001☆☆彼女は笑った。\n★0001☆☆她笑了。\n');
  await page.locator('#btnProof').waitFor();
  await page.evaluate(path=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'galtrans-drag-drop',payload:[path]}),script);
  await page.locator('textarea.trans').first().waitFor({timeout:12000});
  await page.locator('#btnProof').click();await page.locator('.pr-notes-btn').first().click();
  await page.locator('.pr-notes-type').first().selectOption('suggestion');
  await page.locator('.pr-notes-input').first().fill('我的意见：这里省略的主语是对方。');await page.locator('.pr-notes-input').first().press('Enter');
  await page.locator('textarea.trans').first().fill('你在等我吗？');await page.locator('#btnMissing').click();await page.locator('[data-pv="log"]').click();
  await page.locator('.obsidian-collect').first().click();const modal=page.locator('dialog.obsidian-export');await modal.waitFor();
  assert.equal(await modal.locator('[name="vault"]').inputValue(),vault);
  await modal.locator('[name="project"]').fill('桌面联动测试');await modal.locator('[name="note"]').fill('初次收藏的心得');
  await modal.getByRole('button',{name:'收藏到库',exact:true}).click();await modal.locator('.obsidian-feedback').filter({hasText:'已收藏：'}).waitFor();
  const files=readdirSync(join(vault,'校对案例'));assert.equal(files.length,1);const file=join(vault,'校对案例',files[0]);
  assert.match(readFileSync(file,'utf8'),/初次收藏的心得/);
  let personal=readFileSync(file,'utf8').replace('初次收藏的心得','Obsidian 中的个人补充');writeFileSync(file,personal);
  await modal.getByRole('button',{name:'收藏到库',exact:true}).click();await modal.locator('.obsidian-feedback').filter({hasText:'已有笔记保持原样'}).waitFor();
  assert.equal(readFileSync(file,'utf8'),personal);
  await modal.getByRole('button',{name:'完成',exact:true}).click();
  await page.locator('#btnExportProofReport').click();await page.waitForFunction(()=>!document.getElementById('btnExportProofReport').disabled);
  const reports=readdirSync(join(vault,'校对意见'));assert.equal(reports.length,1);const report=readFileSync(join(vault,'校对意见',reports[0]),'utf8');
  for(const text of ['待ってた？','等了吗？','你在等我吗？','我的意见：这里省略的主语是对方。'])assert.ok(report.includes(text),text);
  if(process.env.GALNOTE_STORE_MODULE){const {Store}=await import(pathToFileURL(process.env.GALNOTE_STORE_MODULE).href);const rows=new Store(vault).list();assert.equal(rows.warnings.length,0);assert.equal(rows.records[0].note,'Obsidian 中的个人补充');}
  await page.screenshot({path:join(root,'desktop-export.png')});
  console.log(JSON.stringify({passed:true,root,vault,caseFile:file,report:join(vault,'校对意见',reports[0])},null,2));
}finally{await browser.close();}
