// main.js — 应用入口 / 模块编排
// 职责: 初始化各模块,绑定事件,编排 导入/导出/保存/搜索/术语表/机翻/文件夹 流程。

import { parseFile, buildExport, transValue, stripBrackets, setParseConf, getParseConf, parsePrefix, migrateNameTranslations as migrateNameTranslationsPure, mergeSavedState } from './parsers.js';
import { loadSettings, saveSettings, loadBackground, saveBackground, clearBackground, loadFontSettings, saveFontSettings, loadThemeMode, saveThemeMode, loadFavorites, saveFavorites } from './settings.js';
import * as theme from './theme.js';
import * as model from './model.js';
import * as rdr from './renderer.js';
import * as s from './search.js';
import * as wkr from './workers-client.js';
import * as dbx from './db.js';
import { debounce } from './debounce.js';
import * as fsx from './fs.js';
import * as gloss from './glossary.js';
import * as mt from './mt.js';
import { detect as recogDetect, canonicalize as recogCanonicalize, renderReport, analyzeWithParsers, restore as recogRestore } from './recognize.js';
import * as proof from './proof.js';
import * as dictx from './dict.js';
import { createMdxProvider, createPathMdxProvider, createTauriMdd, mimeFromExt, srcToResourceKey, isMddResourceSrc, linkTarget } from './mdx.js';
import * as mdx from './mdx.js';
import * as suggest from './suggest.js';
import * as snips from './snippets.js';
import { parseCsv, toGlossary, fromGlossary } from './csv.js';

/* ---------------- 状态 ---------------- */

let matches = [];
let matchIndex = -1;
let glossData = null;   // { names, terms }
let snippetData = { global: {}, project: {}, merged: {} }; // 快捷片段(merged 供输入建议)
let dictSettings = null;                                   // settings.dict(词典源配置)
const sessionDictEntries = new Map(); // 浏览器版会话内 JSON 词典词条: 源 id -> entries
const mdxProviders = new Map();      // 会话内 MDX 词典 Provider: 源 id -> provider(含 dispose)
const sourceMdd = new Map();         // 词典源 name -> MDD 资源 provider(词条内图片/发音用)
let lastPush = {};      // 撤销快照合并计时

const $q = document.getElementById('q');
const $r = document.getElementById('r');
const $scope = document.getElementById('scope');
const $mcase = document.getElementById('mcase');
const $mcount = document.getElementById('mcount');
const $mtProvider = document.getElementById('mtProvider');

/* ---------------- 撤销快照辅助 ---------------- */

function pushUndoFor(i){
  const now = Date.now();
  if (lastPush[i] && now - lastPush[i] < 800) return;
  model.pushUndo([i]);
  lastPush[i] = now;
}
function clearPushTimers(){ lastPush = {}; }

function pushUndoAll(){
  const paras = model.getParas();
  model.pushUndo(paras.map((_, i) => i));
  clearPushTimers();
}

/* ---------------- 渲染器状态注入 ---------------- */

rdr.setRendererState({
  paras: model.getParas,
  matches: () => matches,
  matchIndex: () => matchIndex,
  q: () => $q.value,
  scope: () => $scope.value,
  terms: () => (glossData ? glossData.terms : {}),
  rowIssueKind: (i) => proof.analyzeRow(model.getPara(i)),
  onTermClick: insertTerm,
  // 输入建议(术语/片段)与划词查词
  getSuggestions: (token) => suggest.matchSuggestions(token, glossData ? glossData.terms : {}, snippetData.merged),
  onSuggestionApply: applySuggestion,
  onDictLookup: dictLookupFromSelection,
  onNameInput: nameInputHandler,
  onTransInput: transInputHandler,
  onFocusRow: () => {},
  onUndoState: updateUndoButtons,
  onMTState: updateMTButtons,
  // 校对模式钩子
  proofEnabled: proof.isEnabled,
  filterShowRow: proof.rowPassesFilter,
  onProofStatus: (i, st) => {
    if (st === 'approved') proof.toggleApprove(i);
    else proof.toggleIssue(i);
    updateProgress();
  },
  onProofAnnoAdd: (i, type, text) => {
    proof.addAnnotation(i, type, text);
    showToast('✅ 已添加批注');
  },
  onProofAnnoResolve: (i, id) => proof.resolveAnnotation(i, id),
  onProofAnnoDelete: (i, id) => proof.deleteAnnotation(i, id),
  onProofSessionEnd: (i) => proof.settleInput(i),
});
proof.setProofUI({ refreshRow: rdr.refreshRow, refreshAll: rdr.refreshAllRows, refreshUI: refreshProofUI });

/* ---------------- 主题 / 字体 / 背景 ---------------- */

const THEME_KEY = 'galtrans_theme'; // 旧版 localStorage 键(首次启动一次性迁移)

let currentMode = 'dark';
let currentFonts = null; // { orig:{family,size,color}, trans:{...} },null=未设置

/** 应用主题模式(深色/浅色/黑白)到 DOM */
function applyTheme(mode){
  currentMode = theme.normalizeThemeMode(mode);
  document.documentElement.setAttribute('data-theme', currentMode);
  document.body.classList.toggle('theme-bw', currentMode === 'bw');
  const btn = document.getElementById('btnTheme');
  if (btn) btn.textContent = theme.themeButtonIcon(currentMode);
}

/** 应用字体设置到 CSS 变量(仅用户设置项覆盖,其余跟随主题) */
function applyFonts(font){
  currentFonts = theme.mergeFontSettings(font);
  const set = (prefix, g) => {
    const el = document.documentElement;
    el.style.setProperty('--' + prefix + '-font-family', g.family || '');
    el.style.setProperty('--' + prefix + '-font-size', g.size ? (g.size + 'px') : '');
    el.style.setProperty('--' + prefix + '-font-color', g.color || '');
  };
  set('orig', currentFonts.orig);
  set('trans', currentFonts.trans);
}

