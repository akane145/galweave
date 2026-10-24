// Galweave 桌面端（Tauri / WebView2）冒烟验证
//
// 为什么需要它：浏览器版验证走 Vite dev server，覆盖不到"真实写回原文件"这条链路。
// 本脚本通过 WebView2 的 CDP 端点驱动真实窗口，验证：
//   1. 共享编辑组四个模式可见、ID 唯一
//   2. 通过生产 drag-drop 事件打开真实文件
//   3. 编辑后「保存原文件」真实落盘（并检查文件内容）
//   4. 「导出记录包」产出可解析的 .galweave.json
//   5. 替换预览在真实 WebView2 中的模态键盘隔离（R2）
//
// 结论分三档，避免"确定失败"被当成通过（R4）：
//   pass    全部检查通过（含导出文件解析有效）—— 退出码 0
//   partial 脚本检查通过，导出项无法判定（没取到文件）—— 退出码 2，需人工确认该单项
//   fail    任一检查失败，或取到的新包内容无效 —— 退出码 1
//
// 前置：
//   1) 先构建：npm run tauri -- build --bundles nsis
//   2) 用调试端口启动（PowerShell）：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
//        .\src-tauri\target\release\galweave.exe
//   3) 运行本脚本：
//        GALWEAVE_SMOKE_DIR="C:\path\to\dir" GALWEAVE_EXPORT_DIR="C:\path\to\dir" node scripts/verify-desktop.mjs
//
// 环境变量：
//   GALWEAVE_CDP_PORT    默认 9223
//   GALWEAVE_SMOKE_DIR   放 smoke.txt 的目录；脚本会创建并写入示例内容
//   GALWEAVE_EXPORT_DIR  记录包导出对话框的默认目录；先手动把一次导出保存到该目录，
//                        对话框才会默认打开它（Windows 保存对话框记住上次位置）
//
// 注意：脚本用 PowerShell 处理原生对话框（AppActivate + SendKeys），仅 Windows 可用；
// 该自动化有时序/焦点竞争，因此"没取到文件"只判 undetermined，不假装成功。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { classifyRun } from './desktop-smoke-result.mjs';

const PORT = Number(process.env.GALWEAVE_CDP_PORT || 9223);
const SMOKE_DIR = process.env.GALWEAVE_SMOKE_DIR;
const EXPORT_DIR = process.env.GALWEAVE_EXPORT_DIR || '';

if (!SMOKE_DIR){ console.error('需要 GALWEAVE_SMOKE_DIR 环境变量（放 smoke.txt 的目录）'); process.exit(2); }
mkdirSync(SMOKE_DIR, { recursive: true });
const SMOKE_FILE = join(SMOKE_DIR, 'smoke.txt');

const SAMPLE = [
  '☆0000☆アリス☆「この物語を、もう一度。」',
  '',
  '☆0001☆ボブ☆「今日は学校に行きません。」',
  '',
  '☆NAME|2☆沙織',
  '',
  '☆0003☆アリス☆「そうですね。」',
  '',
].join('\r\n');
writeFileSync(SMOKE_FILE, SAMPLE, 'utf8');

const results = {};
const pageErrors = [];
const consoleErrors = [];

const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page){ console.error('未找到页面目标：确认应用已用 --remote-debugging-port 启动'); process.exit(2); }
console.log('目标:', page.url, page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)){
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown'){
    const d = msg.params.exceptionDetails;
    pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error'){
    consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
await send('Runtime.enable');
await send('Page.enable');
await sleep(800);

/* 1. 共享编辑组 */
results.ui = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const modes = {};
  for (const m of ['project','translate','glossary','search']){
    document.querySelector('.workspace-nav-item[data-workspace="' + m + '"]').click();
    await sleep(60);
    modes[m] = document.getElementById('btnSaveFile').offsetParent !== null;
  }
  return { modes, saveIdCount: document.querySelectorAll('#btnSaveFile').length };
})()`);
console.log('共享编辑组:', JSON.stringify(results.ui));

/* 2. 打开真实文件（生产 drag-drop 事件） */
results.open = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return { error: '缺少 __TAURI_INTERNALS__（是否运行在 Tauri 窗口？）' };
  await invoke('plugin:event|emit', { event: 'galtrans-drag-drop', payload: [${JSON.stringify(SMOKE_FILE)}] });
  await new Promise(r => setTimeout(r, 1800));
  return { fname: document.getElementById('fname').textContent, rows: document.querySelectorAll('.para').length };
})()`);
console.log('打开文件:', JSON.stringify(results.open));

