const {chromium}=require(process.env.GALWEAVE_PLAYWRIGHT || 'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
await page.goto(process.env.GALWEAVE_TEST_URL || 'http://127.0.0.1:1420/');
await page.locator('#btnCommandPanel').click();await page.locator('#btnParseSet').click();
await page.locator('#recogSrcPaste').check();
const raw='#指令\r\nS[1] 原文一\r\nT[1] 旧译一\r\nS[2] 原文二\r\nT[2] 旧译二\r\n';
await page.locator('#recogText').fill(raw);
await page.locator('#of-name').fill('我的离线格式');
await page.locator('#of-source').fill('S[1] 原文');
await page.locator('#of-source').press('Home');await page.locator('#of-source').press('ArrowRight');await page.locator('#of-source').press('ArrowRight');await page.locator('#of-source').press('Shift+ArrowRight');await page.locator('[data-of-mark="source:id"]').click();
await page.locator('#of-source').press('End');await page.locator('#of-source').press('Shift+ArrowLeft');await page.locator('#of-source').press('Shift+ArrowLeft');await page.locator('[data-of-mark="source:text"]').click();assert.equal(await page.locator('#of-source').inputValue(),'S[{id}] {text}');await page.locator('#of-target').fill('T[{id}] {text}');
await page.locator('#of-pairing').selectOption('id');await page.locator('#of-ignore').fill('#');
await page.locator('#of-preview').click();assert.match(await page.locator('#of-report').innerText(),/2 条原译文，0 个错误，0 行未识别/);
await page.locator('#of-save').click();assert.match(await page.locator('#of-report').innerText(),/档案已保存/);
await page.locator('#of-preview').click();
await page.locator('#of-load').click();await page.locator('#setModal').waitFor({state:'hidden'});
assert.equal(await page.locator('textarea.trans').count(),2);await page.locator('textarea.trans').first().fill('新的译文');
await page.locator('#exportFormat').selectOption('original');
const downloadPromise=page.waitForEvent('download');await page.locator('#btnSave').click();const download=await downloadPromise;
const out=fs.readFileSync(await download.path(),'utf8');assert.equal(out,raw.replace(/\r\n/g,'\n').replace('旧译一','新的译文'));
await page.reload();await page.locator('#fileInput').setInputFiles({name:'saved-format.txt',mimeType:'text/plain',buffer:Buffer.from(raw)});
await page.locator('textarea.trans').first().waitFor();assert.equal(await page.locator('textarea.trans').count(),2);assert.equal(await page.locator('textarea.trans').first().inputValue(),'旧译一');
assert.deepEqual(errors,[]);console.log('PASS: 离线档案预览、保存、载入、编辑后原格式导出、刷新后自动匹配，无运行异常');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});