/** 统一应用外观(主题模式 + 字体 + 背景),启动时调用 */
async function applyAppearance(){
  // 旧版 localStorage 主题一次性迁移到 settings.ui.mode
  let mode = await loadThemeMode();
  if (!mode){
    let legacy = null;
    try { legacy = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (legacy){
      mode = theme.normalizeThemeMode(legacy === 'light' ? 'light' : 'dark');
      await saveThemeMode(mode);
      try { localStorage.removeItem(THEME_KEY); } catch (e) {}
    }
  }
  applyTheme(mode || 'dark');
  applyFonts(await loadFontSettings());
  const bg = await loadBackground();
  applyBackground(bg.dataUrl, bg.opacity, bg.fit);
}

/** 快速切换按钮: 深色→浅色→黑白→深色 循环 */
async function toggleTheme(){
  const next = theme.nextThemeMode(currentMode);
  applyTheme(next);
  await saveThemeMode(next);
}

/* ---------------- 字体设置(主题弹窗内) ---------------- */

function colorToHex(v){
  const c = String(v || '');
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '#000000';
}

function syncFontUI(font){
  const f = theme.mergeFontSettings(font);
  document.getElementById('foFamily').value = f.orig.family;
  document.getElementById('foSize').value = String(f.orig.size);
  document.getElementById('foColor').value = colorToHex(f.orig.color || getComputedStyle(document.documentElement).getPropertyValue('--orig-text').trim() || '#aeb9c9');
  document.getElementById('ftFamily').value = f.trans.family;
  document.getElementById('ftSize').value = String(f.trans.size);
  document.getElementById('ftColor').value = colorToHex(f.trans.color || getComputedStyle(document.documentElement).getPropertyValue('--trans-text').trim() || '#e6edf7');
}

function readFontFromUI(){
  return {
    orig: {
      family: document.getElementById('foFamily').value.trim(),
      size: Number(document.getElementById('foSize').value) || 17,
      color: document.getElementById('foColor').value,
    },
    trans: {
      family: document.getElementById('ftFamily').value.trim(),
      size: Number(document.getElementById('ftSize').value) || 17,
      color: document.getElementById('ftColor').value,
    },
  };
}

function resetOrigFont(){
  syncFontUI({ ...currentFonts, orig: { family: '', size: 17, color: '' } });
  previewFontFromUI();
}
function resetTransFont(){
  syncFontUI({ ...currentFonts, trans: { family: '', size: 17, color: '' } });
  previewFontFromUI();
}

/** 实时预览: 字体/字号/颜色变化立即应用到正文(不落盘,取消弹窗时由 applyAppearance 还原) */
function previewFontFromUI(){
  applyFonts(readFontFromUI());
}

/* ---------------- 进度 / 撤销按钮 / 统计 ---------------- */

function updateProgress(){ rdr.updateProgress(); updateStats(); }

// 字数统计: 总字符 / 已翻译字符 / 完成百分比(基于译文字符数)
function updateStats(){
  const paras = model.getParas();
  const el = document.getElementById('stats');
  if (!paras.length){ el.textContent = ''; return; }
  let total = 0, translated = 0;
  for (const p of paras){
    if (p.isName) continue; // NAME 条目不计数
    const len = (p.content || '').length;
    total += len;
    if (p.done) translated += (p.translation || '').length;
  }
  const pct = total ? Math.round(translated / total * 100) : 0;
  el.textContent = '　' + translated.toLocaleString() + ' / ' + total.toLocaleString() + ' 字符（' + pct + '%）';
}

function updateUndoButtons(){
  document.getElementById('btnUndo').disabled = !model.canUndo();
  document.getElementById('btnRedo').disabled = !model.canRedo();
}

function updateMTButtons(){
  const p = mt.getProvider($mtProvider.value);
  const ok = !!(p && p.isConfigured());
  document.getElementById('btnMT').disabled = !ok;
  document.getElementById('btnMTBatch').disabled = !ok;
}

/* ---------------- 编辑事件 ---------------- */

function nameInputHandler(i, value){
  const p = model.getPara(i);
  if (!p) return;
  pushUndoFor(i);
  p.nameTr = value;
  if (p.isName) model.recalcDone(p);
  model.scheduleAutosave();
  // 新翻译的人名自动沉淀进人名表(并保存,否则只在内存里,重开软件就丢)
  const added = gloss.recordNameIfNew(glossData.names, p.name, value.trim());
  if (added){
    renderGlossTables();
    persistGloss();
  }
  proof.noteInput(i); // 校对模式: 记录整句改动(1200ms 结算)
  rdr.refreshRow(i);
  updateProgress();
  if (_synced) wkr.syncSearchShadow({ changes: [{ i, nameTr: value }] });
}

function transInputHandler(i, value){
  const p = model.getPara(i);
  if (!p) return;
  pushUndoFor(i);
  if (p.isName){
    // NAME 条目: 正文即名字。输入直接作为译名写入 nameTr(防呆:textarea 已隐藏,
    // 兜底历史误输入),译文正文保持为空。
    p.nameTr = value;
    model.recalcDone(p);
    if (p.nameTr && p.nameTr !== p.name) gloss.recordNameIfNew(glossData.names, p.name, p.nameTr);
  } else {
    p.translation = p.brackets ? ('「' + value + '」') : value;
    model.recalcDone(p);
  }
  model.scheduleAutosave();
  proof.noteInput(i); // 校对模式: 记录整句改动(1200ms 结算)
  rdr.refreshRow(i);
  updateProgress();
  if (_synced) wkr.syncSearchShadow({ changes: [{ i, translation: p.translation, nameTr: p.nameTr }] });
}

/** 词条点击: 把术语译文插入该行译文末尾 */
function insertTerm(i, dst){
  if (!dst) return;
  const p = model.getPara(i);
  if (!p) return;
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  model.pushUndo([i]);
  clearPushTimers();
  const tv = transValue(p);
  const newMid = tv + dst;
  p.translation = p.brackets ? ('「' + newMid + '」') : newMid;
  model.recalcDone(p);
  if (snap) proof.recordDiff(snap, 'edit');
  model.scheduleAutosave();
  rdr.refreshRow(i);
  updateProgress();
  const r = rdr.getRow(i);
  if (r){ r.trans.focus(); r.trans.setSelectionRange(newMid.length, newMid.length); }
}

/* ---------------- 搜索 / 替换 / 跳转 ---------------- */

// 搜索匹配 worker 化(异步) + debounce:输入框每次按键不再同步全段扫整篇
// 同时归零 recomputeMatchesUI 的 O(n) name-width 重算副作用:搜索刷新只对已挂载行施高亮,
// glossary/filter 等结构性变更仍走 refreshAllRows。
let matchesScheduled = false;
let matchesRequestId = 0; // 取消过期请求(并发防止乱序)

const debouncedRecompute = debounce(() => {
  const req = ++matchesRequestId;
  const q = $q.value, scope = $scope.value, cs = $mcase.checked;
  wkr.searchComputeMatches(model.getParas(), q, scope, cs).then((ms) => {
    if (req !== matchesRequestId) return; // 已被新请求取代
    matches = Array.isArray(ms) ? ms : [];
    matchIndex = matches.length ? 0 : -1;
    rdr.updateMatchInfo(matches, matchIndex, q);
    rdr.applyRowMatchClasses(matches, matchIndex);
    // 同步重渲染原文 HTML: mark/term 高亮内联在 .orig,仅切行类不会让残留高亮消失
    if (!matches.length){
      rdr.renderWindow(true); // 清空搜索 → 重挂载可见窗口,移除全部残留 mark
    } else {
      const seen = new Set();
      for (const m of matches){
        if (!seen.has(m.i)){ seen.add(m.i); rdr.refreshRow(m.i); }
      }
    }
    matchesScheduled = false;
  }).catch(e => { matchesScheduled = false; console.error('[search] worker 失败,回退:', e); });
}, 180);

let _synced = false;

function recomputeMatchesUI(forceFull){
  // 第一次或显式 forceFull → 全量同步影子给 worker;否则依赖 transInputHandler 已维护增量
  if (!_synced || forceFull){ _synced = true; wkr.syncSearchShadow({ full: model.getParas() }); }
  if (matchesScheduled){ debouncedRecompute.flush(); return; }
  matchesScheduled = true;
  debouncedRecompute();
}

/** 仅把当前 matches 状态刷到 UI 高亮,不算匹配(供同步替换后立即消费 matches 的场合) */
function rerMatchesUI_applyUI(){
  rdr.updateMatchInfo(matches, matchIndex, $q.value);
  rdr.applyRowMatchClasses(matches, matchIndex);
  rdr.renderWindow(true); // 同步重渲染行内 mark(matches 变化后残留高亮需清除)
}

function gotoMatch(delta){
  if (!matches.length) return;
  matchIndex = (matchIndex + delta + matches.length) % matches.length;
  const m = matches[matchIndex];
  rdr.scrollRowIntoView(m.i);
  rdr.renderWindow(true);
  rdr.applyRowMatchClasses(matches, matchIndex);
  rdr.updateMatchInfo(matches, matchIndex, $q.value);
  const r = rdr.getRow(m.i);
  if (!r) return;
  if (m.col === 'name'){
    r.nameInput.focus();
    r.nameInput.setSelectionRange(m.from, m.to);
  } else {
    r.trans.focus();
    if (m.col === 'trans'){
      const p = model.getPara(m.i);
      const off = p.brackets ? 1 : 0;
      r.trans.setSelectionRange(Math.max(0, m.from - off), Math.max(0, m.to - off));
    } else {
      r.trans.setSelectionRange(r.trans.value.length, r.trans.value.length);
    }
  }
}

function replaceCurrent(){
  if (matchIndex < 0 || !matches.length){ alert('没有可替换的匹配。'); return; }
  const m = matches[matchIndex];
  if (m.col === 'orig'){ alert('当前匹配位于原文中,替换仅作用于译文与名字。'); return; }
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  model.pushUndo([m.i]);
  clearPushTimers();
  const p = model.getPara(m.i);
  const ok = s.replaceOnce(p, m, $r.value);
  if (!ok) return;
  if (snap) proof.recordDiff(snap, 'batch');
  model.scheduleAutosave();
  rdr.refreshRow(m.i); // 数据已写回 model,刷新该行 DOM
  const oldRow = m.i, oldFrom = m.from;
  // 替换单条后立刻重算匹配,需同步得到结果以推进光标 → 走 search.js 直通
  matches = s.computeMatches(model.getParas(), $q.value, $scope.value, $mcase.checked);
  matchIndex = matches.length ? 0 : -1;
  rerMatchesUI_applyUI();
  let next = matches.findIndex(x => x.i > oldRow || (x.i === oldRow && x.from >= oldFrom));
  matchIndex = next === -1 ? 0 : next;
  gotoMatch(0);
}

async function replaceAll(){
  const q = $q.value;
  if (q === '' || $scope.value === 'orig'){
    alert('请先输入查找内容,并确保搜索范围不是「仅原文」。');
    return;
  }
  const rep = $r.value;
  const sc = $scope.value;
  const cs = $mcase.checked;
  // 让 count 走 worker,避免主线程全扫
  if (!_synced){ _synced = true; wkr.syncSearchShadow({ full: model.getParas() }); }
  let grand = 0, nameTotal = 0;
  try {
    const c = await wkr.searchCountMatches(q, sc, cs);
    grand = (c && c.total) || 0; nameTotal = (c && c.nameTotal) || 0;
    grand += nameTotal;
  } catch (e){
    const c = s.countMatches(model.getParas(), q, sc, cs);
    grand = c.total + c.nameTotal;
  }
  if (grand === 0){ alert('没有找到可替换的匹配。'); return; }
  const label = (sc === 'name') ? '名字' : '译文';
  if (!confirm('将替换 ' + label + ' ' + grand + ' 处\n“' + q + '” → “' + rep + '”\n确定继续?')) return;

  // 双轨:worker 算 deltas 前先用本地扫描生成 affected(供撤销),再用 deltas 写回 model
  const paras = model.getParas();
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  const affected = [];
  const replaceTrans = (sc === 'all' || sc === 'trans');
  const replaceName = (sc === 'name');
  paras.forEach((p, i) => {
    if (replaceTrans && s.findIdx(p.translation, q, 0, cs) !== -1) affected.push(i);
    if (replaceName && s.findIdx(p.nameTr, q, 0, cs) !== -1 && !affected.includes(i)) affected.push(i);
  });
  model.pushUndo(affected);
  clearPushTimers();

  let r;
  try { r = await wkr.searchReplaceAll(q, rep, sc, cs); }
  catch (e){
    // 降级:worker 不可用时回退到原地
    s.replaceAllInParas(paras, q, rep, sc, cs);
    if (snap) proof.recordDiff(snap, 'batch');
    model.scheduleAutosave();
    rdr.refreshAllRows(); // 数据已写回 model,刷新已挂载行 DOM
    recomputeMatchesUI(true);
    updateProgress();
    alert('已替换 ' + grand + ' 处。');
    return;
  }
  for (const d of (r.deltas || [])){
    const p = paras[d.i]; if (!p) continue;
    p.translation = d.translation; p.nameTr = d.nameTr;
    if (typeof model.recalcDone === 'function') model.recalcDone(p);
  }
  if (snap) proof.recordDiff(snap, 'batch');
  model.scheduleAutosave();
  rdr.refreshAllRows(); // 数据已写回 model,刷新已挂载行 DOM(否则前端不实时显示)
  recomputeMatchesUI(true);
  updateProgress();
  alert('已替换 ' + grand + ' 处。');
}

function jumpToLine(){
  const v = document.getElementById('jumpInput').value.trim();
  if (!v){ alert('请输入要跳转的行号/编号'); return; }
  if (!_synced){ _synced = true; wkr.syncSearchShadow({ full: model.getParas() }); }
  wkr.searchJumpToIndex(v).then(idx => {
    if (idx === -1){ alert('未找到编号为「' + v + '」的行'); return; }
    rdr.scrollRowIntoView(idx);
    rdr.renderWindow(true);
    rdr.focusIdx(idx);
    document.getElementById('jumpInput').value = '';
  }).catch(e => alert('跳转失败: ' + e.message));
}

// 跳到下一个未翻译的行(F2): 从当前行往后找第一个未翻译;到底则从头循环;全翻完提示
function jumpToNextUntranslated(){
  const paras = model.getParas();
  if (!paras.length) return;
  const start = Math.max(0, rdr.getActiveIdx() + 1);
  let idx = -1;
  for (let i = start; i < paras.length; i++){
    if (!paras[i].done){ idx = i; break; }
  }
  if (idx === -1){
    for (let i = 0; i < start; i++){
      if (!paras[i].done){ idx = i; break; }
    }
  }
  if (idx === -1){
    showToast('🎉 全部翻译完成！');
    return;
  }
  rdr.scrollRowIntoView(idx);
  rdr.renderWindow(true);
  rdr.focusIdx(idx);
  // 视觉确认跳转
  const row = rdr.getRow(idx);
  if (row){
    row.el.classList.remove('match-current');
    void row.el.offsetWidth; // 重触发动画
    row.el.classList.add('match-current');
    setTimeout(() => row.el.classList.remove('match-current'), 900);
  }
}

/* ---------------- 全局操作提示 ---------------- */

let toastTimer = null;
function showToast(msg, isError){
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/* ---------------- 导入 / 保存 / 导出 ---------------- */

// NAME 行历史数据迁移: 旧版本可能把名字误存进 translation(NAME 条目不导出,
// 造成"改了不生效");复用 parsers 的纯函数迁移逻辑,再补 UI 层收尾。
function migrateNameTranslations(paras){
  const n = migrateNameTranslationsPure(paras);
  if (n){
    paras.forEach(p => { if (p.isName) model.recalcDone(p); });
    model.scheduleAutosave();
  }
  return n;
}

async function loadSource(file, name){
  const { content } = await fsx.readFileSource(file);
  const parsed = parseFile(content);
  const fname = name || (file.path ? file.path.split(/[\\/]/).pop() : '');
  model.setRawText(content); // 原始文本,供「格式识别」/ 规范化还原
  model.setCanonicalDoc(false); // 普通导入不是规范化文档
  model.setParas(parsed.paras);
  model.setFileInfo({ name: fname, path: file.path || null, nl: parsed.nl, trailingBlank: parsed.trailingBlank });

  // 恢复上次进度: 按完整路径存(旧版本按文件名存,做一次兼容回退)。
  // 关键: 用「合并」而非整体覆盖 —— 文件里已带的译文(★行)优先保留,
  // 缓存进度只补文件未翻译的行,避免陈旧的缓存把已有译文顶成空白。
  const stateKey = file.path || fname;
  let saved = await fsx.savedState(stateKey);
  let legacy = false;
  if (!saved && file.path){
    saved = await fsx.savedState(fname); // 兼容旧版本按文件名存的进度
    legacy = !!saved;
  }
  if (saved && saved.paras && saved.paras.length){
    const n = saved.paras.filter(q => (q.translation || '').trim()).length;
    const where = fsx.isTauri() && file.path ? ('\n（进度文件：' + fsx.progressPathDisplay(file.path) + '）') : '';
    if (confirm('检测到「' + fname + '」的上次翻译进度（' + n + ' 行已翻译），是否恢复？' + where + '\n（文件里已带的译文会优先保留，只补充未翻译的行）')){
      model.setParas(mergeSavedState(parsed.paras, saved.paras));
      model.getParas().forEach(p => model.recalcDone(p));
      if (legacy) await fsx.removeSavedState(fname); // 迁移旧键,此后按新键存取
    }
    // 选择「不恢复」时保留进度文件,之后可用「恢复进度」按钮随时找回;不再删除进度。
  }
  // NAME 行历史数据迁移: 旧版本可能把名字误存进 translation(NAME 条目不导出,
  // 造成"改了不生效"),此处把它转正到 nameTr 并清空误存。
  migrateNameTranslations(model.getParas());

  // 项目术语表: 以文件所在目录为项目,同目录文件共享术语表
  const projDir = file.path ? file.path.replace(/[\\/][^\\/]*$/, '') : null;
  glossData = await gloss.loadGlossaryForProject(projDir);
  renderGlossTables();
  updateGlossProjectLabel();
  initSnippets(); // 快捷片段跟随同一项目目录

  // 人名自动应用
  const applied = gloss.applyNames(model.getParas(), glossData.names);
  if (applied) model.scheduleAutosave();

  document.getElementById('fname').textContent = '当前文件：' + fname + '　编码：' + (file.encoding || 'utf-8')
    + (applied ? '　📖术语已自动应用 ' + applied + ' 个人名' : '');
  await proof.loadForFile(); // 加载该文件的校对数据(批注/状态/修改记录)
  rdr.fullRender();
  recomputeMatchesUI(true); // 新文件载入 → 强制全量同步影子
  rdr.focusIdx(0);
  updateUndoButtons();
  updateProgress(); // 加载后刷新进度 + 字数统计
}

async function importWithPicker(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog();
    if (!res) return;
    await loadSource({ path: res.path }, res.name);
    return;
  }
  // 浏览器: 优先 File System Access 拿句柄(可写回原文件),不支持则普通选择
  const picked = await fsx.pickBrowserFile();
  if (picked){
    await loadSource(picked.file, picked.name);
    return;
  }
  document.getElementById('fileInput').click();
}

// 保存/导出建议文件名: 规范化文档建议 .canonical.txt(避免把 ☆/★ 格式覆盖回原文件),其余用原名
function saveSuggestedName(){
  const f = model.getFilename() || '译文.txt';
  if (!model.isCanonicalDoc()) return f;
  return f.replace(/\.(txt|ks)$/i, '') + '.canonical.txt';
}

async function saveDirect(){
  if (!model.getParas().length){ alert('请先导入文本文件'); return; }
  await proof.flushSave(); // 先落盘校对数据(与源文件保持一致)
  await model.flushAutosave();
  const content = buildExport(model.getParas(), model.getNl(), model.getTrailingBlank());
  try {
    if (fsx.isTauri() && model.getFilePath()){
      await fsx.writeFileSource(model.getFilePath(), content, model.getFilename());
      showToast('✅ 已保存到原文件');
      return;
    }
    if (fsx.isTauri()){
      const res = await fsx.saveFileDialog(saveSuggestedName());
      if (!res) return; // 用户取消,静默
      await fsx.writeFileSource(res.path, content, res.name);
      model.setFileInfo({ ...model.getFilePath() ? { path: res.path } : {}, name: res.name });
      showToast('✅ 已保存到：' + res.path);
      return;
    }
    // 浏览器: 写回原文件句柄 / 另存为 / 下载
    const r = await fsx.writeBrowserFile(content, saveSuggestedName());
    if (r.saved){
      showToast('✅ 已保存到原文件');
    } else if (r.cancelled){
      // 另存为对话框取消,静默
    } else if (r.downloaded){
      showToast('⬇ 已下载译文副本：' + saveSuggestedName());
    } else {
      showToast('✅ 已保存');
    }
  } catch (e){
    showToast('❌ 保存失败：' + (e && e.message ? e.message : e), true);
  }
}

async function exportFile(){
  if (!model.getParas().length){ alert('请先导入文本文件'); return; }
  await proof.flushSave();
  const content = buildExport(model.getParas(), model.getNl(), model.getTrailingBlank());
  const outName = '译文_' + saveSuggestedName();
  try {
    if (fsx.isTauri()){
      const res = await fsx.saveFileDialog(outName);
      if (!res) return; // 取消,静默
      await fsx.writeFileSource(res.path, content, res.name);
      showToast('✅ 已导出译文：' + res.path);
      return;
    }
    fsx.downloadText(content, outName);
    showToast('⬇ 已下载译文：' + outName);
  } catch (e){
    showToast('❌ 导出失败：' + (e && e.message ? e.message : e), true);
  }
}

async function restoreProgress(){
  if (!model.getFilename()){ alert('请先导入文件'); return; }
  const saved = await fsx.savedState(model.getStateKey());
  if (!saved || !saved.paras || !saved.paras.length){
    const where = fsx.isTauri() && model.getFilePath() ? ('（' + fsx.progressPathDisplay(model.getFilePath()) + '）') : '';
    alert('没有找到「' + model.getFilename() + '」的已保存进度' + where);
    return;
  }
  // 与导入恢复一致: 合并而非覆盖 —— 当前文件已有译文优先,只补未翻译的行
  model.setParas(mergeSavedState(model.getParas(), saved.paras));
  model.getParas().forEach(p => model.recalcDone(p));
  rdr.fullRender();
  recomputeMatchesUI(true);
  rdr.focusIdx(0);
  updateProgress(); // 恢复进度后刷新字数统计
}

function clearAll(){
  if (!model.getParas().length) return;
  if (!confirm('确定清空当前文件的全部翻译内容？\n（人名/说话人译名会保留，只清空译文正文）')) return;
  pushUndoAll();
  model.getParas().forEach(p => {
    p.translation = ''; // 只清译文正文;人名(nameTr)保留,清空翻译不连带删人名
    model.recalcDone(p);
  });
  rdr.fullRender();
  recomputeMatchesUI(true);
  updateProgress(); // 清空后刷新进度 + 字数统计
  // 只清空当前界面(内存),不写进度存储、不触发自动保存:
  // 若未按「保存原文件」就关闭,重新导入仍恢复上次保存的翻译进度(可用 Ctrl+Z 撤销本次清空)。
}

// 清除当前文件的已保存进度:删除该文件的进度记录,重新导入完全干净(无恢复提示)
async function clearProgress(){
  if (!model.getFilename()){ alert('请先导入文件'); return; }
  if (!confirm('确定删除「' + model.getFilename() + '」的已保存翻译进度与校对数据？\n重新导入该文件时将全新开始,不会恢复任何内容。')) return;
  await fsx.removeSavedState(model.getStateKey());
  await proof.clearForFile(); // 同时删除该文件的校对数据(批注/状态/修改记录)
  alert('已清除「' + model.getFilename() + '」的已保存进度与校对数据。');
}

/* ---------------- 术语表 UI ---------------- */

// 侧边栏术语面板顶部显示当前术语表归属(项目目录 / 全局)
function updateGlossProjectLabel(){
  const dir = gloss.getProjectDir();
  const el = document.getElementById('glossProjectLabel');
  if (dir){
    el.textContent = '📖 术语表：' + dir + '/glossary.json';
    el.title = '术语表保存位置：' + dir + '/glossary.json';
  } else {
    el.textContent = '📖 全局术语表（未打开文件）';
    el.title = '未打开文件,术语表保存在全局位置';
  }
}

function renderGlossTables(){
  const names = glossData.names, terms = glossData.terms;
  const nt = document.getElementById('nameTable');
  nt.innerHTML = '';
  Object.keys(names).sort((a, b) => a.localeCompare(b, 'ja')).forEach(k => {
    nt.appendChild(glossRow(k, names[k], (key, value) => mutateGloss(() => {
      if (value === '') delete names[key]; else names[key] = value;
    })));
  });
  const tt = document.getElementById('termTable');
  tt.innerHTML = '';
  Object.keys(terms).sort((a, b) => a.localeCompare(b, 'ja')).forEach(k => {
    tt.appendChild(glossRow(k, terms[k], (key, value) => mutateGloss(() => {
      if (value === '') delete terms[key]; else terms[key] = value;
    })));
  });
}

// 术语表变更统一入口: 改数据 → 立即重绘表格(删除/改名/清空译文后行要消失/更新) → 防抖保存 + 刷新翻译行高亮
function mutateGloss(fn){
  fn();
  renderGlossTables();
  persistGloss();
}

function glossRow(src, dst, onUpdate){
  const row = document.createElement('div');
  row.className = 'gloss-row';
  const s1 = document.createElement('input');
  s1.type = 'text'; s1.value = src;
  const s2 = document.createElement('input');
  s2.type = 'text'; s2.value = dst;
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = '删除「' + src + '」';
  del.addEventListener('click', () => {
    if (confirm('删除术语「' + src + '」?')) onUpdate(src, '');
  });
  s1.addEventListener('change', () => {
    const nk = s1.value.trim();
    if (!nk || nk === src) return;
    // 改名: 删除旧键,新建新键(值保留)
    onUpdate(src, '');
    onUpdate(nk, dst);
  });
  s2.addEventListener('change', () => onUpdate(src, s2.value.trim()));
  row.append(s1, s2, del);
  return row;
}

let glossSaveTimer = null;
function persistGloss(){
  if (glossSaveTimer) clearTimeout(glossSaveTimer);
  glossSaveTimer = setTimeout(async () => {
    await gloss.saveGlossaryForProject(glossData);
    rdr.refreshAllRows(); // 词条命中变化
  }, 300);
}

function addGlossEntry(kind){
  const srcId = kind === 'name' ? 'nameAddSrc' : 'termAddSrc';
  const dstId = kind === 'name' ? 'nameAddDst' : 'termAddDst';
  const src = document.getElementById(srcId).value.trim();
  const dst = document.getElementById(dstId).value.trim();
  if (!src || !dst){ alert('请填写原文与译文'); return; }
  const table = kind === 'name' ? glossData.names : glossData.terms;
  table[src] = dst;
  document.getElementById(srcId).value = '';
  document.getElementById(dstId).value = '';
  persistGloss();
  renderGlossTables();
}

/** CSV 术语表导入: 解析→确认→合并进当前术语表(同名覆盖)。返回是否成功。 */
async function importGlossCsvText(text){
  let g;
  try { g = toGlossary(parseCsv(text)); }
  catch (e){ alert('CSV 解析失败: ' + e.message); return false; }
  const nn = Object.keys(g.names).length;
  const tn = Object.keys(g.terms).length;
  if (!nn && !tn){
    alert('CSV 中没有可导入的条目。\n支持: 2 列 = 原文,译文(进词条);3 列 = 类型,原文,译文(名词/人名进人名表,其余进词条);首行表头自动跳过。');
    return false;
  }
  if (!confirm('CSV 解析结果: 人名 ' + nn + ' 条 / 词条 ' + tn + ' 条。\n合并进当前术语表?(同名条目覆盖)')) return false;
  Object.assign(glossData.names, g.names);
  Object.assign(glossData.terms, g.terms);
  await gloss.saveGlossaryForProject(glossData);
  renderGlossTables();
  rdr.refreshAllRows();
  showToast('✅ CSV 已合并: 人名 ' + nn + ' / 词条 ' + tn);
  return true;
}

async function glossImport(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog([{ name: '术语表', extensions: ['json', 'csv'] }]);
    if (!res) return;
    if (/\.csv$/i.test(res.path)){
      await importGlossCsvText(await fsx.readTextFileSource(res.path));
      return;
    }
    let obj;
    try { obj = JSON.parse(await fsx.readTextFileSource(res.path)); } catch (e){ alert('无法解析 JSON: ' + e); return; }
    glossData = { names: obj.names || {}, terms: obj.terms || {} };
    await gloss.saveGlossaryForProject(glossData);
    renderGlossTables();
    rdr.refreshAllRows();
    alert('术语表已导入。');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.csv';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      if (/\.csv$/i.test(f.name)){
        await importGlossCsvText(await f.text());
        return;
      }
      const obj = JSON.parse(await f.text());
      glossData = { names: obj.names || {}, terms: obj.terms || {} };
      await gloss.saveGlossaryForProject(glossData);
      renderGlossTables();
      rdr.refreshAllRows();
      alert('术语表已导入。');
    } catch (e){ alert('无法解析: ' + e); }
  };
  input.click();
}