/* 3. 编辑并保存回原文件（轮询等待写出结束，不用固定 sleep 赌时序） */
results.save = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const ta = document.querySelector('.para textarea.trans');
  if (!ta) return { error: '没有可编辑行' };
  ta.focus();
  ta.value = '【冒烟】将这个故事，再讲一次。';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  document.getElementById('btnSaveFile').click();
  // 写盘 + 指纹更新是异步的；轮询到状态不再是"保存中…"为止（上限 15 秒）
  const t0 = Date.now();
  let state = '';
  while (Date.now() - t0 < 15000){
    await sleep(250);
    state = document.getElementById('headerSaveState').textContent;
    if (state && state !== '保存中…') break;
  }
  return { headerAfter: state, toast: document.getElementById('toast').textContent };
})()`);
const onDisk = existsSync(SMOKE_FILE) ? readFileSync(SMOKE_FILE, 'utf8') : '';
results.save.inFile = onDisk.includes('【冒烟】');
results.save.fileHead = onDisk.slice(0, 120);
console.log('保存回写:', JSON.stringify(results.save));

/* 4. 记录包导出（原生保存对话框：AppActivate 聚焦窗口后回车接受默认路径）
 *
 * ⚠️ Windows 保存对话框会记住上次使用的目录，应用不控制它；原生对话框的
 * 自动化（AppActivate + SendKeys）本身有环境依赖，不保证在每台机器上成功。
 * 因此本步骤的判定分两级，并在结果里如实标注：
 *   - 在 GALWEAVE_EXPORT_DIR 找到并成功解析新包 → valid=true（强证据）
 *   - 仅 toast 报告导出完成 → confirmedByToast=true（流程跑完，文件落在别处）
 *   - 两者都没有 → export 记为 manual（不谎报通过，脚本整体仍可按其余项判定）
 * 想拿到确定性路径：先手动把一次导出保存到目标目录，之后运行即会默认打开那里。 */
if (EXPORT_DIR){
  const packs = () => readdirSync(EXPORT_DIR).filter(f => f.endsWith('.galweave.json'));
  const before = new Set(packs());
  const focusAndAccept = (delayMs, times = 2) => spawn('powershell.exe', ['-NoProfile', '-Command',
    "Add-Type -AssemblyName Microsoft.VisualBasic;" +
    "$p = Get-Process galweave -ErrorAction SilentlyContinue | Select-Object -First 1;" +
    "if ($p) { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) };" +
    `Start-Sleep -Milliseconds ${delayMs};` +
    "$w = New-Object -ComObject wscript.shell;" +
    `for ($i = 0; $i -lt ${times}; $i++) { $w.SendKeys('{ENTER}'); Start-Sleep -Milliseconds 900 }`],
    { detached: true, stdio: 'ignore' }).unref();
  await evaluate(`(async () => { document.getElementById('btnExportRecordPack').click(); return true; })()`);
  // 原生对话框 + 大文件写盘可能超出任何固定等待；轮询目标目录直到出现新包（上限 35 秒）。
  // 只要出现就立刻解析，避免"文件落盘比检查晚一步"造成的假阴性。
  let fresh = [];
  const t0 = Date.now();
  focusAndAccept(2800);
  while (Date.now() - t0 < 35000){
    await sleep(700);
    fresh = packs().filter(f => !before.has(f));
    if (fresh.length) break;
  }
  if (!fresh.length){
    focusAndAccept(1800);
    await sleep(5000);
    fresh = packs().filter(f => !before.has(f));
  }
  results.export = { fresh, toast: await evaluate(`document.getElementById('toast').textContent`) };
  results.export.confirmedByToast = /已导出当前脚本及记录/.test(results.export.toast);
  // 三种结果分开判定，互不覆盖（R4）：
  //   verified      取到新文件且解析/结构有效
  //   failed        取到新文件但内容无效（JSON 坏 / 不是记录包）—— 确定失败，即使 toast 说成功
  //   undetermined  没取到文件：无法判定（可能是对话框没被自动确认），标为待人工确认
  if (fresh.length){
    const raw = readFileSync(join(EXPORT_DIR, fresh[0]), 'utf8');
    try {
      const d = JSON.parse(raw);
      results.export.parsed = { type: d.type, version: d.version, doc: d.document?.name, rows: d.document?.rows?.length };
      results.export.valid = d.type === 'galweave-record-pack' && Array.isArray(d.document?.rows);
    } catch (e){ results.export.valid = false; results.export.error = String(e.message); }
    results.export.outcome = results.export.valid ? 'verified' : 'failed';
    if (!results.export.valid) console.log('记录包导出: 取到新文件但内容无效 —— 该项判定为失败（不因 toast 报成功而放行）。');
    rmSync(join(EXPORT_DIR, fresh[0])); // 冒烟产物不留存
  } else {
    results.export.outcome = 'undetermined';
    console.log('记录包导出: 未在等待窗口内取到新文件 —— 导出项无法判定，需人工确认（不计入通过，整体按部分验收）。');
  }
  console.log('记录包导出:', JSON.stringify(results.export));
} else {
  console.log('记录包导出: 跳过（未设置 GALWEAVE_EXPORT_DIR）');
}

/* 5. R2：替换预览的模态键盘隔离 */
results.modalGuard = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('.workspace-nav-item[data-workspace="search"]').click();
  await sleep(150);
  const ta = document.querySelector('.para textarea.trans');
  ta.focus();
  ta.value = '今天不去学校。';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  document.getElementById('q').value = '学校';
  document.getElementById('r').value = '学园';
  document.getElementById('scope').value = 'trans';
  document.getElementById('btnReplaceAll').click();
  await sleep(800);
  const m = document.querySelector('.modal-mask.show .replace-preview');
  if (!m) return { error: '预览未打开' };
  const press = (o) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles:true, cancelable:true }, o)));
  press({ key: 'z', ctrlKey: true });
  await sleep(300);
  const afterZ = { focusInside: m.contains(document.activeElement), open: !!document.querySelector('.modal-mask.show .replace-preview') };
  press({ key: 'f', ctrlKey: true });
  await sleep(250);
  const afterF = { focusInside: m.contains(document.activeElement), focusId: document.activeElement.id };
  m.parentElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(400);
  return { opened: true, afterZ, afterF, closed: !document.querySelector('.modal-mask.show .replace-preview') };
})()`);
console.log('模态键盘隔离:', JSON.stringify(results.modalGuard));