async function glossExport(){
  const content = JSON.stringify(glossData, null, 2);
  if (fsx.isTauri()){
    const res = await fsx.saveFileDialog('术语表备份.json');
    if (!res) return;
    await fsx.writeFileSource(res.path, content, res.name);
    return;
  }
  fsx.downloadText(content, '术语表备份.json');
}

/** 导出术语表为 CSV(3 列: 类型,原文,译文;Excel 可直接打开) */
async function glossExportCsv(){
  const content = fromGlossary(glossData);
  if (fsx.isTauri()){
    const res = await fsx.saveFileDialog('术语表.csv', null, [{ name: 'CSV', extensions: ['csv'] }]);
    if (!res) return;
    await fsx.writeFileSource(res.path, content, res.name);
    return;
  }
  fsx.downloadText(content, '术语表.csv');
}

async function glossApply(){
  if (!model.getParas().length){ alert('请先导入文本文件'); return; }
  const names = Object.keys(glossData.names).length;
  const terms = Object.keys(glossData.terms).length;
  if (!names && !terms){ alert('术语表为空。'); return; }
  if (!confirm('把术语表应用到当前文件？\n（人名自动填充 ' + names + ' 项 · 词条批量替换译文 ' + terms + ' 项）\n替换前会确认,且不影响原文。')) return;

  pushUndoAll();
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  const n = gloss.applyNames(model.getParas(), glossData.names);
  const { total } = (() => {
    const before = model.getParas().map(p => (p.translation || ''));
    gloss.applyTermsToTranslations(model.getParas(), glossData.terms);
    // 统计实际替换次数
    let c = 0;
    model.getParas().forEach((p, i) => {
      if (before[i] !== (p.translation || '')) c++;
    });
    return { total: c };
  })();
  if (snap) proof.recordDiff(snap, 'batch');
  model.scheduleAutosave();
  rdr.fullRender();
  recomputeMatchesUI(true);
  updateProgress(); // 应用术语表后刷新进度 + 字数统计
  alert('已应用术语表:\n人名自动填充 ' + n + ' 行\n译文批量修正 ' + total + ' 行');
}

/* ================= 词典 / 快捷片段 ================= */

function dictSrcId(){ return 'ds_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 读取 settings.dict(默认无词典源;内置示例词典已移除,旧设置里的 miniEnabled 字段忽略) */
async function ensureDictSettings(){
  // 桌面版: SQLite dict_sources 表为源;首次迁移 settings.json 旧数据
  if (fsx.isTauri()){
    const rows = await dbx.dbListSources();
    if (rows){
      dictSettings = { sources: rows };
      // 首次迁移: 若 SQLite 为空且 settings.json 有旧 sources,搬一次
      if (!rows.length){
        const s = await loadSettings();
        const old = (s.dict && Array.isArray(s.dict.sources)) ? s.dict.sources : [];
        if (old.length){ await dbx.dbMigrateFromSettings(old); dictSettings = { sources: await dbx.dbListSources() || [] }; }
      }
      return dictSettings;
    }
  }
  const s = await loadSettings();
  if (!s.dict || typeof s.dict !== 'object') s.dict = {};
  if (!Array.isArray(s.dict.sources)) s.dict.sources = [];
  dictSettings = s.dict;
  return dictSettings;
}

/** 按设置重建词典 Provider 注册表(停用的源不注册) */
function rebuildDictProviders(){
  dictx.clearProviders();
  for (const src of dictSettings.sources){
    if (src.enabled === false) continue;
    if (src.type === 'json'){
      const mem = sessionDictEntries.get(src.id);
      dictx.registerProvider(dictx.createJsonDictProvider({
        id: src.id, name: src.name,
        path: (!src.session && src.path) || undefined,
        entries: mem || undefined,
      }));
    } else if (src.type === 'http'){
      dictx.registerProvider(dictx.createHttpDictProvider({
        id: src.id, name: src.name,
        urlTemplate: src.urlTemplate, headers: src.headers || {}, map: src.map || {},
      }));
    } else if (src.type === 'mdx'){
      let p = mdxProviders.get(src.id);
      if (!p && src.path){
        // 桌面版: 重启后按记住的路径惰性 mdx_open(Rust 内存映射,首次查询时才解析头部);
        // 浏览器版: 无路径(会话内加载),此时 session 源已在本次会话持有 provider。
        if (fsx.isTauri()){
          p = mdx.createTauriMdxProvider({ id: src.id, name: src.name, path: src.path });
          if (!sourceMdd.has(p.name)) tryPairMdd(p, src.path); // 重启后恢复 MDD 关联(异步)
        } else {
          p = createPathMdxProvider({
            id: src.id, name: src.name,
            loadBuffer: async () => fsx.base64ToArrayBuffer(await fsx.readFileB64(src.path)),
          });
        }
        mdxProviders.set(src.id, p);
      }
      if (p) dictx.registerProvider(p);
    }
  }
}

async function saveDictSettings(){
  // 桌面版: 逐源 upsert 进 SQLite(幂等);HTTP 源的 urlTemplate/map/headers 等存 extra JSON
  if (fsx.isTauri()){
    for (const src of dictSettings.sources){
      const extra = (src.type === 'http')
        ? { urlTemplate: src.urlTemplate, map: src.map || {}, headers: src.headers || {} }
        : (src.extra || undefined);
      await dbx.dbAddSource({ ...src, extra });
    }
    return;
  }
  await saveSettings(await loadSettings()); // dictSettings 即缓存内对象,原位修改后整体落盘
}

function renderDictSourceList(){
  const box = document.getElementById('dictSourceList');
  if (!box) return;
  box.innerHTML = '';
  for (const src of dictSettings.sources) box.appendChild(dictSrcRow(src));
}

function dictSrcRow(src){
  const row = document.createElement('div');
  row.className = 'dict-src-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!src.enabled;
  cb.title = '启用 / 停用';
  cb.addEventListener('change', () => toggleDictSource(src.id, cb.checked));
  const name = document.createElement('span');
  name.className = 'ds-name';
  name.textContent = src.name;
  name.title = src.path || src.urlTemplate || '';
  const type = document.createElement('span');
  type.className = 'ds-type';
  type.textContent = src.type === 'http' ? 'HTTP' : (src.type === 'mdx' ? 'MDX' : 'JSON');
  row.append(cb, name, type);
  if (src.type === 'json' && src.session && !sessionDictEntries.has(src.id)){
    const warn = document.createElement('span');
    warn.className = 'ds-warn';
    warn.textContent = '需重新添加';
    warn.title = '浏览器版不保存文件路径,重新打开应用后需重新添加该词典';
    row.appendChild(warn);
  }
  if (src.type === 'mdx' && !mdxProviders.has(src.id)){
    const warn = document.createElement('span');
    warn.className = 'ds-warn';
    warn.textContent = '需重新添加';
    warn.title = 'MDX 词典为会话内加载,重新打开应用后需重新选择 .mdx 文件';
    row.appendChild(warn);
  }
  if (src.type === 'http'){
    const edit = document.createElement('button');
    edit.className = 'toolbtn secondary';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openDictHttpModal(src));
    row.appendChild(edit);
  }
  if (!src.fixed){
    const del = document.createElement('button');
    del.className = 'toolbtn secondary';
    del.textContent = '✕';
    del.title = '删除该词典源';
    del.addEventListener('click', () => {
      if (!confirm('删除词典源「' + src.name + '」?')) return;
      dictSettings.sources = dictSettings.sources.filter(x => x.id !== src.id);
      sessionDictEntries.delete(src.id);
      const mp = mdxProviders.get(src.id);
      if (mp && mp.dispose) mp.dispose();
      mdxProviders.delete(src.id);
      if (fsx.isTauri()){ dbx.dbRemoveSource(src.id).then(() => { rebuildDictProviders(); renderDictSourceList(); }); }
      else saveDictSettings().then(() => { rebuildDictProviders(); renderDictSourceList(); });
    });
    row.appendChild(del);
  }
  return row;
}

async function toggleDictSource(id, enabled){
  const src = dictSettings.sources.find(x => x.id === id);
  if (src) src.enabled = enabled;
  if (fsx.isTauri()){ await dbx.dbSetEnabled(id, enabled); }
  else await saveDictSettings();
  rebuildDictProviders();
  renderDictSourceList();
}

/** 添加 JSON 词典文件(桌面版记住路径,浏览器版会话内有效) */
async function addJsonDictSource(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog([{ name: 'JSON 词典', extensions: ['json'] }]);
    if (!res) return;
    let raw;
    try { raw = await fsx.readTextFileSource(res.path); }
    catch (e){ alert('无法读取文件: ' + e.message); return; }
    await installJsonDictSource(raw, res.path, res.name.replace(/\.json$/i, ''));
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try { await installJsonDictSource(await f.text(), null, f.name.replace(/\.json$/i, '')); }
    catch (e){ alert('无法读取文件: ' + e.message); }
  };
  input.click();
}

async function installJsonDictSource(raw, path, fallbackName){
  const parsed = dictx.parseDictJson(raw);
  if (!parsed){ alert('词典文件格式不合法:需要 galtrans-dict-v1 JSON(含 entries 字段),详见 docs/dictionary-plugins.md。'); return; }
  const count = Object.keys(parsed.entries).length;
  if (!count){ alert('词典文件没有有效词条。'); return; }
  const src = { id: dictSrcId(), type: 'json', name: parsed.name || fallbackName || 'JSON 词典', enabled: true };
  if (path) src.path = path; else src.session = true;
  sessionDictEntries.set(src.id, parsed.entries);
  dictSettings.sources.push(src);
  await saveDictSettings();
  rebuildDictProviders();
  renderDictSourceList();
  switchDictView('sources');
  showToast('✅ 已添加词典「' + src.name + '」(共 ' + count + ' 词条)');
}

/** 探测同名 .mdd 资源包并关联到词典(桌面版)。成功返回 mdd,无配对返回 null。 */
async function tryPairMdd(prov, mdxPath){
  if (!fsx.isTauri() || !prov || !mdxPath) return null;
  const mddPath = mdxPath.replace(/\.mdx$/i, '.mdd');
  if (mddPath === mdxPath) return null;
  try {
    const mdd = createTauriMdd({ name: prov.name + ' 资源', path: mddPath });
    await mdd.resourceB64(''); // 触发 mdd_open 校验;文件不存在会抛错
    prov.mdd = mdd;
    sourceMdd.set(prov.name, mdd);
    return mdd;
  } catch (e){
    return null; // 无同名 mdd(正常)或打开失败 → 无资源
  }
}

/** 添加 MDX 词典文件。
 *  桌面版: 原生文件对话框拿到路径 → 立即读取校验 → 记住路径(重启后首次查询时懒加载);
 *  浏览器版: 文件输入框,会话内加载(无法持久路径)。 */
async function addMdxSource(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog([{ name: 'MDX 词典', extensions: ['mdx'] }]);
    if (!res) return;
    // 桌面版: 立即 mdx_open 校验(Rust 解析头部,坏文件当场报错),记住路径
    const prov = mdx.createTauriMdxProvider({ id: 'mdx:' + res.path, name: res.name.replace(/\.mdx$/i, ''), path: res.path });
    try {
      await prov.lookup(''); // 触发惰性 open,校验可解析;空词查询返回空数组不报错
    } catch (e){
      showToast('❌ ' + res.name + ': ' + ((e && e.message) || '解析失败'), true);
      return;
    }
    const src = { id: prov.id, type: 'mdx', name: prov.name, path: res.path, enabled: true };
    mdxProviders.set(src.id, prov);
    dictSettings.sources.push(src);
    await saveDictSettings();
    await tryPairMdd(prov, res.path); // 探测同名 .mdd(词条内图片/发音)
    rebuildDictProviders();
    renderDictSourceList();
    showToast('✅ 已加载 MDX 词典「' + prov.name + '」(重启后自动恢复)');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mdx';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    let ok = 0, fail = 0;
    for (const f of files){
      try {
        const buffer = await f.arrayBuffer();
        const name = f.name.replace(/\.mdx$/i, '');
        const prov = await createMdxProvider({ name, buffer });
        const src = { id: prov.id, type: 'mdx', name: prov.name, session: true, enabled: true };
        mdxProviders.set(src.id, prov);
        dictSettings.sources.push(src);
        ok++;
      } catch (e){
        fail++;
        console.error('[mdx]', f.name, e);
        showToast('❌ ' + f.name + ': ' + (e && e.message ? e.message : '解析失败'), true);
      }
    }
    if (ok){
      await saveDictSettings();
      rebuildDictProviders();
      renderDictSourceList();
      showToast('✅ 已加载 ' + ok + ' 个 MDX 词典' + (fail ? '(失败 ' + fail + ' 个)' : ''));
    }
  };
  input.click();
}

/* ---- HTTP 词典配置弹窗 ---- */

let dhEditingId = null; // 正在编辑的词典源 id(空 = 新增)

function openDictHttpModal(src){
  dhEditingId = src ? src.id : null;
  const m = (src && src.map) || {};
  document.getElementById('dhName').value = src ? src.name : '';
  document.getElementById('dhUrl').value = src ? src.urlTemplate : '';
  document.getElementById('dhHeaders').value = src && src.headers ? JSON.stringify(src.headers) : '';
  document.getElementById('dhRoot').value = m.root || '';
  document.getElementById('dhHeadword').value = m.headword || '';
  document.getElementById('dhReading').value = m.reading || '';
  document.getElementById('dhGloss').value = m.gloss || '';
  document.getElementById('dhTestIn').value = '';
  document.getElementById('dhTestOut').textContent = '';
  document.getElementById('dictHttpModal').classList.add('show');
}

function closeDictHttpModal(){
  document.getElementById('dictHttpModal').classList.remove('show');
  dhEditingId = null;
}

/** 读取弹窗表单并校验;不合法返回 null */
function readDictHttpForm(){
  const url = document.getElementById('dhUrl').value.trim();
  const name = document.getElementById('dhName').value.trim() || 'HTTP 词典';
  if (!url || !url.includes('{word}')){ alert('URL 模板必须包含 {word} 占位。'); return null; }
  let headers = {};
  const hraw = document.getElementById('dhHeaders').value.trim();
  if (hraw){
    try { headers = JSON.parse(hraw); }
    catch (e){ alert('请求头不是合法 JSON: ' + e.message); return null; }
  }
  const pathOf = id => {
    const v = document.getElementById(id).value.trim();
    return v || undefined;
  };
  const map = {};
  const root = pathOf('dhRoot'); if (root) map.root = root;
  const hw = pathOf('dhHeadword'); if (hw) map.headword = hw;
  const rd = pathOf('dhReading'); if (rd) map.reading = rd;
  const gl = pathOf('dhGloss'); if (gl) map.gloss = gl;
  return { name, urlTemplate: url, headers, map };
}

async function saveDictHttpSource(){
  const cfg = readDictHttpForm();
  if (!cfg) return;
  if (dhEditingId){
    const src = dictSettings.sources.find(x => x.id === dhEditingId);
    if (src) Object.assign(src, cfg);
  } else {
    dictSettings.sources.push({ id: dictSrcId(), type: 'http', enabled: true, ...cfg });
  }
  await saveDictSettings();
  rebuildDictProviders();
  renderDictSourceList();
  closeDictHttpModal();
  showToast('✅ HTTP 词典已保存');
}

async function testDictHttp(){
  const cfg = readDictHttpForm();
  if (!cfg) return;
  const word = document.getElementById('dhTestIn').value.trim() || '食べる';
  const out = document.getElementById('dhTestOut');
  out.textContent = '查询「' + word + '」中…';
  const prov = dictx.createHttpDictProvider(cfg);
  try {
    const rs = await prov.lookup(word);
    out.textContent = rs.length
      ? rs.map(r => r.headword + (r.reading ? '[' + r.reading + ']' : '') + ' = ' + r.senses.map(s => (s.pos ? s.pos + ' ' : '') + s.gloss).join('；')).join('\n')
      : '连接成功,但没有解析出词条 —— 请检查字段映射路径。';
  } catch (e){
    out.textContent = '❌ ' + e.message;
  }
}

/* ---- 查询 ---- */

async function doDictLookup(word, isFuzzy){
  word = String(word || '').trim();
  if (!word) return;
  const box = document.getElementById('dictResults');
  if (!box) return;
  const fuzzy = isFuzzy !== undefined ? !!isFuzzy : document.getElementById('dictFuzzy').checked;
  box.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'dict-empty';
  loading.textContent = '查询「' + word + '」中…';
  box.appendChild(loading);
  const res = fuzzy ? await dictx.lookupAllFuzzy(word) : await dictx.lookupAll(word);
  renderDictResults(res, fuzzy);
}

function renderDictResults(res, fuzzy){
  const box = document.getElementById('dictResults');
  if (!box) return;
  box.innerHTML = '';
  const groups = dictx.groupDictResults(res.results || []);
  if (!groups.length && !res.errors.length){
    const empty = document.createElement('div');
    empty.className = 'dict-empty';
    empty.textContent = '「' + res.word + '」: 没有查到。可在「词典源」里添加 JSON/词典或配置 HTTP 词典' + (fuzzy ? '' : '；或勾选「包含匹配」做模糊搜索。');
    box.appendChild(empty);
    return;
  }
  for (const g of groups){
    const card = document.createElement('div');
    card.className = 'dict-card';
    card.dataset.head = g.headword || '';
    const head = document.createElement('div');
    head.className = 'dc-head';
    // 收藏按钮
    const favBtn = document.createElement('button');
    favBtn.className = 'dc-fav' + (isDictFav(g) ? ' on' : '');
    favBtn.textContent = isDictFav(g) ? '★' : '☆';
    favBtn.title = '收藏 / 取消收藏该词条';
    const favData = { word: g.headword || '', reading: g.reading || '', source: (g.sources[0] && g.sources[0].source) || '' };
    favBtn.addEventListener('click', () => {
      dictFavorites = dictx.toggleFavorite(dictFavorites, favData);
      saveDictFavorites();
      favBtn.textContent = dictx.isFavorite(dictFavorites, favData) ? '★' : '☆';
      favBtn.classList.toggle('on', dictx.isFavorite(dictFavorites, favData));
    });
    head.appendChild(favBtn);
    const hw = document.createElement('span');
    hw.textContent = g.headword || '';
    head.appendChild(hw);
    if (g.reading){
      const rd = document.createElement('span');
      rd.className = 'dc-reading';
      rd.textContent = g.reading;
      head.appendChild(rd);
    }
    if (fuzzy){
      const fz = document.createElement('span');
      fz.className = 'dc-fuzzy';
      fz.textContent = '（包含）';
      head.appendChild(fz);
    }
    head.appendChild(cardHeadSource(g));
    card.appendChild(head);
    // 组内多源分段
    for (const seg of g.sources){
      const srcLine = document.createElement('div');
      srcLine.className = 'dc-src-line';
      srcLine.textContent = seg.source;
      card.appendChild(srcLine);
      for (const s of seg.senses || []){
        const line = document.createElement('div');
        line.className = 'dc-sense';
        if (s.html){
          const body = document.createElement('div');
          body.className = 'dc-html';
          body.innerHTML = s.html;
          const mdd = sourceMdd.get(seg.source) || null;
          body.__mdd = mdd;
          line.appendChild(body);
          card.appendChild(line);
          hydrateMddImages(body, mdd);
          continue;
        }
        if (s.pos){
          const pos = document.createElement('span');
          pos.className = 'dc-pos';
          pos.textContent = s.pos;
          line.appendChild(pos);
        }
        line.appendChild(document.createTextNode(s.gloss));
        if (s.examples && s.examples.length){
          for (const ex of s.examples){
            const exEl = document.createElement('div');
            exEl.className = 'dc-ex';
            exEl.textContent = '例: ' + ex.src + (ex.dst ? ' → ' + ex.dst : '');
            line.appendChild(exEl);
          }
        }
        card.appendChild(line);
      }
    }
    box.appendChild(card);
  }
  for (const err of res.errors){
    const el = document.createElement('div');
    el.className = 'dict-err';
    el.textContent = '⚠ ' + err.source + ': ' + err.message;
    box.appendChild(el);
  }
  // 词条交互事件委托: entry:// 跳转 / sound:// 发音(容器级监听,水合后仍生效)
  bindDictResultInteractions(box);
}

function cardHeadSource(g){
  const src = document.createElement('span');
  src.className = 'dc-src';
  src.textContent = (g.sources || []).map(s => s.source).join(' / ');
  return src;
}

/* ---------------- 词典收藏 ---------------- */

let dictFavorites = [];

function isDictFav(g){
  return dictx.isFavorite(dictFavorites, { word: g.headword || '', reading: g.reading || '', source: (g.sources[0] && g.sources[0].source) || '' });
}

function saveDictFavorites(){
  return saveFavorites(dictFavorites);
}

async function initDictFavorites(){
  dictFavorites = await loadFavorites();
}

function renderDictFavorites(){
  const box = document.getElementById('favList');
  if (!box) return;
  box.innerHTML = '';
  if (!dictFavorites.length){
    box.appendChild(emptyProofItem('还没有收藏的词典词条。查询结果卡片标题旁的 ☆ 可收藏。'));
    return;
  }
  dictFavorites.forEach((f, idx) => {
    const el = document.createElement('div');
    el.className = 'proof-item';
    el.style.cursor = 'pointer';
    const head = document.createElement('div');
    head.style.color = 'var(--text-muted)';
    head.textContent = f.word + (f.reading ? '（' + f.reading + '）' : '') + ' · ' + (f.source || '');
    const del = document.createElement('button');
    del.className = 'pr-btn';
    del.textContent = '✕';
    del.title = '取消收藏';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      dictFavorites = dictx.toggleFavorite(dictFavorites, f);
      saveDictFavorites();
      renderDictFavorites();
    });
    head.appendChild(del);
    el.append(head);
    el.addEventListener('click', () => {
      switchDictView('lookup');
      const input = document.getElementById('dictInput');
      if (input) input.value = f.word || '';
      doDictLookup(f.word || '', false);
    });
    box.appendChild(el);
  });
}

/**
 * 把词条 HTML 内的本地资源 <img src> 解析为 MDD 资源 data URL。
 * 仅处理来自 MDD 的本地资源(http/data/blob 等外部 src 不动),缺失资源静默。
 */
function hydrateMddImages(body, mdd){
  if (!mdd) return;
  const imgs = [...body.querySelectorAll('img[src]')];
  for (const img of imgs){
    const raw = img.getAttribute('src');
    if (!isMddResourceSrc(raw)) continue;
    const key = srcToResourceKey(raw);
    mdd.resourceB64(key).then(b64 => {
      if (b64){
        const mime = mimeFromExt(raw);
        img.src = 'data:' + mime + ';base64,' + b64;
      }
    }).catch(() => { /* 资源缺失: 保留原样 */ });
  }
}

/** 容器级事件委托: entry:// 跳转查词 / sound:// 播放发音 */
function bindDictResultInteractions(container){
  container.addEventListener('click', async (e) => {
    // 发音链接(可能 a[href] 或 span 触发)
    const soundEl = e.target.closest('a[href^="sound://"], [data-sound]');
    if (soundEl){
      e.preventDefault();
      const mdd = soundEl.closest('.dc-html')?.__mdd;
      if (mdd){
        const key = srcToResourceKey(soundEl.getAttribute('data-sound') || soundEl.getAttribute('href'));
        try {
          const b64 = await mdd.resourceB64(key);
          if (!b64) return;
          const mime = mimeFromExt(key);
          const audio = new Audio('data:' + mime + ';base64,' + b64);
          audio.play().catch(() => {});
        } catch (err){ /* 静默 */ }
      }
      return;
    }
    // 词条跳转链接
    const link = e.target.closest('a[href^="entry://"]');
    if (link){
      e.preventDefault();
      const target = linkTarget(link.getAttribute('href'));
      if (target) doDictLookup(target);
    }
  });
}

/** 划词查词入口(renderer 回调): 打开侧栏词典页并查询 */
function dictLookupFromSelection(word){
  setSidebar(true);
  switchSidebarTab('dict');
  switchDictView('lookup');
  const input = document.getElementById('dictInput');
  if (input) input.value = word;
  doDictLookup(word);
}

/** 词典面板子视图切换(查询 / 词典源 / 片段) */
function switchDictView(v){
  document.querySelectorAll('.proof-view-tab[data-dv]').forEach(x => x.classList.toggle('active', x.dataset.dv === v));
  document.getElementById('dv-lookup').classList.toggle('hidden', v !== 'lookup');
  document.getElementById('dv-favorites').classList.toggle('hidden', v !== 'favorites');
  document.getElementById('dv-sources').classList.toggle('hidden', v !== 'sources');
  document.getElementById('dv-snippets').classList.toggle('hidden', v !== 'snippets');
  if (v === 'snippets') renderSnipTable();
  if (v === 'favorites') renderDictFavorites();
}

/* ---- 快捷片段 ---- */

async function initSnippets(){
  snippetData = await snips.loadSnippetsForProject(gloss.getProjectDir());
  renderSnipTable();
  updateSnipLocation();
}

function updateSnipLocation(){
  const el = document.getElementById('snipLocation');
  if (!el) return;
  const d = snips.getSnippetsProjectDir();
  el.textContent = d ? ('📁 片段保存位置: ' + d + '/snippets.json') : '📁 片段保存位置: 全局 snippets.json(未打开文件)';
}

let snipPersistTimer = null;
function scheduleSnipPersist(){
  if (snipPersistTimer) clearTimeout(snipPersistTimer);
  snipPersistTimer = setTimeout(async () => {
    snipPersistTimer = null;
    await snips.saveSnippetsForProject(snippetData.merged);
    // 落盘后重载分层,保持 全局/项目/合并 三层一致
    snippetData = await snips.loadSnippetsForProject(gloss.getProjectDir());
    updateSnipLocation();
  }, 300);
}

function renderSnipTable(){
  const box = document.getElementById('snipTable');
  if (!box) return;
  box.innerHTML = '';
  const keys = Object.keys(snippetData.merged).sort((a, b) => a.localeCompare(b, 'en'));
  if (!keys.length){
    const empty = document.createElement('div');
    empty.className = 'side-hint';
    empty.textContent = '还没有片段。例如: ys → 请多指教。';
    box.appendChild(empty);
    return;
  }
  for (const k of keys) box.appendChild(snipRow(k));
}

function snipRow(k){
  const row = document.createElement('div');
  row.className = 'gloss-row';
  const s1 = document.createElement('input');
  s1.type = 'text';
  s1.value = k;
  s1.placeholder = '缩写';
  const s2 = document.createElement('input');
  s2.type = 'text';
  s2.value = snippetData.merged[k];
  s2.placeholder = '展开文本';
  const del = document.createElement('button');
  del.className = 'toolbtn secondary';
  del.textContent = '✕';
  del.title = '删除该片段';
  del.addEventListener('click', () => {
    if (!confirm('删除片段「' + k + '」?')) return;
    delete snippetData.merged[k];
    scheduleSnipPersist();
    renderSnipTable();
  });
  s1.addEventListener('change', () => {
    const nk = s1.value.trim();
    if (!nk || nk === k){ s1.value = k; return; }
    const v = snippetData.merged[k];
    delete snippetData.merged[k];
    snippetData.merged[nk] = v;
    scheduleSnipPersist();
    renderSnipTable();
  });
  s2.addEventListener('change', () => {
    if (s2.value.trim()) snippetData.merged[k] = s2.value;
    else delete snippetData.merged[k];
    scheduleSnipPersist();
  });
  row.append(s1, s2, del);
  return row;
}

function addSnippet(){
  const k = document.getElementById('snipAddSrc').value.trim();
  const v = document.getElementById('snipAddDst').value;
  if (!k || !v.trim()){ alert('请填写缩写与展开文本'); return; }
  snippetData.merged[k] = v;
  document.getElementById('snipAddSrc').value = '';
  document.getElementById('snipAddDst').value = '';
  scheduleSnipPersist();
  renderSnipTable();
}

/** 采纳输入建议: 用 dst 替换光标前的词元(术语译文或片段展开),撤销/校对/自动保存照常走 */
function applySuggestion(i, item){
  const p = model.getPara(i);
  if (!p || p.isName) return;
  const r = rdr.getRow(i);
  if (!r) return;
  const ta = r.trans;
  const caret = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const token = suggest.currentToken(ta.value, caret);
  if (!token) return;
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  model.pushUndo([i]);
  clearPushTimers();
  const before = ta.value.slice(0, caret - token.length);
  const after = ta.value.slice(caret);
  const mid = before + item.dst + after;
  p.translation = p.brackets ? ('「' + mid + '」') : mid;
  model.recalcDone(p);
  if (snap) proof.recordDiff(snap, 'edit');
  model.scheduleAutosave();
  rdr.refreshRow(i);
  updateProgress();
  const rr = rdr.getRow(i);
  if (rr){
    const newCaret = before.length + item.dst.length;
    rr.trans.focus();
    rr.trans.setSelectionRange(newCaret, newCaret);
  }
}

/* ---------------- 解析规则设置 ---------------- */

let parseBackup = null; // 打开设置时的旧配置(取消时还原)

function openParseSettings(){
  parseBackup = getParseConf();
  document.getElementById('setOpen').value = parseBackup.open;
  document.getElementById('setClose').value = parseBackup.close;
  document.getElementById('setRegex').value = parseBackup.regex;
  document.getElementById('setComments').value = (parseBackup.commentPrefixes || []).join(' ');
  document.getElementById('setNameIds').value = (parseBackup.nameIdPatterns || []).join(' ');
  document.getElementById('setTestIn').value = '';
  document.getElementById('setTestOut').textContent = '';
  initRecogSection(); // 识别区块重置
  document.getElementById('setModal').classList.add('show');
}
function closeParseSettings(){
  document.getElementById('setModal').classList.remove('show');
}

function currentParseFromUI(){
  return {
    open: document.getElementById('setOpen').value || '☆',
    close: document.getElementById('setClose').value || '★',
    regex: document.getElementById('setRegex').value.trim(),
    commentPrefixes: document.getElementById('setComments').value.trim().split(/\s+/).filter(Boolean),
    nameIdPatterns: document.getElementById('setNameIds').value.trim().split(/\s+/).filter(Boolean)
  };
}

function testParseRule(){
  const input = document.getElementById('setTestIn').value;
  setParseConf(currentParseFromUI()); // 临时套用 UI 上的规则做测试
  const pp = parsePrefix(input);
  // 提取编号(命名组优先;自动模式取前缀第一段)并做名字行判定测试
  let id = pp.named ? pp.id : '';
  if (!id && pp.prefix){
    const cfg = getParseConf();
    const sep = '[' + cfg.open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + cfg.close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']';
    id = (pp.prefix.replace(new RegExp('^' + sep), '').split(new RegExp(sep))[0] || '').trim();
  }
  const pats = currentParseFromUI().nameIdPatterns;
  const isName = id && pats.some(p => new RegExp(p, 'i').test(id));
  document.getElementById('setTestOut').textContent =
    '前缀: ' + (pp.prefix === '' ? '（无）' : pp.prefix) + '\n' +
    '正文: ' + (pp.content === '' ? '（空）' : pp.content) +
    (id ? '\n编号: ' + id + (pats.length ? '  名字行判定: ' + (isName ? '是' : '否') : '') : '');
  // 测试不落盘;关闭/保存时才真正生效
}