results.errors = { pageErrors, consoleErrors };
console.log('页面错误:', JSON.stringify(pageErrors), '控制台错误:', JSON.stringify(consoleErrors));

// 三档整体结论（R4：不允许"确定失败"被记成通过）。
// 判定逻辑抽在 desktop-smoke-result.mjs（纯逻辑、有单测）：
//   pass    所有检查通过，且导出（若要求）已取得强证据
//   partial 脚本检查通过，但导出项无法判定（缺文件）→ 明确为部分验收
//   fail    任一硬检查失败，或取到的导出文件无效
const verdict = classifyRun({
  ui: results.ui,
  open: results.open,
  save: results.save,
  modalGuard: results.modalGuard,
  exportResult: results.export,
  exportDirSet: !!EXPORT_DIR,
  pageErrors,
});
const { status, failed } = verdict;

console.log('\n检查明细:', JSON.stringify(verdict));
if (status === 'pass') console.log('桌面冒烟通过。');
else if (status === 'partial') console.log('桌面冒烟部分通过：脚本检查全部通过，但记录包导出项无法自动判定，需人工确认该单项。');
else console.log('桌面冒烟未通过，失败项:', failed.join(', '));

results.status = status;
results.checks = verdict.checks;
results.exportOutcome = verdict.exportOutcome;
ws.close();
process.exit(status === 'pass' ? 0 : status === 'partial' ? 2 : 1);