async function saveParseSettings(){
  const s = await loadSettings();
  s.parse = currentParseFromUI();
  await saveSettings(s);
  setParseConf(s.parse);
  closeParseSettings();
  alert('解析规则已保存,重新导入文件后生效。');
}

function cancelParseSettings(){
  if (parseBackup) setParseConf(parseBackup); // 还原测试期间的临时配置
  closeParseSettings();
}

/* ---------------- 文本格式识别(GUI) ---------------- */

let recogState = null; // { profile, canonicalText }

// 打开「格式/规则」弹窗时初始化识别区块(来源/报告清空)
function initRecogSection(){
  const srcFile = document.getElementById('recogSrcFile');
  const hasFile = !!model.getRawText();
  srcFile.checked = true;
  document.getElementById('recogSrcPaste').checked = false;
  document.getElementById('recogText').hidden = true;
  document.getElementById('recogFileRow').hidden = true;
  document.getElementById('recogFileHint').textContent = '';
  document.getElementById('recogOut').textContent = '';
  setRecogActions(false);
  recogState = null;
  srcFile.disabled = !hasFile;
  if (!hasFile) srcFile.parentElement.title = '请先导入文件,或改用「粘贴/选择文本」';
}

function setRecogActions(show){
  for (const id of ['btnRecogApply', 'btnRecogLoad', 'btnRecogProfile', 'btnRecogCanon']){
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  }
}

function toggleRecogSource(){
  const paste = document.getElementById('recogSrcPaste').checked;
  document.getElementById('recogText').hidden = !paste;
  document.getElementById('recogFileRow').hidden = !paste;
}

function recogSourceText(){
  if (document.getElementById('recogSrcFile').checked){
    const raw = model.getRawText();
    if (!raw) return { text: '', err: '当前没有已打开的文件,请改用「粘贴/选择文本」。' };
    return { text: raw, err: '' };
  }
  const pasted = document.getElementById('recogText').value.trim();
  if (pasted) return { text: pasted, err: '' };
  return { text: '', err: '请粘贴文本,或选择文本文件。' };
}

async function pickRecogFile(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog();
    if (!res) return;
    const { content } = await fsx.readFileSource({ path: res.path });
    document.getElementById('recogText').value = content;
    document.getElementById('recogFileHint').textContent = '已载入: ' + res.name;
    return;
  }
  const picked = await fsx.pickBrowserFile();
  if (!picked) return;
  const text = await picked.file.text();
  document.getElementById('recogText').value = text;
  document.getElementById('recogFileHint').textContent = '已载入: ' + picked.name;
}

async function runRecognize(){
  const { text, err } = recogSourceText();
  const out = document.getElementById('recogOut');
  if (err){
    out.textContent = '❌ ' + err;
    setRecogActions(false);
    recogState = null;
    return;
  }
  out.textContent = '识别中…';
  let profile;
  try {
    profile = await wkr.recogDetect(text, model.getFilename() || '粘贴文本');
  } catch (e){
    // worker 异常 → 回退主线程同步 detect
    profile = recogDetect(text, model.getFilename() || '粘贴文本');
  }
  let report = renderReport(profile);

  // 用真实解析器模拟编辑器导入(在 worker 内用同一份 parsers 模块)
  if (profile.marks && profile.marks.close){
    try {
      const a = await wkr.recogAnalyzeWithParsers(text, profile.parseConfig, 'a');
      const canon = await wkr.recogCanonicalize(profile);
      const b = await wkr.recogAnalyzeWithParsers(canon, { open: '☆', close: '★', regex: '' }, 'b');
      report += '\n==== 编辑器模拟 ====\n';
      report += '[原文件 + 识别配置] 段落 ' + a.paras + ' 有编号 ' + a.withId + '/' + a.paras +
        ' 名字栏可用 ' + a.named + ' 无损还原 ' + (a.roundTrip === true ? '✓' : '✗ ' + a.roundTrip) + '\n';
      report += '[规范化文本] 段落 ' + b.paras + ' 有编号 ' + b.withId + '/' + b.paras +
        ' 名字栏可用 ' + b.named + ' 无损还原 ' + (b.roundTrip === true ? '✓' : '✗ ' + b.roundTrip);
      recogState = { profile, canonicalText: canon };
    } catch (e){
      recogState = { profile, canonicalText: recogCanonicalize(profile) };
      report += '\n(编辑器模拟失败: ' + (e && e.message ? e.message : e) + ')';
    }
  } else {
    recogState = null;
  }
  out.textContent = report;
  setRecogActions(!!recogState && !!profile.marks);
}

// 「应用为解析规则」: 把识别出的标记/正则/注释前缀/名字行模式写入规则字段并立即保存(与导入配置一致)
function applyRecogConfig(){
  if (!recogState || !recogState.profile || !recogState.profile.marks) return;
  const cfg = recogState.profile.parseConfig;
  document.getElementById('setOpen').value = cfg.open;
  document.getElementById('setClose').value = cfg.close || '★';
  document.getElementById('setRegex').value = cfg.regex || '';
  document.getElementById('setComments').value = (cfg.commentPrefixes || []).join(' ');
  document.getElementById('setNameIds').value = (cfg.nameIdPatterns || []).join(' ');
  saveParseSettings().then(() => {
    showToast('✅ 已应用为解析规则: 原文 ' + cfg.open + ' / 译文 ' + (cfg.close || '★') + '（重新导入原文件生效）');
  });
}

function loadCanonicalIntoEditor(){
  if (!recogState || !recogState.canonicalText) return;
  const canon = recogState.canonicalText;
  // 规范化文本是编辑器原生 ☆/★,当前文档用默认规则解析(不改已保存的 settings.parse)
  setParseConf({ open: '☆', close: '★', regex: '' });
  parseBackup = getParseConf(); // 弹窗「取消」不再回退到旧规则(与已载入的规范化文档一致)
  const parsed = parseFile(canon);
  // 显示名保留原文件名(规范化不改文字内容,也不改名磁盘文件);
  // 存储键(进度/校对)加 .canonical 标记,与原文件分开
  const origName = model.getFilename() || '文本';
  model.setParas(parsed.paras);
  model.setFileInfo({ name: origName, path: null, nl: parsed.nl, trailingBlank: parsed.trailingBlank });
  model.setCanonicalDoc(true);
  model.setRawText(canon); // 之后可继续识别/还原
  // 规则字段同步显示为 ☆/★(当前文档所用);不写 settings.parse,保留用户已保存的规则
  document.getElementById('setOpen').value = '☆';
  document.getElementById('setClose').value = '★';
  document.getElementById('setRegex').value = '';
  document.getElementById('setComments').value = '';
  document.getElementById('setNameIds').value = '';
  // 已载入规范化文档:「应用为解析规则」不再适用(会把内存规则改回原格式,导致保存/导出出错)
  const btnApply = document.getElementById('btnRecogApply');
  if (btnApply) btnApply.hidden = true;
  proof.loadForFile(); // 切换文档: 重置并读取新文件的校对数据
  rdr.fullRender();
  recomputeMatchesUI(true);
  rdr.focusIdx(0);
  updateUndoButtons();
  updateProgress();
  document.getElementById('fname').textContent = '当前文件：' + origName + '（已规范化：格式为 ☆/★，原格式可下载档案后用 --restore 还原）';
  showToast('✅ 已规范化并载入编辑器（' + parsed.paras.length + ' 段，文件名不变）');
}

async function downloadRecogProfile(){
  if (!recogState || !recogState.profile) return;
  const base = (model.getFilename() || '文本').replace(/\.(txt|ks)$/i, '');
  const name = base + '.profile.json';
  const dir = await fsx.getAppDir(); // 桌面版默认 exe 所在文件夹
  const r = await fsx.downloadTextWithDialog(JSON.stringify(recogState.profile, null, 2), name, dir);
  if (r.saved) showToast('✅ 已保存格式档案：' + (r.path || name) + '（供 CLI --restore 还原 / 备份）');
  else if (r.downloaded) showToast('⬇ 已下载格式档案：' + name + '（供 CLI --restore 还原 / 备份）');
}

async function downloadRecogCanonical(){
  if (!recogState || !recogState.canonicalText) return;
  const base = (model.getFilename() || '文本').replace(/\.(txt|ks)$/i, '');
  const name = base + '.canonical.txt';
  const dir = await fsx.getAppDir(); // 桌面版默认 exe 所在文件夹
  const r = await fsx.downloadTextWithDialog(recogState.canonicalText, name, dir);
  if (r.saved) showToast('✅ 已保存规范化文本：' + (r.path || name) + '（翻译完可用脚本 --restore 还原原格式）');
  else if (r.downloaded) showToast('⬇ 已下载规范化文本（翻译完可用脚本 --restore 还原原格式）');
}

/* ---------------- 校对模式(GUI) ---------------- */

// 刷新校对工具栏统计 + 侧栏面板(proof.js 的 ui.refreshUI 回调)
function refreshProofUI(){
  const st = proof.stats();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('pfAll', st.total);
  set('pfPending', st.pending);
  set('pfIssue', st.issue);
  set('pfApproved', st.approved);
  const a = proof.analyzeRows();
  set('pfMissing', a.total);
  const pvm = document.getElementById('pvMissingCount');
  if (pvm) pvm.textContent = a.total;
  const pc = document.getElementById('proofCount');
  if (pc) pc.textContent = '已通过 ' + st.approved + ' / ' + st.total + (st.issue ? ' · 有问题 ' + st.issue : '');
  renderProofPanel();
}

function emptyProofItem(text){
  const el = document.createElement('div');
  el.className = 'pr-empty';
  el.textContent = text;
  return el;
}

// 侧栏校对面板: 批注总览 / 漏翻异常 / 修改记录(面板可见即渲染;漏翻视图校对模式外也可用)
function renderProofPanel(){
  const panel = document.getElementById('panel-proof');
  if (!panel || panel.classList.contains('hidden')) return;
  const tab = proof.getViewTab();
  if (tab === 'missing') renderMissingList();
  else if (tab === 'log') renderProofLog();
  else renderAnnoOverview();
}

const ISSUE_KIND_LABEL = { missing: '漏翻', placeholder: '占位未译', ratio: '长度可疑' };

function renderMissingList(){
  const list = document.getElementById('missingList');
  if (!list) return;
  const a = proof.analyzeRows();
  document.getElementById('pvMissingCount').textContent = a.total;
  // 顶栏漏翻计数 chip 同步
  const chip = document.getElementById('pfMissing');
  if (chip) chip.textContent = a.total;
  list.innerHTML = '';
  if (!a.total){
    list.appendChild(emptyProofItem('没有漏翻或异常。'));
    return;
  }
  const all = [...a.missing, ...a.placeholder, ...a.ratio];
  all.forEach(x => {
    const el = document.createElement('div');
    el.className = 'proof-item';
    el.style.cursor = 'pointer';
    const head = document.createElement('div');
    const kind = document.createElement('span');
    kind.className = 'pr-tag ' + (x.kind === 'ratio' ? 'pr-tag-suggestion' : 'pr-tag-issue');
    kind.textContent = ISSUE_KIND_LABEL[x.kind] || x.kind;
    head.textContent = '第' + (x.i + 1) + '行 ';
    head.style.color = 'var(--text-muted)';
    head.appendChild(kind);
    const orig = document.createElement('div');
    orig.className = 'proof-item-text';
    orig.textContent = x.origPreview;
    const tv = document.createElement('div');
    tv.className = 'proof-item-text muted';
    tv.textContent = x.transPreview || '（译文为空）';
    el.append(head, orig, tv);
    el.addEventListener('click', () => {
      rdr.scrollRowIntoView(x.i);
      rdr.focusIdx(x.i);
    });
    list.appendChild(el);
  });
}

function renderAnnoOverview(){
  const openEl = document.getElementById('annoOpenList');
  const doneEl = document.getElementById('annoDoneList');
  if (!openEl || !doneEl) return;
  const open = [], done = [];
  model.getParas().forEach((p, i) => {
    if (!p.pr || !p.pr.annotations || !p.pr.annotations.length) return;
    p.pr.annotations.forEach(a => {
      (a.resolved ? done : open).push({ i, a, line: i + 1 });
    });
  });
  open.sort((x, y) => y.a.created - x.a.created);
  done.sort((x, y) => y.a.created - x.a.created);
  document.getElementById('annoOpenCount').textContent = open.length;
  document.getElementById('annoDoneCount').textContent = done.length;
  openEl.innerHTML = '';
  doneEl.innerHTML = '';
  if (!open.length) openEl.appendChild(emptyProofItem('没有未解决的批注'));
  open.forEach(x => openEl.appendChild(annoOverviewItem(x, true)));
  if (!done.length) doneEl.appendChild(emptyProofItem('暂无已解决的批注'));
  done.forEach(x => doneEl.appendChild(annoOverviewItem(x, false)));
}

function annoOverviewItem(x, isOpen){
  const el = document.createElement('div');
  el.className = 'proof-item';
  el.style.cursor = 'pointer';
  const head = document.createElement('div');
  head.textContent = '第' + x.line + '行';
  head.style.color = 'var(--text-muted)';
  const tag = document.createElement('span');
  tag.className = 'pr-tag pr-tag-' + x.a.type;
  tag.textContent = proof.ANNO_TYPES[x.a.type] || x.a.type;
  const txt = document.createElement('div');
  txt.className = 'proof-item-text';
  txt.textContent = x.a.text;
  el.append(head, tag, txt);
  el.addEventListener('click', () => {
    rdr.scrollRowIntoView(x.i);
    rdr.focusIdx(x.i);
  });
  if (isOpen){
    const btn = document.createElement('button');
    btn.className = 'pr-btn';
    btn.textContent = '解决';
    btn.title = '解决该批注';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      proof.resolveAnnotation(x.i, x.a.id);
    });
    el.appendChild(btn);
  }
  return el;
}

// 打开侧栏校对页并切到「漏翻/异常」视图(顶栏 ⚠ 漏翻 按钮)
function openMissingList(){
  setSidebar(true);
  switchSidebarTab('proof');
  const t = document.querySelector('.proof-view-tab[data-pv="missing"]');
  if (t) t.click();
}

function renderProofLog(){
  const list = document.getElementById('proofLogList');
  if (!list) return;
  const changes = proof.getChanges();
  list.innerHTML = '';
  if (!changes.length){
    list.appendChild(emptyProofItem('暂无修改记录。开启「📋 校对」后，完成一整句输入（或替换/撤销等操作）时会记录在这里。'));
    return;
  }
  changes.slice(0, 50).forEach(c => {
    const el = document.createElement('div');
    el.className = 'proof-item';
    const src = document.createElement('span');
    src.className = 'pr-tag pr-tag-note';
    src.textContent = proof.CHANGE_SOURCES[c.source] || c.source;
    const head = document.createElement('div');
    head.textContent = '第' + c.line + '行 · ' + (c.field === 'nameTr' ? '译名' : '译文');
    head.style.color = 'var(--text-muted)';
    const diff = document.createElement('div');
    diff.className = 'proof-diff';
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '← ' + (c.before === '' ? '（空）' : c.before);
    const add = document.createElement('span');
    add.className = 'add';
    add.textContent = '→ ' + (c.after === '' ? '（空）' : c.after);
    diff.append(del, add);
    const btn = document.createElement('button');
    btn.className = 'pr-btn';
    btn.textContent = '还原';
    btn.title = '把该行改回修改前(可 Ctrl+Z 撤销还原)';
    btn.addEventListener('click', () => {
      const r = proof.restoreChange(c.id);
      if (r && r.idx !== undefined){
        rdr.scrollRowIntoView(r.idx);
        rdr.focusIdx(r.idx);
      }
      updateProgress();
      updateUndoButtons();
      refreshProofUI();
    });
    el.append(src, head, diff, btn);
    list.appendChild(el);
  });
}

function toggleProofMode(){
  const on = !proof.isEnabled();
  proof.setEnabled(on);
  document.getElementById('btnProof').classList.toggle('active', on);
  document.getElementById('btnProof').textContent = on ? '📋 校对中' : '📋 校对';
  document.getElementById('proofbar').classList.toggle('hidden', !on);
  if (on){
    rdr.setNotesAutoOpen(true); // 有批注的行默认展开批注框
    rdr.refreshAllRows();
    refreshProofUI();
    showToast('✅ 校对模式已开启（Q 通过并跳下一行 / W 有问题 / A 批注）');
  } else {
    rdr.setNotesAutoOpen(false); // 退出校对模式: 恢复默认收起
    proof.setFilter('all');
    document.querySelectorAll('.proof-filter').forEach(b => b.classList.toggle('active', b.dataset.pf === 'all'));
    rdr.refreshAllRows();
    const sb = document.getElementById('sidebar');
    if (!sb.classList.contains('hidden')) switchSidebarTab('files');
  }
}

function setProofFilter(v){
  proof.setFilter(v);
  document.querySelectorAll('.proof-filter').forEach(b => b.classList.toggle('active', b.dataset.pf === v));
  rdr.refreshAllRows();
  refreshProofUI();
}

function jumpNextIssue(){
  const paras = model.getParas();
  if (!paras.length){ showToast('没有可校对的批注'); return; }
  const start = Math.max(0, rdr.getActiveIdx() + 1);
  let n = -1;
  for (let i = start; i < paras.length; i++){
    if (proof.unresolvedCount(i) > 0 || proof.statusOf(i) === 'issue'){ n = i; break; }
  }
  if (n === -1){
    for (let i = 0; i < start; i++){
      if (proof.unresolvedCount(i) > 0 || proof.statusOf(i) === 'issue'){ n = i; break; }
    }
  }
  if (n === -1){ showToast('🎉 没有待处理的问题'); return; }
  if (!proof.rowPassesFilter(n)){
    proof.setFilter('all');
    document.querySelectorAll('.proof-filter').forEach(b => b.classList.toggle('active', b.dataset.pf === 'all'));
    rdr.refreshAllRows();
  }
  rdr.scrollRowIntoView(n);
  rdr.focusIdx(n);
}

// 快捷键动作
function proofApproveAndNext(){
  const i = rdr.getActiveIdx();
  if (i < 0) return;
  if (proof.statusOf(i) !== 'approved') proof.toggleApprove(i);
  const paras = model.getParas();
  for (let k = i + 1; k < paras.length; k++){
    if (proof.rowPassesFilter(k)){ rdr.focusIdx(k); return; }
  }
  for (let k = 0; k <= i; k++){
    if (proof.rowPassesFilter(k)){ rdr.focusIdx(k); return; }
  }
}
function proofMarkIssue(){
  const i = rdr.getActiveIdx();
  if (i >= 0) proof.toggleIssue(i);
}
function proofOpenNotes(){
  const i = rdr.getActiveIdx();
  const r = i >= 0 ? rdr.getRow(i) : null;
  if (!r) return;
  r.notes.classList.toggle('hidden');
  r.btnNotes.classList.toggle('on', !r.notes.classList.contains('hidden'));
  if (r.notes.classList.contains('hidden')) r.trans.focus();
  else r.notesInput.focus();
}

// 校对快捷键匹配: 'q' / 'Ctrl+Shift+K'
function keyComboMatch(e, combo){
  if (!combo) return false;
  const parts = combo.split('+');
  const key = (parts.pop() || '').toLowerCase();
  const wantCtrl = parts.includes('ctrl'), wantShift = parts.includes('shift'), wantAlt = parts.includes('alt');
  if ((e.key || '').toLowerCase() !== key) return false;
  if (wantCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return true;
}

// 校对快捷键设置弹窗
let recordingAction = null;
let keysBackup = null;

const PROOF_KEY_ACTIONS = [
  { id: 'approve', label: '标记通过并跳下一行', fn: proofApproveAndNext },
  { id: 'issue', label: '标记有问题', fn: proofMarkIssue },
  { id: 'annotate', label: '打开批注框', fn: proofOpenNotes },
  { id: 'nextIssue', label: '跳下一处问题', fn: jumpNextIssue },
  { id: 'toggleMode', label: '开关校对模式', fn: toggleProofMode },
];

function openProofKeys(){
  keysBackup = Object.assign({}, proof.proofKeys);
  const list = document.getElementById('keysList');
  list.innerHTML = '';
  for (const act of PROOF_KEY_ACTIONS){
    const row = document.createElement('div');
    row.className = 'key-row';
    const lab = document.createElement('span');
    lab.className = 'key-label';
    lab.textContent = act.label;
    const cap = document.createElement('button');
    cap.className = 'key-capture';
    cap.dataset.action = act.id;
    cap.textContent = proof.proofKeys[act.id] || '（未设置）';
    cap.addEventListener('click', () => {
      recordingAction = act.id;
      document.querySelectorAll('.key-capture').forEach(b => b.classList.remove('recording'));
      cap.classList.add('recording');
      cap.textContent = '按下新键…';
    });
    const clear = document.createElement('button');
    clear.className = 'key-clear';
    clear.textContent = '✕';
    clear.title = '清除该键';
    clear.addEventListener('click', () => {
      proof.proofKeys[act.id] = '';
      refreshKeyCaptures();
    });
    row.append(lab, cap, clear);
    list.appendChild(row);
  }
  document.getElementById('keysModal').classList.add('show');
}

function refreshKeyCaptures(){
  recordingAction = null;
  document.querySelectorAll('.key-capture').forEach(b => {
    b.textContent = proof.proofKeys[b.dataset.action] || '（未设置）';
    b.classList.remove('recording');
  });
}

function recordKeyEvent(e){
  if (!recordingAction) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape'){ refreshKeyCaptures(); return; }
  if (/^(Control|Shift|Alt|Meta)$/i.test(e.key)) return; // 单独的修饰键不算
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  let k = e.key || ''; // WebView2 对部分系统键会派发 key=undefined 的 keydown,防御
  if (k.length === 1) k = k.toLowerCase();
  proof.proofKeys[recordingAction] = mods.length ? mods.join('+') + '+' + k : k;
  refreshKeyCaptures();
}

async function saveProofKeys(){
  const s = await loadSettings();
  s.proof = s.proof || {};
  s.proof.keys = Object.assign({}, proof.proofKeys);
  await saveSettings(s);
  document.getElementById('keysModal').classList.remove('show');
  showToast('✅ 校对快捷键已保存');
}

function resetProofKeys(){
  proof.setKeys(proof.defaultKeys());
  refreshKeyCaptures();
}

// 撤销/重做(校对模式下记录修改历史)
function doUndo(){
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  if (!model.undo()) return;
  if (snap) proof.recordDiff(snap, 'undo');
  afterUndoRedo();
}
function doRedo(){
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  if (!model.redo()) return;
  if (snap) proof.recordDiff(snap, 'redo');
  afterUndoRedo();
}

/* ---------------- 背景图 ---------------- */

const MAX_BG_SIZE = 4 * 1024 * 1024; // 4MB 上限(避免 settings.json 过大)

// 背景填充方式 → CSS background-size / background-repeat
const BG_FIT_MAP = {
  cover:   { size: 'cover',                  repeat: 'no-repeat' },
  contain: { size: 'contain',                repeat: 'no-repeat' },
  stretch: { size: '100% 100%',              repeat: 'no-repeat' },
  tile:    { size: 'auto',                   repeat: 'repeat' },
  auto:    { size: 'auto',                   repeat: 'no-repeat' },
};

function applyBackground(dataUrl, opacity, fit){
  const layer = document.getElementById('bgLayer');
  if (!layer) return;
  document.body.classList.toggle('has-background', !!dataUrl);
  if (dataUrl){
    layer.classList.remove('hidden');
    layer.style.backgroundImage = 'url(' + dataUrl + ')';
    layer.style.setProperty('--bg-mask-opacity', String(opacity !== undefined ? opacity : 0.82));
    const f = BG_FIT_MAP[fit] || BG_FIT_MAP.cover;
    layer.style.backgroundSize = f.size;
    layer.style.backgroundRepeat = f.repeat;
    layer.style.backgroundPosition = fit === 'tile' ? 'left top' : 'center';
  } else {
    layer.classList.add('hidden');
    layer.style.backgroundImage = '';
  }
}

async function openThemeSettings(){
  const bg = await loadBackground();
  document.getElementById('bgOpacity').value = String(bg.opacity);
  document.getElementById('bgFit').value = bg.fit;
  updateBgOpacityLabel();
  updateBgPreview(bg.dataUrl, bg.fit);
  // 主题模式
  const mode = theme.normalizeThemeMode(await loadThemeMode() || currentMode);
  for (const r of document.querySelectorAll('input[name="thMode"]')){
    r.checked = r.value === mode;
  }
  // 字体
  syncFontUI(await loadFontSettings());
  // 打开时重置到「界面设置」页
  thSwitchTab(document.querySelector('#thTabs button[data-thpage="0"]'));
  document.getElementById('themeModal').classList.add('show');
}

function updateBgOpacityLabel(){
  document.getElementById('bgOpacityVal').textContent =
    Math.round(Number(document.getElementById('bgOpacity').value) * 100) + '%';
}

function updateBgPreview(dataUrl, fit){
  const pv = document.getElementById('bgPreview');
  if (dataUrl){
    pv.style.backgroundImage = 'url(' + dataUrl + ')';
    const f = BG_FIT_MAP[fit] || BG_FIT_MAP.cover;
    pv.style.backgroundSize = f.size;
    pv.style.backgroundRepeat = f.repeat;
    pv.style.backgroundPosition = fit === 'tile' ? 'left top' : 'center';
    pv.textContent = '';
  } else {
    pv.style.backgroundImage = '';
    pv.textContent = '未设置背景';
  }
}

// 预览时应用当前 fit
function previewBg(dataUrl){
  const fit = document.getElementById('bgFit').value;
  updateBgPreview(dataUrl, fit);
  applyBackground(dataUrl, Number(document.getElementById('bgOpacity').value), fit);
}

// 选择图片 → 读成 dataURL(浏览器 FileReader 可读,桌面/浏览器通用)
function onBgFileChange(){
  const f = document.getElementById('bgFile').files[0];
  if (!f) return;
  if (f.size > MAX_BG_SIZE){ alert('图片过大（超过 4MB）。请压缩后再试。'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('bgFile').dataset.pending = reader.result; // 暂存,保存时才落盘
    previewBg(reader.result);
  };
  reader.readAsDataURL(f);
}

async function saveBgSettings(){
  const pending = document.getElementById('bgFile').dataset.pending || null;
  const opacity = Number(document.getElementById('bgOpacity').value);
  const fit = document.getElementById('bgFit').value;
  const bg = await loadBackground();
  const dataUrl = pending || bg.dataUrl; // 没选新图则保留旧的
  await saveBackground(dataUrl, opacity, fit);
  applyBackground(dataUrl, opacity, fit);
  // 主题模式
  const mode = theme.normalizeThemeMode(document.querySelector('input[name="thMode"]:checked').value);
  applyTheme(mode);
  await saveThemeMode(mode);
  // 字体
  const font = readFontFromUI();
  applyFonts(font);
  await saveFontSettings(font);
  document.getElementById('bgFile').value = '';
  delete document.getElementById('bgFile').dataset.pending;
  document.getElementById('themeModal').classList.remove('show');
}

async function clearBgSettings(){
  await clearBackground();
  applyBackground(null, 0.82, 'cover');
  document.getElementById('bgFile').value = '';
  delete document.getElementById('bgFile').dataset.pending;
  updateBgPreview(null);
  document.getElementById('themeModal').classList.remove('show');
}

function closeBgSettings(){
  document.getElementById('themeModal').classList.remove('show');
  // 未保存的预览还原
  applyAppearance();
}

/* ---------------- 机器翻译 UI ---------------- */

// 单文件 HTML 版(浏览器)隐藏本地机翻入口
function hideMTUI(){
  for (const id of ['mtProvider', 'btnMTSettings', 'btnMT', 'btnMTBatch']){
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

/** 刷新下拉里各 provider 的「（未配置）」标记(配置加载/保存/切换后调用) */
function refreshMTProviderOptions(){
  for (const opt of $mtProvider.options){
    const p = mt.getProvider(opt.value);
    if (p) opt.textContent = '🤖 ' + p.name + (p.isConfigured() ? '' : '（未配置）');
  }
}

async function initMT(){
  // 先加载并迁移配置,isConfigured 才准确(否则下拉会全部显示「未配置」)
  await mt.ensureProviderConfigs().catch(() => {});
  const provs = mt.getProviders();
  $mtProvider.innerHTML = '';
  for (const p of provs){
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = '🤖 ' + p.name + (p.isConfigured() ? '' : '（未配置）');
    $mtProvider.appendChild(opt);
  }
  const st = await mt.getMTSettings().catch(() => ({}));
  if (st.provider && mt.getProvider(st.provider)) $mtProvider.value = st.provider;
  updateMTButtons();
}

async function setMTProvider(id){
  const st = await mt.getMTSettings();
  st.provider = id;
  await mt.saveMTSettings(st);
  refreshMTProviderOptions();
  updateMTButtons();
}

/* ---- 机翻配置弹窗: 按引擎动态渲染表单 ---- */

function mtField(label, html, hint){
  return '<div class="field"><label>' + label + '</label>' + html + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
}
function mtInput(id, value, ph){
  return '<input type="text" id="' + id + '" value="' + String(value || '').replace(/"/g, '&quot;') + '" placeholder="' + (ph || '') + '" autocomplete="off">';
}
function mtNum(id, value, min, max){
  return '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" step="any" value="' + value + '">';
}
function mtCheck(id, label, checked){
  return '<label class="check-label modal-check"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>';
}
/** 采样参数网格: [{label,id,value,min,max}] → 每参数一列 */
function mtParams(list){
  return '<div class="mt-params">' + list.map(p =>
    '<div class="p"><label>' + p.label + '</label>' + mtNum(p.id, p.value, p.min, p.max) + '</div>'
  ).join('') + '</div>';
}

function mtFormLlm(conf){
  const page1 =
    mtField('接口地址（OpenAI 兼容，如 https://api.openai.com/v1）', mtInput('mtBaseUrl', conf.baseUrl, 'https://api.openai.com/v1')) +
    mtField('API Key（留空则不发送；llama.cpp 本地可留空）', mtInput('mtApiKey', conf.apiKey, 'sk-…')) +
    mtField('模型名', mtInput('mtModel', conf.model, 'gpt-4o-mini')) +
    mtField('系统提示词（留空使用默认翻译提示词）',
      '<textarea id="mtSystem" rows="3" placeholder="You are a translator…">' + String(conf.systemPrompt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</textarea>') +
    mtField('多轮上下文（>0 时翻译/批量自动附带最近 N 句原文与译文，使人物语气、指代更连贯；批量逐句累积，切引擎/改配置后清空）', mtNum('mtContextTurns', conf.contextTurns, 0, 20));
  const page2 =
    mtField('采样参数', mtParams([
      { label: '温度 temperature', id: 'mtTemperature', value: conf.temperature, min: 0, max: 2 },
      { label: 'top_p', id: 'mtTopP', value: conf.topP, min: 0, max: 1 },
      { label: 'max_tokens', id: 'mtMaxTokens', value: conf.maxTokens, min: 1, max: 32768 },
      { label: 'frequency_penalty', id: 'mtFreqPenalty', value: conf.frequencyPenalty, min: -2, max: 2 },
    ])) +
    mtField('选项', mtCheck('mtStreaming', '流式输出（翻译当前行时逐字显示）', conf.streaming) +
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary));
  return '<div id="mtP0">' + page1 + '</div><div id="mtP1" class="hidden">' + page2 + '</div>';
}

function mtFormSakura(conf){
  const page1 =
    mtField('Sakura / llama.cpp 服务地址（Sakura_Launcher_GUI 或 llama-server 显示的地址/端口）',
      '<div class="row">' + mtInput('mtHost', conf.host, 'http://127.0.0.1:8080') +
      '<button id="btnMtDetect" class="toolbtn secondary nowrap">检测端口</button></div>') +
    mtField('模型名（用于提示词版本自动识别，可留空）', mtInput('mtModel', conf.model, '如 sakura-qwen2.5-7b-v1.0')) +
    mtField('提示词版本（auto=按模型名自动识别）',
      '<select id="mtPromptVersion">' + mt.SAKURA_PROMPT_VERSIONS.map(v => '<option value="' + v + '"' + (conf.promptVersion === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>');
  const page2 =
    mtField('采样参数', mtParams([
      { label: '温度 temperature', id: 'mtTemperature', value: conf.temperature, min: 0, max: 2 },
      { label: 'top_p', id: 'mtTopP', value: conf.topP, min: 0, max: 1 },
      { label: 'max_tokens', id: 'mtMaxTokens', value: conf.maxTokens, min: 1, max: 32768 },
    ])) +
    mtField('选项', mtCheck('mtStreaming', '流式输出（翻译当前行时逐字显示）', conf.streaming) +
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary));
  return '<div id="mtP0">' + page1 + '</div><div id="mtP1" class="hidden">' + page2 + '</div>';
}

/* ---- 机翻/主题配置 tab 切换 ---- */
function mtSwitchTab(btn){
  for (const b of document.querySelectorAll('#mtTabs button')) b.classList.toggle('active', b === btn);
  const p = Number(btn.dataset.mtpage) || 0;
  document.getElementById('mtP0').classList.toggle('hidden', p !== 0);
  document.getElementById('mtP1').classList.toggle('hidden', p !== 1);
}
function thSwitchTab(btn){
  for (const b of document.querySelectorAll('#thTabs button')) b.classList.toggle('active', b === btn);
  const p = Number(btn.dataset.thpage) || 0;
  document.getElementById('thPage0').classList.toggle('hidden', p !== 0);
  document.getElementById('thPage1').classList.toggle('hidden', p !== 1);
}

function renderMTForm(providerId, conf){
  const form = document.getElementById('mtForm');
  const id = providerId === 'sakura' ? 'sakura' : 'llm';
  form.innerHTML = (id === 'sakura' ? mtFormSakura(conf) : mtFormLlm(conf));
  // 重置到第 1 页「连接与模型」
  mtSwitchTab(document.querySelector('#mtTabs button[data-mtpage="0"]'));
  // 检测端口按钮在 Sakura 表单内,每次渲染后重新绑定(元素已重建)
  const detectBtn = document.getElementById('btnMtDetect');
  if (detectBtn) detectBtn.addEventListener('click', detectSakuraPorts);
}

// 打开机翻配置弹窗(按当前选中引擎渲染)
async function openMTSettings(){
  const sel = document.getElementById('mtProviderSel');
  sel.value = ($mtProvider.value === 'sakura') ? 'sakura' : 'llm';
  const conf = await mt.getProviderConfig(sel.value);
  renderMTForm(sel.value, conf);
  const hint = document.getElementById('mtHint');
  hint.innerHTML = '通用大模型：任意 OpenAI 兼容服务（含各类中转/自建网关），也兼容 llama.cpp 本地 server（填 http://127.0.0.1:8080、Key 留空）。<br>' +
    'Sakura 本地：先用 Sakura_Launcher_GUI 加载 Sakura 模型并启动服务，或直接用 llama.cpp 的 llama-server（默认端口 8080）。<br>' +
    '翻译按钮在顶部工具栏右侧：「翻译当前行」/「批量翻译」。';
  document.getElementById('mtTestIn').value = '';
  document.getElementById('mtTestOut').textContent = '';
  document.getElementById('mtModal').classList.add('show');
}

function mtSelChanged(){
  mt.getProviderConfig(document.getElementById('mtProviderSel').value).then(conf => renderMTForm(document.getElementById('mtProviderSel').value, conf));
}

// 检测常见端口,列出可用的填入地址栏
async function detectSakuraPorts(){
  const out = document.getElementById('mtTestOut');
  out.textContent = '正在扫描常见端口…';
  const ports = await mt.probeSakuraPorts();
  if (!ports.length){
    out.textContent = '未发现正在运行的 Sakura / llama.cpp 服务。\n请先启动服务并加载模型,再点「检测端口」。';
    return;
  }
  const host = 'http://127.0.0.1:' + ports[0];
  document.getElementById('mtHost').value = host;
  out.textContent = '发现可用服务: ' + ports.map(p => '127.0.0.1:' + p).join('、') + '\n已填入第一个,可切换后点「测试翻译」验证。';
}

// 从表单读当前引擎配置(不落盘),供测试/保存
function readMTFormConfig(){
  const sel = document.getElementById('mtProviderSel').value;
  if (sel === 'sakura'){
    return {
      host: document.getElementById('mtHost').value.trim(),
      model: document.getElementById('mtModel').value.trim(),
      promptVersion: document.getElementById('mtPromptVersion').value,
      useGlossary: document.getElementById('mtUseGlossary').checked,
      streaming: document.getElementById('mtStreaming').checked,
      temperature: Number(document.getElementById('mtTemperature').value),
      topP: Number(document.getElementById('mtTopP').value),
      maxTokens: Number(document.getElementById('mtMaxTokens').value),
    };
  }
  return {
    baseUrl: document.getElementById('mtBaseUrl').value.trim(),
    apiKey: document.getElementById('mtApiKey').value.trim(),
    model: document.getElementById('mtModel').value.trim(),
    systemPrompt: document.getElementById('mtSystem').value,
    useGlossary: document.getElementById('mtUseGlossary').checked,
    streaming: document.getElementById('mtStreaming').checked,
    contextTurns: Number(document.getElementById('mtContextTurns').value),
    frequencyPenalty: Number(document.getElementById('mtFreqPenalty').value),
    temperature: Number(document.getElementById('mtTemperature').value),
    topP: Number(document.getElementById('mtTopP').value),
    maxTokens: Number(document.getElementById('mtMaxTokens').value),
  };
}

// 测试翻译一句
async function testMT(){
  const text = document.getElementById('mtTestIn').value.trim();
  if (!text){ alert('请先输入要测试的日文。'); return; }
  const sel = document.getElementById('mtProviderSel').value;
  const cfg = readMTFormConfig();
  if (sel === 'sakura' && !cfg.host){
    alert('请填写 Sakura / llama.cpp 服务地址（或点「检测端口」）。');
    return;
  }
  if (sel === 'llm' && (!cfg.baseUrl || !cfg.model)){
    alert('请填写接口地址与模型名。');
    return;
  }
  const out = document.getElementById('mtTestOut');
  out.textContent = '翻译中…（本地模型可能需要几秒）';
  try {
    // 临时套用 UI 配置做测试(不落盘),失败时还原
    const prev = await mt.getProviderConfig(sel);
    await mt.setProviderConfig(sel, cfg);
    try {
      const result = await mt.translateText(sel, text, glossData);
      out.textContent = '日文: ' + text + '\n译文: ' + result;
    } finally {
      await mt.setProviderConfig(sel, prev);
    }
  } catch (e){
    out.textContent = '翻译失败: ' + e.message;
  }
}

async function saveMTSettingsUI(){
  const sel = document.getElementById('mtProviderSel').value;
  const cfg = readMTFormConfig();
  if (sel === 'sakura' && !cfg.host){
    alert('请填写 Sakura / llama.cpp 服务地址（或点「检测端口」自动查找）。');
    return;
  }
  if (sel === 'llm' && (!cfg.baseUrl || !cfg.model)){
    alert('请填写接口地址与模型名。');
    return;
  }
  await mt.setProviderConfig(sel, cfg);
  // 同步选择当前 provider
  const st = await mt.getMTSettings();
  st.provider = sel;
  await mt.saveMTSettings(st);
  $mtProvider.value = sel;
  refreshMTProviderOptions();
  updateMTButtons();
  document.getElementById('mtModal').classList.remove('show');
  alert('已保存「' + (sel === 'sakura' ? 'Sakura 本地' : '通用大模型') + '」配置。\n顶部「翻译当前行」/「批量翻译」即可使用。');
}

function closeMTSettings(){
  document.getElementById('mtModal').classList.remove('show');
}

function currentActiveIdx(){
  const i = rdr.getActiveIdx();
  if (i >= 0) return i;
  return matches.length ? matches[matchIndex].i : 0;
}

async function mtTranslateCurrent(){
  const i = currentActiveIdx();
  const p = model.getPara(i);
  if (!p){ alert('请先导入文件'); return; }
  if (p.isName) return; // NAME 条目不机翻
  model.pushUndo([i]);
  clearPushTimers();
  let first = true;      // 流式第一块到达前保持原文可见
  let lastPaint = 0;
  const paint = () => {
    const now = Date.now();
    if (now - lastPaint > 120){ lastPaint = now; rdr.refreshRow(i); } // 节流刷新
  };
  try {
    const result = await mt.translateText($mtProvider.value, p.content, glossData, (chunk) => {
      if (first){ p.translation = ''; first = false; }
      p.translation = (p.translation || '') + chunk;
      paint();
    });
    // 清理返回: 去首尾「」防双括号,再按行类型包回
    const cleaned = stripBrackets(String(result).trim());
    p.translation = p.brackets ? ('「' + cleaned + '」') : cleaned;
    model.recalcDone(p);
    model.scheduleAutosave();
    rdr.refreshRow(i);
    updateProgress();
  } catch (e){
    // 流式中途失败: 保留已输出的部分译文
    if (first) p.translation = '';
    rdr.refreshRow(i);
    alert(e.message || '翻译失败');
  }
}

async function mtTranslateBatch(){
  const paras = model.getParas();
  const pending = [];
  paras.forEach((p, i) => {
    if (!p.isName && !p.done) pending.push(i);
  });
  if (!pending.length){ alert('没有未翻译的行。'); return; }
  if (!confirm('将批量翻译 ' + pending.length + ' 个未翻译的行（串行调用本地模型，可能需要几分钟）。\n开始吗？')) return;

  model.pushUndo(pending);
  clearPushTimers();
  const fnameEl = document.getElementById('fname');
  const origFname = fnameEl.textContent;
  let ok = 0;
  const failed = [];
  for (let k = 0; k < pending.length; k++){
    const i = pending[k];
    const p = paras[i];
    fnameEl.textContent = '🔄 批量机翻中 ' + (k + 1) + ' / ' + pending.length + ' …';
    try {
      const res = await mt.translateText($mtProvider.value, p.content, glossData);
      // 清理返回内容: 去掉首尾「」(防止模型自带括号导致「「…」」双括号),再按行类型包回
      const cleaned = stripBrackets(String(res).trim());
      p.translation = p.brackets ? ('「' + cleaned + '」') : cleaned;
      model.recalcDone(p);
      ok++;
      rdr.refreshRow(i); // 实时刷新该行
    } catch (e){
      failed.push({ i, err: e.message });
    }
  }
  fnameEl.textContent = origFname;
  model.scheduleAutosave();
  recomputeMatchesUI(true);
  updateProgress();
  if (failed.length){
    alert('批量翻译完成：成功 ' + ok + ' 行，失败 ' + failed.length + ' 行。\n失败原因示例：' + failed[0].err);
  } else {
    alert('批量翻译完成：' + ok + ' 行。');
  }
}

/* ---------------- 侧边栏 / 文件夹浏览器 ---------------- */

let dirState = { activePath: '' };

function syncSidebarTop(){
  const tb = document.getElementById('topbar');
  const main = document.getElementById('main');
  const list = document.getElementById('list');
  const footer = document.querySelector('footer');
  if (!tb || !main || !list) return;
  const h = tb.offsetHeight;
  const fh = footer ? footer.offsetHeight : 0;
  // 侧栏是 #main 的 flex 子元素(随行高伸展),不再设置 top/maxHeight
  // (旧固定定位方案的遗留赋值,与 #sidebar 的 position:relative 冲突会把侧栏顶下去)
  // 列表区固定为视口剩余高度(减去 footer),#list 显式设高保证滚动容器稳定
  // (虚拟滚动依赖稳定的 clientHeight 与 scrollTop 行为)
  main.style.height = 'calc(100vh - ' + h + 'px - ' + fh + 'px)';
  list.style.height = 'calc(100vh - ' + h + 'px - ' + fh + 'px)';
}

function setSidebar(open){
  document.getElementById('sidebar').classList.toggle('hidden', !open);
  if (open) syncSidebarTop();
}

/* ---- 侧边栏拖拽调宽: 左缘手柄,宽度记忆在 localStorage,双击复位 ---- */

const SB_W_KEY = 'galtrans_sidebar_width';
const SB_W_MIN = 260, SB_W_DEFAULT = 400;

function sidebarMaxWidth(){ return Math.min(760, window.innerWidth - 300); }

function initSidebarResize(){
  const sb = document.getElementById('sidebar');
  const handle = document.getElementById('sbResize');
  if (!sb || !handle) return;
  let saved = parseInt(localStorage.getItem(SB_W_KEY), 10);
  if (saved >= SB_W_MIN) sb.style.width = Math.min(saved, sidebarMaxWidth()) + 'px';
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault(); // 避免拖动时选中文本
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.round(Math.min(Math.max(window.innerWidth - e.clientX, SB_W_MIN), sidebarMaxWidth()));
    sb.style.width = w + 'px'; // 列表区自动让位,虚拟滚动经 ResizeObserver 重测行宽
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    const w = parseInt(sb.style.width, 10);
    if (w >= SB_W_MIN){
      try { localStorage.setItem(SB_W_KEY, String(w)); } catch (e) {}
    }
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', () => {
    sb.style.width = '';
    try { localStorage.removeItem(SB_W_KEY); } catch (e) {}
  });
}

function switchSidebarTab(name){
  document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('panel-files').classList.toggle('hidden', name !== 'files');
  document.getElementById('panel-glossary').classList.toggle('hidden', name !== 'glossary');
  const pd = document.getElementById('panel-dict');
  if (pd) pd.classList.toggle('hidden', name !== 'dict');
  const pp = document.getElementById('panel-proof');
  if (pp) pp.classList.toggle('hidden', name !== 'proof');
  if (name === 'proof') renderProofPanel();
}

async function pickFolder(){
  let dir, entries;
  if (fsx.isTauri()){
    dir = await fsx.pickDirDialog();
    if (!dir) return;
    document.getElementById('folderName').textContent = '📂 ' + dir.split(/[\\/]/).pop();
    entries = await fsx.listDirTree(dir);
  } else {
    try {
      dir = await fsx.pickBrowserDir();
    } catch (e){
      alert(e.message);
      return;
    }
    if (!dir) return;
    document.getElementById('folderName').textContent = '📂 ' + dir.name;
    entries = await fsx.listBrowserDir(dir);
  }
  document.getElementById('sideHint').style.display = 'none';
  try {
    buildFileTree(entries);
  } catch (e){
    alert('无法读取文件夹: ' + e.message);
  }
}

// entries: [{ name, path?, kind, depth, handle? }] 已按 目录在前/名称→扩展名 排序
function buildFileTree(entries){
  const tree = document.getElementById('fileTree');
  tree.innerHTML = '';
  const roots = [];
  const stack = []; // { depth, childrenEl, parentEl }
  for (const en of entries){
    const depth = en.depth;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parentEl = stack.length ? stack[stack.length - 1].childrenEl : tree;
    if (en.kind === 'directory'){
      const item = document.createElement('div');
      item.className = 'tree-item tree-dir collapsed';
      const caret = document.createElement('span');
      caret.className = 'caret'; caret.textContent = '▾';
      const label = document.createElement('span');
      label.className = 'lbl'; label.textContent = '📁 ' + en.name;
      const children = document.createElement('div');
      children.className = 'tree-children collapsed';
      item.append(caret, label);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const was = children.classList.contains('collapsed');
        children.classList.toggle('collapsed', !was);
        item.classList.toggle('collapsed', !was);
      });
      parentEl.append(item, children);
      stack.push({ depth, childrenEl: children });
    } else {
      const item = document.createElement('div');
      item.className = 'tree-item tree-file';
      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      const label = document.createElement('span');
      label.className = 'fname'; label.textContent = '📄 ' + en.name;
      item.append(spacer, label);
      item.title = en.path || en.name;
      item.addEventListener('click', async () => {
        document.querySelectorAll('#fileTree .tree-item.active').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        try {
          if (en.handle){
            // 浏览器端: 拿句柄 → 可写回原文件
            fsx.setBrowserFileHandle(en.handle);
            const f = await en.handle.getFile();
            await loadSource(f, en.name);
          } else {
            await loadSource({ path: en.path }, en.name);
          }
        } catch (err){ alert('无法打开文件:' + err.message); }
      });
      parentEl.appendChild(item);
      roots.push(item);
    }
  }
  if (!roots.length && !entries.length){
    tree.innerHTML = '<div class="side-hint">文件夹中没有文件</div>';
  }
}

/* ---------------- 事件绑定 ---------------- */

function initEvents(){
  document.getElementById('btnImport').addEventListener('click', importWithPicker);
  document.getElementById('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await loadSource(f, f.name);
    e.target.value = '';
  });
  document.getElementById('btnSaveFile').addEventListener('click', saveDirect);
  document.getElementById('btnSave').addEventListener('click', exportFile);
  document.getElementById('btnRestore').addEventListener('click', restoreProgress);
  document.getElementById('btnClear').addEventListener('click', clearAll);
  document.getElementById('btnClearProgress').addEventListener('click', clearProgress);
  document.getElementById('btnTheme').addEventListener('click', toggleTheme);
  // 主题设置(主题模式 + 背景 + 字体)
  document.getElementById('btnThemeModal').addEventListener('click', openThemeSettings);
  document.querySelectorAll('input[name="thMode"]').forEach(r => {
    r.addEventListener('change', () => applyTheme(r.value));
  });
  document.getElementById('foReset').addEventListener('click', resetOrigFont);
  document.getElementById('ftReset').addEventListener('click', resetTransFont);
  // 字体/字号/颜色实时预览(输入即生效,保存才落盘)
  for (const id of ['foFamily', 'foSize', 'foColor', 'ftFamily', 'ftSize', 'ftColor']){
    document.getElementById(id).addEventListener('input', previewFontFromUI);
  }
  document.getElementById('bgFile').addEventListener('change', onBgFileChange);
  document.getElementById('bgOpacity').addEventListener('input', () => {
    updateBgOpacityLabel();
    const pending = document.getElementById('bgFile').dataset.pending;
    if (pending) previewBg(pending);
  });
  document.getElementById('bgFit').addEventListener('change', () => {
    const pending = document.getElementById('bgFile').dataset.pending;
    if (pending) previewBg(pending);
  });
  document.getElementById('btnBgSave').addEventListener('click', saveBgSettings);
  document.getElementById('btnBgClear').addEventListener('click', clearBgSettings);
  document.getElementById('btnBgCancel').addEventListener('click', closeBgSettings);
  document.getElementById('themeModal').addEventListener('click', (e) => {
    if (e.target.id === 'themeModal') closeBgSettings();
  });

  // 解析规则设置 + 格式识别(合并弹窗)
  document.getElementById('btnParseSet').addEventListener('click', openParseSettings);
  document.getElementById('btnSetSave').addEventListener('click', saveParseSettings);
  document.getElementById('btnSetCancel').addEventListener('click', cancelParseSettings);
  document.getElementById('btnTestParse').addEventListener('click', testParseRule);
  document.getElementById('setModal').addEventListener('click', (e) => {
    if (e.target.id === 'setModal') cancelParseSettings();
  });
  document.getElementById('setTestIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); testParseRule(); }
  });

  // 文本格式识别(合并到规则弹窗内)
  document.getElementById('recogSrcFile').addEventListener('change', toggleRecogSource);
  document.getElementById('recogSrcPaste').addEventListener('change', toggleRecogSource);
  document.getElementById('btnRecogPick').addEventListener('click', pickRecogFile);
  document.getElementById('btnRecogRun').addEventListener('click', runRecognize);
  document.getElementById('btnRecogApply').addEventListener('click', applyRecogConfig);
  document.getElementById('btnRecogLoad').addEventListener('click', loadCanonicalIntoEditor);
  document.getElementById('btnRecogProfile').addEventListener('click', downloadRecogProfile);
  document.getElementById('btnRecogCanon').addEventListener('click', downloadRecogCanonical);

  document.getElementById('btnUndo').addEventListener('click', doUndo);
  document.getElementById('btnRedo').addEventListener('click', doRedo);

  // 搜索栏
  $q.addEventListener('input', recomputeMatchesUI);
  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape'){ $q.blur(); }
  });
  $r.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); replaceCurrent(); }
  });
  $scope.addEventListener('change', recomputeMatchesUI);
  $mcase.addEventListener('change', recomputeMatchesUI);
  document.getElementById('btnPrev').addEventListener('click', () => gotoMatch(-1));
  document.getElementById('btnNext').addEventListener('click', () => gotoMatch(1));
  document.getElementById('btnReplace').addEventListener('click', replaceCurrent);
  document.getElementById('btnReplaceAll').addEventListener('click', replaceAll);
  document.getElementById('btnJump').addEventListener('click', jumpToLine);
  document.getElementById('btnNextTodo').addEventListener('click', jumpToNextUntranslated);
  document.getElementById('jumpInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); jumpToLine(); }
  });

  // 机器翻译
  $mtProvider.addEventListener('change', () => setMTProvider($mtProvider.value));
  document.getElementById('btnMTSettings').addEventListener('click', openMTSettings);
  document.getElementById('mtProviderSel').addEventListener('change', mtSelChanged);
  document.querySelectorAll('#mtTabs button').forEach(b => b.addEventListener('click', () => mtSwitchTab(b)));
  document.querySelectorAll('#thTabs button').forEach(b => b.addEventListener('click', () => thSwitchTab(b)));
  document.getElementById('btnMtTest').addEventListener('click', testMT);
  document.getElementById('mtTestIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); testMT(); }
  });
  // 检测端口按钮在 Sakura 表单内,由 renderMTForm 渲染后绑定
  document.getElementById('mtModal').addEventListener('click', (e) => {
    if (e.target.id === 'mtModal') closeMTSettings();
  });
  document.getElementById('btnMtSave').addEventListener('click', saveMTSettingsUI);
  document.getElementById('btnMtCancel').addEventListener('click', closeMTSettings);
  document.getElementById('btnMT').addEventListener('click', mtTranslateCurrent);
  document.getElementById('btnMTBatch').addEventListener('click', mtTranslateBatch);

  // 侧边栏
  document.getElementById('btnSidebar').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    setSidebar(sb.classList.contains('hidden'));
  });
  document.getElementById('btnSidebarClose').addEventListener('click', () => setSidebar(false));
  document.querySelectorAll('.side-tab[data-tab]').forEach(b => {
    b.addEventListener('click', () => switchSidebarTab(b.dataset.tab));
  });
  document.getElementById('btnPickFolder').addEventListener('click', pickFolder);

  // 校对模式
  document.getElementById('btnProof').addEventListener('click', toggleProofMode);
  document.querySelectorAll('.proof-filter').forEach(b => {
    b.addEventListener('click', () => setProofFilter(b.dataset.pf));
  });
  document.getElementById('btnNextIssue').addEventListener('click', jumpNextIssue);
  document.getElementById('btnMissing').addEventListener('click', openMissingList);
  document.getElementById('btnProofKeys').addEventListener('click', openProofKeys);
  document.getElementById('btnKeysSave').addEventListener('click', saveProofKeys);
  document.getElementById('btnKeysCancel').addEventListener('click', () => {
    if (keysBackup) proof.setKeys(keysBackup);
    document.getElementById('keysModal').classList.remove('show');
    recordingAction = null;
  });
  document.getElementById('btnKeysReset').addEventListener('click', resetProofKeys);
  document.getElementById('keysModal').addEventListener('click', (e) => {
    if (e.target.id === 'keysModal'){
      if (keysBackup) proof.setKeys(keysBackup);
      document.getElementById('keysModal').classList.remove('show');
      recordingAction = null;
    }
  });
  // 侧栏校对面板: 批注总览 / 修改记录 切换
  document.querySelectorAll('.proof-view-tab[data-pv]').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.pv;
      proof.setViewTab(v);
      document.querySelectorAll('.proof-view-tab[data-pv]').forEach(x => x.classList.toggle('active', x.dataset.pv === v));
      document.getElementById('pv-anno').classList.toggle('hidden', v !== 'anno');
      document.getElementById('pv-missing').classList.toggle('hidden', v !== 'missing');
      document.getElementById('pv-log').classList.toggle('hidden', v !== 'log');
      renderProofPanel();
    });
  });
  document.getElementById('btnLogRefresh').addEventListener('click', renderProofPanel);

  // 术语表
  document.getElementById('btnNameAdd').addEventListener('click', () => addGlossEntry('name'));
  document.getElementById('btnTermAdd').addEventListener('click', () => addGlossEntry('term'));
  document.getElementById('btnGlossImport').addEventListener('click', glossImport);
  document.getElementById('btnGlossExport').addEventListener('click', glossExport);
  document.getElementById('btnGlossExportCsv').addEventListener('click', glossExportCsv);
  document.getElementById('btnGlossApply').addEventListener('click', glossApply);

  // 词典 / 快捷片段
  document.getElementById('btnDictLookup').addEventListener('click', () => doDictLookup(document.getElementById('dictInput').value));
  document.getElementById('btnFavClear').addEventListener('click', () => {
    dictFavorites = [];
    saveDictFavorites().then(renderDictFavorites);
  });
  document.getElementById('dictInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); doDictLookup(e.target.value); }
  });
  document.getElementById('btnDictAddJson').addEventListener('click', addJsonDictSource);
  document.getElementById('btnDictAddMdx').addEventListener('click', addMdxSource);
  document.getElementById('btnDictAddHttp').addEventListener('click', () => openDictHttpModal(null));
  document.getElementById('btnDhSave').addEventListener('click', saveDictHttpSource);
  document.getElementById('btnDhCancel').addEventListener('click', closeDictHttpModal);
  document.getElementById('btnDhTest').addEventListener('click', testDictHttp);
  document.getElementById('dhTestIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); testDictHttp(); }
  });
  document.getElementById('dictHttpModal').addEventListener('click', (e) => {
    if (e.target.id === 'dictHttpModal') closeDictHttpModal();
  });
  document.querySelectorAll('.proof-view-tab[data-dv]').forEach(b => {
    b.addEventListener('click', () => switchDictView(b.dataset.dv));
  });
  document.getElementById('btnSnipAdd').addEventListener('click', addSnippet);

  // 拖拽导入
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 浏览器: 拖入的 File 可直接读取
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f){
      try {
        await loadSource(f, f.name);
        return;
      } catch (err){
        alert('无法读取拖入的文件: ' + err.message);
      }
    }
    alert('拖拽仅支持本机文件。桌面版也可用「导入文本」选择文件。');
  });

  // 桌面版: 拖拽文件路径由 Rust 窗口事件下发(Webview 拦截了 HTML5 drop)
  if (fsx.isTauri()){
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('galtrans-drag-drop', (ev) => {
        const paths = ev.payload;
        if (!paths || !paths.length) return;
        const p = String(paths[0]);
        if (!/\.(txt|ks|ks\.txt)$/i.test(p)) {
          alert('仅支持打开 .txt / .ks 文本文件。');
          return;
        }
        loadSource({ path: p }, p.split(/[\\/]/).pop() || p).catch(err => alert('无法打开拖入的文件: ' + err.message));
      });
    }).catch(() => {});
  }

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    // 校对快捷键录制(弹窗打开时优先拦截)
    if (recordingAction){ recordKeyEvent(e); return; }
    const key = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's'){ e.preventDefault(); saveDirect(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'f'){ e.preventDefault(); $q.focus(); $q.select(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'g'){ e.preventDefault(); document.getElementById('jumpInput').focus(); document.getElementById('jumpInput').select(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'z'){ e.preventDefault(); doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'y'){ e.preventDefault(); doRedo(); return; }
    if (e.key === 'F3'){ e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F2'){ e.preventDefault(); jumpToNextUntranslated(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); replaceCurrent(); return; }
    // 校对快捷键: 单键(q/w/a)需校对模式开启且焦点在译文/译名框;组合键任意位置可用
    if (proof.isEnabled() || Object.values(proof.proofKeys).some(k => k && /^(Ctrl|Shift|Alt)\+/.test(k))){
      for (const act of PROOF_KEY_ACTIONS){
        const combo = proof.proofKeys[act.id];
        if (!combo || !keyComboMatch(e, combo) || e.isComposing) continue;
        const isPlain = !/^(Ctrl|Shift|Alt)\+/.test(combo);
        const target = e.target;
        const inInput = target && target.classList && (target.classList.contains('trans') || target.classList.contains('pname-input'));
        if (act.id === 'toggleMode'){
          if (isPlain && inInput) continue; // 单键在输入框里不触发开关
        } else if (!proof.isEnabled() || (isPlain && !inInput)){
          continue; // 其余动作需校对模式 + (单键需在输入框内)
        }
        e.preventDefault();
        act.fn();
        return;
      }
    }
  });

  window.addEventListener('resize', () => {
    syncSidebarTop();
    rdr.remeasureAll();
  });
}

function afterUndoRedo(){
  clearPushTimers();
  rdr.refreshAllRows();
  recomputeMatchesUI(true); // 撤销/重做后强制全量同步影子(可能多行变化,增量难追)
  updateProgress();
  updateUndoButtons();
  model.scheduleAutosave();
}

/* ---------------- 关闭前兜底保存(仅浏览器版) ---------------- */

// 桌面版: 不注册任何 onCloseRequested —— Tauri v2 中该事件的处理细节可能阻塞窗口关闭,
// 曾导致右上角 ✕ 关不掉窗口(不可接受)。自动保存 250ms 防抖已足够覆盖绝大多数输入,
// 关闭瞬间丢失最后 250ms 的代价远小于窗口关不掉。
// 浏览器版: beforeunload 尽力同步写(不等待异步,无害)。
function setupCloseFlush(){
  if (fsx.isTauri()) return;
  window.addEventListener('beforeunload', () => {
    model.flushAutosave().catch(() => {});
    proof.flushSave().catch(() => {});
  });
}

/* ---------------- 启动 ---------------- */

async function init(){
  await applyAppearance(); // 主题模式(含旧 localStorage 迁移) + 字体 + 背景图
  setupCloseFlush(); // 关闭前强制保存(最后一次输入不丢)
  // 加载设置并应用解析规则
  const settings = await loadSettings();
  setParseConf(settings.parse || {});
  proof.setKeys(settings.proof && settings.proof.keys); // 校对快捷键
  glossData = await gloss.loadGlossaryForProject(null); // 未打开文件 → 全局术语表
  renderGlossTables();
  updateGlossProjectLabel();
  await ensureDictSettings();   // 词典源配置 + 重建 Provider
  rebuildDictProviders();
  renderDictSourceList();
  await initSnippets();         // 全局快捷片段
  await initDictFavorites();    // 词典收藏
  if (!fsx.isTauri()) hideMTUI(); // 单文件 HTML 版不含本地机翻
  initMT();
  initEvents();
  initSidebarResize(); // 侧边栏拖拽调宽(恢复上次宽度)
  syncSidebarTop();
  updateUndoButtons();
  setSidebar(true);
  // 开发调试: ?autoload=<文件名> 在 Vite dev 下直接 fetch 加载本地文本(生产 file:// 下无参数不触发)
  const autoload = new URLSearchParams(location.search).get('autoload');
  // 开发调试: ?mdx=<文件名> 在 Vite dev 下 fetch 本地 .mdx 加载为词典源(生产同上不触发);
  // 配合 ?dict=<词> 在加载完成后自动查询一次(冒烟测试用)
  const mdxParam = new URLSearchParams(location.search).get('mdx');
  const dictParam = new URLSearchParams(location.search).get('dict');
  if (mdxParam){
    // 支持逗号分隔多个文件;走懒加载 Provider(与桌面版路径持久化同一代码路径)
    const files = mdxParam.split(',').filter(Boolean);
    (async () => {
      for (const f of files){
        try {
          const name = decodeURIComponent(f.split(/[\\/]/).pop() || 'dict').replace(/\.mdx$/i, '');
          // 开发参数幂等: 先清掉之前 reload 遗留的失效 MDX 会话源
          dictSettings.sources = dictSettings.sources.filter(s => !(s.type === 'mdx' && !mdxProviders.has(s.id)));
          const prov = createPathMdxProvider({
            name,
            loadBuffer: async () => {
              const resp = await fetch('/' + f);
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              return resp.arrayBuffer();
            },
          });
          const src = { id: prov.id, type: 'mdx', name: prov.name, session: true, enabled: true };
          mdxProviders.set(src.id, prov);
          dictSettings.sources.push(src);
          await saveDictSettings();
          rebuildDictProviders();
          renderDictSourceList();
        } catch (err){
          console.error('[mdx] 加载失败:', f, err);
          renderDictResults({ word: String(f), results: [], errors: [{ source: '[dev] mdx', message: String((err && err.message) || err) }] });
        }
      }
      if (dictParam) doDictLookup(dictParam);
    })();
  }
  if (autoload){
    fetch('/' + autoload)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(async t => {
        const parsed = parseFile(t);
        model.setParas(parsed.paras);
        model.setFileInfo({ name: autoload, path: null, nl: parsed.nl, trailingBlank: parsed.trailingBlank });
        const applied = gloss.applyNames(model.getParas(), glossData.names);
        if (applied) model.scheduleAutosave();
        document.getElementById('fname').textContent = '当前文件：' + autoload;
        rdr.fullRender();
        recomputeMatchesUI(true);
        rdr.focusIdx(0);
        updateUndoButtons();
        updateProgress(); // autoload 加载后刷新字数统计
      })
      .catch(err => console.error('[autoload] 加载失败:', err));
  }
}

init();
