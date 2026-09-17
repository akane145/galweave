// main.js — 应用入口 / 模块编排
// 职责: 初始化各模块,绑定事件,编排 导入/导出/保存/搜索/术语表/机翻/文件夹 流程。

import { parseFile, buildExport, transValue, stripBrackets, setParseConf, getParseConf, parsePrefix, validateParseConf, migrateNameTranslations as migrateNameTranslationsPure, mergeSavedState } from './parsers.js';
import { loadSettings, saveSettings, loadBackground, saveBackground, clearBackground, loadFontSettings, saveFontSettings, loadFontLibrary, saveFontLibrary, loadTextAreaTransparency, saveTextAreaTransparency, loadThemeMode, saveThemeMode, loadFavorites, saveFavorites, loadDensity, saveDensity, loadByteEncoding, saveByteEncoding, loadByteLimit, saveByteLimit, loadDictHistory, saveDictHistory } from './settings.js';
import * as theme from './theme.js';
import * as fonts from './fonts.js';
import * as fontloader from './fontloader.js';
import * as model from './model.js';
import * as rdr from './renderer.js';
import * as s from './search.js';
import * as wkr from './workers-client.js';
import * as dbx from './db.js';
import { debounce } from './debounce.js';
import * as tb from './tabdock.js';
import * as fsx from './fs.js';
import * as gloss from './glossary.js';
import * as mt from './mt.js';
import { detect as recogDetect, renderReport } from './recognize.js';
import { canonicalizeProfile, enrichDetectionProfile, isMirrorFormatText } from './universal-parser.js';

const NO_MT_BUILD = import.meta.env.MODE === 'no-mt';
import * as proof from './proof.js';
import * as dictx from './dict.js';
import { createMdxProvider, createPathMdxProvider, createTauriMdd, mimeFromExt, srcToResourceKey, isMddResourceSrc, linkTarget } from './mdx.js';
import * as mdx from './mdx.js';
import * as suggest from './suggest.js';
import * as snips from './snippets.js';
import { parseCsv, toGlossary, fromGlossary } from './csv.js';
import { profileForDictionary, dictionaryCssCandidates, profileNormalizationCss } from './dictionary-profiles.js';
import { toast, toastError } from './toast.js';
import { initPalette } from './palette.js';
import { bindRowContextMenu } from './rowmenu.js';
import { countStates, segments, percentText, isComplete, hasData, summaryText } from './filestats.js';
import * as bytes from './bytes.js';
import * as qa from './qa.js';
import * as exporter from './exporter.js';
import * as recovery from './recovery.js';
import * as dhist from './dict-history.js';
import * as tm from './tm.js';
import { showConfirm, showMtCompare, showExitConfirm, showHistoryList, showStatsPanel } from './modals.js';
import * as history from './history.js';
import * as stats from './stats.js';
import * as mtbase from './mtbaseline.js';
import { showObsidianExport } from './obsidian-ui.js';
import { snapshotChange } from './obsidian.js';
import { buildProofReport } from './proof-report.js';
import { saveProofReport } from './obsidian-files.js';

/* ---------------- 状态 ---------------- */

let matches = [];
let matchIndex = -1;
let glossData = null;   // { names, terms }
// 当前活动文档的「未保存」标记: 译文内容被改动且尚未写回原文件(保存原文件/Ctrl+S 后清除)。
// 各标签的脏状态随快照存放在 tabdock snap.dirty;anyUnsaved() 汇总所有已打开文档。
let docDirty = false;
let snippetData = { global: {}, project: {}, merged: {} }; // 快捷片段(merged 供输入建议)
let dictSettings = null;                                   // settings.dict(词典源配置)
const sessionDictEntries = new Map(); // 浏览器版会话内 JSON 词典词条: 源 id -> entries
const mdxProviders = new Map();      // 会话内 MDX 词典 Provider: 源 id -> provider(含 dispose)
const sourceAssets = new Map();      // 词典源 id -> { profile, css:[{key,text}], mdd }
const dictProfileStyles = new Set();
let lastPush = {};      // 撤销快照合并计时

const $q = document.getElementById('q');
const $r = document.getElementById('r');
const $scope = document.getElementById('scope');
const $mcase = document.getElementById('mcase');
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
  onFocusRow: updateContextFromRow,
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
let currentFonts = null; // { orig:{family,size,color,colorLight,colorBw}, trans:{...} },null=未设置;颜色按主题分槽

/** 应用主题模式(深色/浅色/黑白)到 DOM */
function applyTheme(mode){
  currentMode = theme.normalizeThemeMode(mode);
  document.documentElement.setAttribute('data-theme', currentMode);
  document.body.classList.toggle('theme-bw', currentMode === 'bw');
  const btn = document.getElementById('btnTheme');
  if (btn){
    const labels = { dark: '深色', light: '浅色', bw: '黑白' };
    btn.textContent = labels[currentMode];
    btn.setAttribute('aria-label', `当前主题：${labels[currentMode]}，点击切换主题`);
  }
  // 字体颜色按主题分槽保存,主题切换后需按新模式重新取色生效
  if (currentFonts) applyFonts(currentFonts);
  // 主题设置弹窗开着时,颜色输入框同步到新模式对应的槽位
  if (document.getElementById('themeModal').classList.contains('show')) syncFontUI(currentFonts);
}

/** 应用字体设置到 CSS 变量(仅用户设置项覆盖,其余跟随主题) */
function applyFonts(font){
  currentFonts = theme.mergeFontSettings(font);
  const set = (prefix, fallback) => {
    const g = prefix === 'orig' ? currentFonts.orig : currentFonts.trans;
    const el = document.documentElement;
    // 族名加引号并保留主题回退栈:自定义字体缺字时回落到主题字体,而不是掉到 UI 默认字体
    el.style.setProperty('--' + prefix + '-font-family', fonts.cssFamilyValue(g.family, fallback));
    el.style.setProperty('--' + prefix + '-font-size', g.size ? (g.size + 'px') : '');
    // 颜色取当前主题模式对应的槽位(空=跟随主题变量)
    el.style.setProperty('--' + prefix + '-font-color', theme.colorForMode(g, currentMode));
  };
  set('orig', 'var(--font-serif-jp)');
  set('trans', 'var(--font-sans-jp)');
}

/** 应用阅读密度到 DOM（规范 §6.2）。cozy 是 :root 默认档，不下发属性。 */
function applyDensity(mode){
  const attr = theme.densityAttr(mode);
  if (attr) document.documentElement.setAttribute('data-density', attr);
  else document.documentElement.removeAttribute('data-density');
}

/**
 * 应用文本区透明度到 CSS 变量。
 * 0 = 实色（默认，与旧版渲染一致），100 = 对白行完全透出背景图。
 */
function applyTextAreaTransparency(v){
  document.documentElement.style.setProperty('--text-area-alpha', theme.textAreaAlpha(v));
}

/** 应用字节计数口径到渲染层（规范 §8.3）。渲染层内部再做一次归一化。 */
function applyByteEncoding(enc){
  rdr.setByteEncoding(bytes.normalizeEncoding(enc));
}

/**
 * 应用字数上限（规范 §8.3）。传 null = 从未配置过 → 不写内联覆盖，由样式表的 120 生效；
 * 传 0 = 用户显式选择"不校验"，必须写成内联 0（见 renderer.setByteLimit 的注释）。
 */
function applyByteLimit(limit){
  if (limit === null || limit === undefined) return;
  rdr.setByteLimit(bytes.normalizeByteLimit(limit));
}

/** 设置项里的上限说明：显示生效值或不校验 */
function updateByteLimitLabel(){
  const el = document.getElementById('byteLimitInput');
  const out = document.getElementById('byteLimitVal');
  if (!el || !out) return;
  const raw = String(el.value || '').trim();
  if (!raw) { out.textContent = '不校验'; return; }
  const v = bytes.normalizeByteLimit(raw);
  out.textContent = v > 0 ? (v + ' 字节') : '不校验';
}

/** 统一应用外观(主题模式 + 字体 + 背景 + 密度 + 字节口径),启动时调用 */
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
  // 自定义字体库: 先恢复元数据,再按需注册当前在用的族(库大也不拖慢启动)
  fontLibrary = fonts.mergeFontLibrary(await loadFontLibrary());
  renderFontLibraryUI();
  renderFontPresetOptions();
  await ensureActiveFonts();
  const bg = await loadBackground();
  applyBackground(bg.dataUrl, bg.opacity, bg.fit);
  applyTextAreaTransparency(await loadTextAreaTransparency());
  applyDensity(await loadDensity());
  applyByteEncoding(await loadByteEncoding());
  applyByteLimit(await loadByteLimit());
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

/** 当前主题下的主题默认字色(供「跟随主题」时的色块预览) */
function themeDefaultColor(prefix){
  const fallback = prefix === 'orig' ? '#aeb9c9' : '#e6edf7';
  const v = getComputedStyle(document.documentElement).getPropertyValue(prefix === 'orig' ? '--orig-text' : '--trans-text').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

/** 同步一组字体行(原文/译文)的弹窗控件: 家族/字号全局,颜色取当前主题槽位 */
function syncFontRow(prefix, g){
  document.getElementById(prefix + 'Family').value = g.family;
  document.getElementById(prefix + 'Size').value = String(g.size);
  const follow = document.getElementById(prefix + 'Follow');
  const color = document.getElementById(prefix + 'Color');
  const stored = theme.colorForMode(g, currentMode);
  follow.checked = !stored;                 // 空=跟随主题
  color.disabled = !stored;
  color.value = colorToHex(stored || themeDefaultColor(prefix));
}

function syncFontUI(font){
  const f = theme.mergeFontSettings(font);
  syncFontRow('fo', f.orig);
  syncFontRow('ft', f.trans);
}

/**
 * 从弹窗读回字体设置。
 * 颜色槽位只写当前主题对应的那个(勾选「跟随主题」写空串),
 * 其余主题的已存颜色原样保留,避免切一次主题保存就丢掉其它主题的自定义色。
 */
function readFontFromUI(){
  const readRow = (which, prefix) => {
    const prev = currentFonts ? currentFonts[which] : null;
    const follow = document.getElementById(prefix + 'Follow').checked;
    const color = follow ? '' : colorToHex(document.getElementById(prefix + 'Color').value);
    const slot = currentMode === 'light' ? 'colorLight' : (currentMode === 'bw' ? 'colorBw' : 'color');
    const out = {
      family: document.getElementById(prefix + 'Family').value.trim(),
      size: Number(document.getElementById(prefix + 'Size').value) || 17,
      color: prev ? prev.color : '',
      colorLight: prev ? prev.colorLight : '',
      colorBw: prev ? prev.colorBw : '',
    };
    out[slot] = color;
    return out;
  };
  return { orig: readRow('orig', 'fo'), trans: readRow('trans', 'ft') };
}

function resetOrigFont(){
  syncFontRow('fo', { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
  previewFontFromUI();
}
function resetTransFont(){
  syncFontRow('ft', { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
  previewFontFromUI();
}

/** 实时预览: 字体/字号/颜色变化立即应用到正文(不落盘,取消弹窗时由 applyAppearance 还原) */
function previewFontFromUI(){
  applyFonts(readFontFromUI());
}

/* ---------------- 自定义字体库(导入字体文件 / 指定字体文件夹) ---------------- */

let fontLibrary = fonts.mergeFontLibrary(null); // { folder, folderName, files:[] }
let builtinFontPresets = [];                    // 内置系统字体候选(首次渲染时快照)

/** 「字体族」候选 = 已导入字体在前 + 内置系统字体;导入新字体后重建 */
function renderFontPresetOptions(){
  const dl = document.getElementById('fontPresets');
  if (!dl) return;
  if (!builtinFontPresets.length){
    builtinFontPresets = [...dl.querySelectorAll('option')].map(o => o.value).filter(Boolean);
  }
  const frag = document.createDocumentFragment();
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.label = label;
    frag.appendChild(o);
  };
  for (const g of fonts.groupFonts(fontLibrary.files)) add(g.family, '已导入字体');
  for (const f of builtinFontPresets) add(f, '系统字体');
  dl.replaceChildren(frag);
}

function fontLibrarySummary(){
  const groups = fonts.groupFonts(fontLibrary.files);
  if (!groups.length) return '尚未导入字体文件';
  const bytes = fonts.formatBytes(fontLibrary.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0));
  return '已收录 ' + groups.length + ' 个字体族 · ' + fontLibrary.files.length + ' 个文件' + (bytes ? ' · ' + bytes : '');
}

/** 重绘字体库列表(每个字体族一行,带移除按钮) */
function renderFontLibraryUI(){
  const list = document.getElementById('fontLibList');
  if (!list) return;
  const summary = document.getElementById('fontLibSummary');
  if (summary) summary.textContent = fontLibrarySummary();

  const pathEl = document.getElementById('fontFolderPath');
  const folderLabel = fontLibrary.folder || fontLibrary.folderName || '';
  if (pathEl) pathEl.textContent = folderLabel ? ('字体文件夹：' + folderLabel) : '未指定字体文件夹';

  const refresh = document.getElementById('btnFontRefresh');
  if (refresh) refresh.disabled = !(folderLabel || fontloader.hasFolderHandle());

  const frag = document.createDocumentFragment();
  for (const g of fonts.groupFonts(fontLibrary.files)){
    const li = document.createElement('li');
    li.className = 'font-lib-item';

    const meta = document.createElement('div');
    meta.className = 'fl-meta';
    const name = document.createElement('strong');
    name.className = 'fl-name';
    name.textContent = g.family;
    name.title = g.family;
    const sub = document.createElement('small');
    sub.className = 'fl-sub';
    const sizeText = fonts.formatBytes(g.totalSize);
    sub.textContent = g.weightText
      + (g.faces.length > 1 ? '（' + g.faces.length + ' 个文件）' : '')
      + (sizeText ? ' · ' + sizeText : '');
    meta.append(name, sub);

    const isFolder = g.faces[0].src === 'folder';
    const src = document.createElement('span');
    src.className = 'fl-src' + (isFolder ? ' is-folder' : '');
    src.textContent = isFolder ? '文件夹' : '导入';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fl-del';
    del.dataset.family = g.family;
    del.title = '移除「' + g.family + '」';
    del.setAttribute('aria-label', '移除 ' + g.family);
    del.textContent = '✕';

    li.append(meta, src, del);
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
}

/** 落盘 + 重绘(字体库改动立即生效,不等「保存外观」) */
async function persistFontLibrary(){
  await saveFontLibrary({
    folder: fontLibrary.folder,
    folderName: fontLibrary.folderName,
    files: fontLibrary.files,
  });
  renderFontLibraryUI();
  renderFontPresetOptions();
}

/** 加载若干族并汇报失败原因 */
async function loadFamilies(entries){
  const families = [...new Set((entries || []).map(e => e.family))];
  const failed = [];
  for (const fam of families){
    const r = await fontloader.loadFamily(fam, fontLibrary.files);
    if (!r.loaded) failed.push(fam + '（' + fontloader.reasonText(r.reasons[0] || 'invalid') + '）');
    else if (r.reasons.length) failed.push(fam + '（部分字重加载失败）');
  }
  if (failed.length){
    toastError('字体加载失败：' + failed.slice(0, 2).join('、') + (failed.length > 2 ? ' 等' : ''));
  }
}

/** 启动/切主题时: 只加载当前真正在用的自定义族(库里有几百个也不会有启动开销) */
async function ensureActiveFonts(){
  if (!currentFonts) return;
  for (const which of ['orig', 'trans']){
    const fam = currentFonts[which].family;
    if (!fam || !fonts.isImportedFamily(fontLibrary, fam)) continue;
    const r = await fontloader.loadFamily(fam, fontLibrary.files);
    if (!r.loaded && r.reasons.length){
      toastError('字体「' + fam + '」：' + fontloader.reasonText(r.reasons[0]));
    }
  }
}

/** 导入结果统一收尾: 入库 + 注册 + 提示 */
async function applyImportedEntries(entries, skipped, oversized){
  const groups = fonts.groupFonts(entries).length;
  if (entries.length){
    fontLibrary = fonts.addEntries(fontLibrary, entries);
    await persistFontLibrary();
    await loadFamilies(entries);
  }
  const parts = [];
  if (groups) parts.push('已导入 ' + groups + ' 个字体族');
  if (skipped) parts.push('跳过 ' + skipped + ' 个非字体文件');
  if (oversized && oversized.length) parts.push(oversized.length + ' 个文件过大未导入');
  if (!parts.length) return;
  const text = parts.join('，');
  if (groups) toast(text); else toastError(text);
}

/** 「导入字体文件」: 桌面端走原生多选对话框,浏览器走隐藏的 file input */
async function onFontImportClick(){
  if (fsx.isTauri()){
    const picked = await fsx.openFilesDialog([{ name: '字体文件', extensions: fonts.FONT_EXTS }]);
    if (!picked.length) return;
    const entries = fontloader.entriesFromPaths(picked.map(p => p.path));
    await applyImportedEntries(entries, picked.length - entries.length, []);
    return;
  }
  document.getElementById('fontFileInput').click();
}

async function onFontFileInputChange(e){
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const res = await fontloader.importBrowserFiles(files);
  await applyImportedEntries(res.entries, res.skipped, res.oversized);
}

/** 文件夹扫描结果入库: 覆盖上一次文件夹收录(导入的文件不受影响) */
async function applyFolderScan(entries, truncated, folderName, folder){
  if (!entries.length){
    toastError('该文件夹里没有找到字体文件（支持 ' + fonts.FONT_ACCEPT + '）');
    return;
  }
  // 旧文件夹字体的族先卸掉,避免残留已注册的族
  for (const g of fonts.groupFonts(fontLibrary.files)){
    if (g.faces.some(f => f.src === 'folder')) fontloader.unloadFamily(g.family);
  }
  const next = fonts.addEntries(fonts.removeBySource(fontLibrary, 'folder'), entries);
  next.folder = folder || '';
  next.folderName = folderName || '';
  fontLibrary = next;
  await persistFontLibrary();
  await ensureActiveFonts(); // 正在使用的族若来自该文件夹,重新注册
  let msg = '已收录 ' + fonts.groupFonts(entries).length + ' 个字体族';
  if (truncated) msg += '（仅收录前 ' + fonts.MAX_FOLDER_FONTS + ' 个）';
  toast(msg);
}

/** 「指定字体文件夹」: 桌面端记路径,浏览器记目录句柄 */
async function onFontFolderClick(){
  try {
    if (fsx.isTauri()){
      const dir = await fsx.pickDirDialog();
      if (!dir) return;
      const res = await fontloader.scanFolderTauri(dir);
      await applyFolderScan(res.entries, res.truncated, '', dir);
      return;
    }
    const handle = await fsx.pickBrowserDir();
    if (!handle) return;
    const res = await fontloader.scanFolderBrowser(handle);
    await applyFolderScan(res.entries, res.truncated, res.folderName, '');
  } catch (e){
    toastError((e && e.message) ? e.message : '指定字体文件夹失败');
  }
}

/** 「重新扫描」: 拾取文件夹里新增/删除的字体 */
async function onFontRefreshClick(){
  try {
    if (fsx.isTauri()){
      if (!fontLibrary.folder){ toastError('尚未指定字体文件夹'); return; }
      const res = await fontloader.scanFolderTauri(fontLibrary.folder);
      await applyFolderScan(res.entries, res.truncated, '', fontLibrary.folder);
      return;
    }
    const res = await fontloader.rescanFolderBrowser();
    if (!res){
      toastError('字体文件夹未授权，请重新「指定字体文件夹」');
      return;
    }
    await applyFolderScan(res.entries, res.truncated, res.folderName, '');
  } catch (e){
    toastError((e && e.message) ? e.message : '重新扫描失败');
  }
}

/** 移除一个字体族(该族所有字重) */
async function onFontRemove(family){
  fontloader.unloadFamily(family);
  if (!fsx.isTauri()){
    for (const f of fontLibrary.files){
      if (f.family === family) await fontloader.deleteBrowserBlob(f.id);
    }
  }
  fontLibrary = fonts.removeFamily(fontLibrary, family);
  await persistFontLibrary();
  if (currentFonts && (currentFonts.orig.family === family || currentFonts.trans.family === family)){
    toast('已移除「' + family + '」，正文回退主题字体');
  }
}

async function onFontClearClick(){
  if (!fontLibrary.files.length && !fontLibrary.folder && !fontLibrary.folderName){
    toast('自定义字体库已经是空的');
    return;
  }
  const ok = await showConfirm({
    title: '清空自定义字体',
    message: fsx.isTauri()
      ? '将移除全部已导入的字体族与字体文件夹记录。磁盘上的字体文件不会被删除。'
      : '将移除全部已导入的字体族与字体文件夹记录，并删除本机数据库里缓存的字体数据。',
    confirmText: '清空',
  });
  if (!ok) return;
  if (!fsx.isTauri()){
    for (const f of fontLibrary.files){
      if (!f.path && !(Array.isArray(f.relPath) && f.relPath.length)) await fontloader.deleteBrowserBlob(f.id);
    }
    await fontloader.clearFolderHandle();
  }
  fontloader.unloadAll();
  fontLibrary = fonts.mergeFontLibrary(null);
  await persistFontLibrary();
  toast('已清空自定义字体');
}

/** 字体族输入框变化: 选中已导入的族时按需注册,再实时预览 */
async function onFontFamilyInput(e){
  const fam = String(e.target.value || '').trim();
  if (fam && fonts.isImportedFamily(fontLibrary, fam) && !fontloader.isFamilyLoaded(fam)){
    const r = await fontloader.loadFamily(fam, fontLibrary.files);
    if (!r.loaded && r.reasons.length){
      toastError('字体「' + fam + '」：' + fontloader.reasonText(r.reasons[0]));
    }
  }
  previewFontFromUI();
}

/* ---------------- 进度 / 撤销按钮 / 统计 ---------------- */

function updateProgress(){ rdr.updateProgress(); updateStats(); syncEditorialMeta(); updateActiveTabProgress(); }

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
  if (NO_MT_BUILD) return;
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
  proof.noteInput(i); // 必须在赋值前捕获旧译名，包含单次粘贴/替换。
  p.nameTr = value;
  if (p.isName) model.recalcDone(p);
  model.scheduleAutosave();
  // 新翻译的人名自动沉淀进人名表(并保存,否则只在内存里,重开软件就丢)
  const added = gloss.recordNameIfNew(glossData.names, p.name, value.trim());
  if (added){
    renderGlossTables();
    persistGloss();
  }
  rdr.refreshRow(i);
  updateProgress();
  markDirty();
  if (_synced) wkr.syncSearchShadow({ changes: [{ i, nameTr: value }] });
}

function transInputHandler(i, value){
  const p = model.getPara(i);
  if (!p) return;
  pushUndoFor(i);
  proof.noteInput(i); // 必须在赋值前捕获旧译文，供修改记录及 Obsidian 收藏使用。
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
  p.src = 'human';   // 归因标记：人工输入（含改写机翻结果）→ 统计面板据此算 MT/人工占比
  model.scheduleAutosave();
  rdr.refreshRow(i);
  updateProgress();
  markDirty();
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
  markDirty();
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
  if (matchIndex < 0 || !matches.length){ toastError('没有可替换的匹配。'); return; }
  const m = matches[matchIndex];
  if (m.col === 'orig'){ toast('当前匹配位于原文中,替换仅作用于译文与名字。'); return; }
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
    toastError('请先输入查找内容,并确保搜索范围不是「仅原文」。');
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
  if (grand === 0){ toastError('没有找到可替换的匹配。'); return; }
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
    toast('已替换 ' + grand + ' 处。');
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
  markDirty(); // 批量替换未写回原文件
  toast('已替换 ' + grand + ' 处。');
}

function jumpToLine(){
  const v = document.getElementById('jumpInput').value.trim();
  if (!v){ toastError('请输入要跳转的行号/编号'); return; }
  if (!_synced){ _synced = true; wkr.syncSearchShadow({ full: model.getParas() }); }
  wkr.searchJumpToIndex(v).then(idx => {
    if (idx === -1){ toastError('未找到编号为「' + v + '」的行'); return; }
    rdr.scrollRowIntoView(idx);
    rdr.renderWindow(true);
    rdr.focusIdx(idx);
    document.getElementById('jumpInput').value = '';
  }).catch(e => toastError('跳转失败: ' + e.message));
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
  const fname = name || (file.path ? file.path.split(/[\\/]/).pop() : '');
  // 镜像格式(dc4ph 等)在 parsers 内原生解析: // 行=原文行、普通行=译文行、#0x 头=结构行,
  // 全程不做任何格式转换,保存时按原格式写回。
  const isMirror = isMirrorFormatText(content);
  const parsed = parseFile(content);
  model.setRawText(content); // 原始文本,供「格式识别」/ 规范化还原
  model.setCanonicalDoc(false); // 普通导入不是规范化文档
  model.setParas(parsed.paras);
  model.setFileInfo({ name: fname, path: file.path || null, nl: parsed.nl, trailingBlank: parsed.trailingBlank });
  await finishLoadSource(fname, parsed, file,
    isMirror ? 'ℹ 已按镜像格式解析（// 行=原文行，普通行=译文行），保存时保持原格式。' : '');
}

// loadSource 的公共收尾: 进度恢复/术语表/校对/渲染(file 仅普通导入用于进度键)
async function finishLoadSource(fname, parsed, file, note){
  // 恢复上次进度: 规范化文档用 model.getStateKey()(自动带 .canonical 后缀),
  // 与同名原文件的进度分开,避免把普通导入的旧进度合并进规范化文档。
  // 关键: 用「合并」而非整体覆盖 —— 文件里已带的译文(★行)优先保留,
  // 缓存进度只补文件未翻译的行,避免陈旧的缓存把已有译文顶成空白。
  const isCanonical = model.isCanonicalDoc();
  const stateKey = model.getStateKey();
  let saved = await fsx.savedState(stateKey);
  let legacy = false;
  if (!saved && !isCanonical && file && file.path){
    saved = await fsx.savedState(fname); // 兼容旧版本按文件名存的进度
    legacy = !!saved;
  }
  if (saved && saved.paras && saved.paras.length){
    const n = saved.paras.filter(q => (q.translation || '').trim()).length;
    const where = fsx.isTauri() && file && file.path ? ('\n（进度文件：' + fsx.progressPathDisplay(file.path) + '）') : '';
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
  const projDir = file && file.path ? file.path.replace(/[\\/][^\\/]*$/, '') : null;
  glossData = await gloss.loadGlossaryForProject(projDir);
  renderGlossTables();
  updateGlossProjectLabel();
  initSnippets(); // 快捷片段跟随同一项目目录
  await loadTmForProject(file && file.path ? file.path : null); // 翻译记忆（随项目 .galweave/tm.json）
  await loadStatsForProject(file && file.path ? file.path : null); // 进度统计库
  await loadMtBaselineForProject(file && file.path ? file.path : null); // 机翻基线（随项目 .galweave/mtbaseline.json）

  // 人名自动应用
  const applied = gloss.applyNames(model.getParas(), glossData.names);
  if (applied) model.scheduleAutosave();

  document.getElementById('fname').textContent = '当前文件：' + fname + '　编码：' + (file && file.encoding ? file.encoding : 'utf-8')
    + (applied ? '　📖术语已自动应用 ' + applied + ' 个人名' : '');
  if (note) showToast(note);
  docDirty = false; // 全新导入,尚未有未写回的改动
  lastSnapshotAt = 0; // 换文档 → 留档节流重新计时
  setHeaderSaveState('已载入', 'saved');
  await proof.loadForFile(); // 加载该文件的校对数据(批注/状态/修改记录)
  rdr.fullRender();
  recomputeMatchesUI(true); // 新文件载入 → 强制全量同步影子
  rdr.focusIdx(0);
  updateUndoButtons();
  updateProgress(); // 加载后刷新进度 + 字数统计
  touchStats();     // 记一笔当天进度（分量：打开即记录，便于算日速度）
}

// 规范化文档(☆/★)的解析规则: # 注释行是规范化格式的一部分(控制行/#0x 地址头等),
// 即使用户规则里清空了注释前缀也必须剥离,否则控制行会落到原文行。
function canonicalParseConf(){
  const user = getParseConf();
  return {
    open: '☆', close: '★', regex: '',
    commentPrefixes: [...new Set(['#', ...(user.commentPrefixes || [])])],
  };
}

/* ---------------- 未保存(脏)标记 ---------------- */

// 标记当前活动文档有未写回原文件的改动;顶部保存状态同步显示。
function markDirty(){
  docDirty = true;
  syncTabDirty(tb.activeKey(), true);
  const el = document.getElementById('headerSaveState');
  if (el && (el.dataset.state === 'saved' || el.dataset.state === 'ready')) setHeaderSaveState('未保存', 'dirty');
}

// 当前文档已写回原文件,清除脏标记。
function clearDirty(){
  docDirty = false;
  syncTabDirty(tb.activeKey(), false);
}

// 把某标签的脏状态写回其快照(snap 为 null 的未加载标签不可能脏)。
function syncTabDirty(key, v){
  if (!key) return;
  if (key === tb.activeKey()){ docDirty = v; return; }
  const snap = tb.getSnap(key);
  if (snap) snap.dirty = v;
}

// 某标签是否未保存(活动标签看实时标记,其余看快照)。
function tabDirty(key){
  if (key === tb.activeKey()) return docDirty;
  const snap = tb.getSnap(key);
  return !!(snap && snap.dirty);
}

// 是否存在任何未保存的已打开文本(含浏览器版单文档)。
function anyUnsaved(){
  if (!tb.list().length) return docDirty && !!model.getParas().length;
  return tb.list().some(t => tabDirty(t.key));
}

/* ---------------- 多文档标签页 ---------------- */

// 统一"打开文件"入口: 桌面(带路径)→ 进入标签体系;浏览器(无路径/session)→ 直接加载。
async function openDoc(file, name){
  const path = (file && file.path) || null;
  if (path){
    const key = tb.open(path, name || path.split(/[\\/]/).pop() || '');
    if (tb.activeKey() === key){ renderTabs(); return; } // 已是当前文件(避免误重载丢编辑)
    if (tb.getSnap(key) !== null){
      await switchDoc(key); // 已有快照 → 直接切换
    } else {
      // 首次打开新文件: 先把当前活动文档冻结,避免被 loadSource 的 setParas 覆盖丢 undo
      const cur = tb.activeKey();
      if (cur) await flushDocToTab(cur);
      await loadSource(file, name);
      tb.setActive(key);
      renderTabs();
    }
    return;
  }
  await loadSource(file, name); // 浏览器/会话文件不进标签体系
}

// 把当前活动文档冻结进标签快照(切换/关闭前调用)
async function flushDocToTab(key){
  try { await model.flushAutosave(); } catch (e) { /* 忽略 */ }
  try { proof.flushSave(); } catch (e) { /* 忽略 */ }
  tb.capture(key, {
    model: model.snapshotState(),
    proof: proof.snapshotState(),
    glossData,
    dirty: docDirty, // 该文档是否有未写回原文件的改动
  });
}

// 切到指定标签(从其快照恢复并重渲染)
async function switchDoc(key){
  const cur = tb.activeKey();
  if (cur && cur !== key) await flushDocToTab(cur);
  const snap = tb.getSnap(key);
  if (!snap){ // 目标尚未快照(新开/异常) → 直接聚焦空
    tb.setActive(key);
    renderTabs();
    return;
  }
  model.restoreState(snap.model);
  glossData = snap.glossData;
  proof.restoreState(snap.proof);
  docDirty = !!snap.dirty; // 恢复该标签的未保存标记
  tb.setActive(key);
  afterDocActivated();
}

// 标签切换/恢复后的公共重渲染尾(与 loadSource 尾部一致)
function afterDocActivated(){
  renderGlossTables();
  updateGlossProjectLabel();
  initSnippets();
  document.getElementById('fname').textContent = '当前文件：' + (model.getFilename() || '');
  if (docDirty) setHeaderSaveState('未保存', 'dirty');
  else setHeaderSaveState(model.getFilename() ? '已载入' : '准备就绪', 'saved');
  rdr.fullRender();
  recomputeMatchesUI(true);
  rdr.focusIdx(0);
  updateUndoButtons();
  updateProgress();
  renderTabs();
}

// 关闭标签;关闭的是活动标签则切到相邻,否则仅移除
async function closeDoc(key){
  if (!tb.has(key)) return;
  const wasActive = tb.activeKey() === key;
  if (wasActive){
    await flushDocToTab(key);
    const wasIndex = tb.list().findIndex(t => t.key === key);
    tb.close(key);
    const rest = tb.list();
    const nb = tb.neighborAfterClose(rest, wasIndex);
    if (nb){
      await switchDoc(nb);
    } else {
      clearEditorForEmpty();
    }
  } else {
    tb.close(key);
    renderTabs();
  }
}

// 一键保存全部已打开文本: 逐个切到未保存的标签执行写回,结束后回到原活动标签。
// 桌面版多标签场景;浏览器版(无标签体系)退化为对当前文档直接保存。
async function saveAllDocs(){
  const keys = tb.list().map(t => t.key);
  if (!keys.length){
    if (model.getParas().length) await saveDirect();
    else toastError('没有已打开的文本');
    return;
  }
  const dirtyKeys = keys.filter(k => tabDirty(k));
  if (!dirtyKeys.length){ toast('所有已打开文本均已保存。'); return; }
  const active = tb.activeKey();
  for (const k of dirtyKeys){
    if (tb.activeKey() !== k) await switchDoc(k);
    await saveDirect(); // 成功后 clearDirty 已写回该标签快照
  }
  if (active && tb.has(active) && tb.activeKey() !== active) await switchDoc(active);
}

// 没有标签时清空编辑区
function clearEditorForEmpty(){
  model.setParas([]);
  model.setFileInfo({ name: '', path: null, nl: '\n', trailingBlank: false });
  model.setRawText('');
  glossData = { names: {}, terms: {} };
  docDirty = false;
  document.getElementById('fname').textContent = '当前文件：';
  setHeaderSaveState('准备就绪', 'ready');
  rdr.fullRender();
  recomputeMatchesUI(true);
  updateUndoButtons();
  updateProgress();
  renderTabs();
}

// 渲染顶栏标签
function renderTabs(){
  const bar = document.getElementById('tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const active = tb.activeKey();
  for (const t of tb.list()){
    const el = document.createElement('div');
    el.className = 'doc-tab' + (t.key === active ? ' active' : '');
    el.tabIndex = 0;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.key === active));
    el.setAttribute('aria-label', '打开文档 ' + t.name);
    const row = document.createElement('div');
    row.className = 'dt-row';
    const label = document.createElement('span');
    label.className = 'dt-label';
    label.textContent = t.name;
    label.title = t.key;
    const close = document.createElement('button');
    close.className = 'dt-close';
    close.textContent = '✕';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭文档 ' + t.name);
    close.title = '关闭';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(t.key); });
    row.append(label, close);
    el.appendChild(row);

    const prog = buildTabProgress(tabCounts(t));
    if (prog) el.appendChild(prog);

    el.addEventListener('click', () => switchDoc(t.key));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); switchDoc(t.key); }
    });
    bar.appendChild(el);
  }
}

// 文档标签分段进度条（规范 §7.5）—— 纯逻辑见 src/filestats.js
function tabCounts(t){
  if (t.key === tb.activeKey()){
    return countStates(model.snapshotState().paras);
  }
  const snap = tb.getSnap(t.key);
  return countStates(snap && snap.model ? snap.model.paras : null);
}

// 生成 `.dt-prog` 节点（分段条 + 百分比）。无数据时返回 null（不画条）。
function buildTabProgress(counts){
  if (!hasData(counts)) return null;
  const prog = document.createElement('div');
  prog.className = 'dt-prog' + (isComplete(counts) ? ' complete' : '');
  const a11y = summaryText(counts);
  prog.setAttribute('aria-label', a11y);
  prog.title = a11y;

  const bar = document.createElement('div');
  bar.className = 'seg-bar';
  for (const s of segments(counts)){
    const seg = document.createElement('div');
    seg.className = 'seg ' + s.key;
    seg.style.flexGrow = String(s.ratio > 0 ? s.ratio : 0.0001);
    bar.appendChild(seg);
  }
  const pct = document.createElement('span');
  pct.className = 'dt-pct';
  pct.textContent = percentText(counts);

  prog.append(bar, pct);
  return prog;
}

// 编辑中只刷新活动标签的进度条，避免整条重建导致标签条滚动复位 / 闪烁。
function updateActiveTabProgress(){
  const el = document.querySelector('.doc-tab.active');
  if (!el) return;
  const old = el.querySelector('.dt-prog');
  if (old) old.remove();
  const prog = buildTabProgress(tabCounts({ key: tb.activeKey() }));
  if (!prog) return;
  const row = el.querySelector('.dt-row');
  if (row) row.after(prog); else el.appendChild(prog);
}

async function importWithPicker(){
  if (fsx.isTauri()){
    const res = await fsx.openFileDialog();
    if (!res) return;
    await openDoc({ path: res.path }, res.name);
    return;
  }
  // 浏览器: 优先 File System Access 拿句柄(可写回原文件),不支持则普通选择
  const picked = await fsx.pickBrowserFile();
  if (picked){
    await openDoc(picked.file, picked.name);
    return;
  }
  document.getElementById('fileInput').click();
}

// 保存/导出建议文件名: 规范化文档建议 .canonical.txt(避免把 ☆/★ 格式覆盖回原文件),其余用原名
// 保存/导出建议文件名: 规范化文档建议 .canonical.txt(避免把 ☆/★ 格式覆盖回原文件),其余用原名。
// format 省略 = 'original'（保持既有调用点行为不变）。
function saveSuggestedName(format = 'original'){
  const f = model.getFilename() || '译文.txt';
  const base = model.isCanonicalDoc() ? f.replace(/\.(txt|ks)$/i, '') + '.canonical.txt' : f;
  return exporter.suggestExportName(base, format);
}

async function saveDirect(){
  if (!model.getParas().length){ toastError('请先导入文本文件'); return; }
  await proof.flushSave(); // 先落盘校对数据(与源文件保持一致)
  await model.flushAutosave();
  await harvestTm();       // 译文此刻已稳定 → 收割进翻译记忆（含人工改动）
  await snapshotHistory('save'); // 写回原文件前留档（ROADMAP P1-2）
  touchStats();            // 记一笔当天进度（ROADMAP P2-4）
  await flushStats();
  const content = buildExport(model.getParas(), model.getNl(), model.getTrailingBlank());
  setHeaderSaveState('保存中…', 'saving');
  try {
    if (fsx.isTauri() && model.getFilePath()){
      await fsx.writeFileSource(model.getFilePath(), content, model.getFilename());
      clearDirty();
      setHeaderSaveState('已保存', 'saved');
      showToast('✅ 已保存到原文件');
      return;
    }
    if (fsx.isTauri()){
      const res = await fsx.saveFileDialog(saveSuggestedName());
      if (!res){ setHeaderSaveState('准备就绪', 'ready'); return; } // 用户取消,静默
      await fsx.writeFileSource(res.path, content, res.name);
      model.setFileInfo({ ...model.getFilePath() ? { path: res.path } : {}, name: res.name });
      clearDirty();
      setHeaderSaveState('已保存', 'saved');
      showToast('✅ 已保存到：' + res.path);
      return;
    }
    // 浏览器: 写回原文件句柄 / 另存为 / 下载
    const r = await fsx.writeBrowserFile(content, saveSuggestedName());
    if (r.saved){
      clearDirty();
      setHeaderSaveState('已保存', 'saved');
      showToast('✅ 已保存到原文件');
    } else if (r.cancelled){
      setHeaderSaveState('准备就绪', 'ready');
      // 另存为对话框取消,静默
    } else if (r.downloaded){
      // 下载的是副本,原文件未更新 → 保持未保存标记
      setHeaderSaveState('已导出', 'saved');
      showToast('⬇ 已下载译文副本：' + saveSuggestedName());
    } else {
      clearDirty();
      setHeaderSaveState('已保存', 'saved');
      showToast('✅ 已保存');
    }
  } catch (e){
    setHeaderSaveState('保存失败', 'error');
    showToast('❌ 保存失败：' + (e && e.message ? e.message : e), true);
  }
}

async function exportFile(){
  if (!model.getParas().length){ toastError('请先导入文本文件'); return; }
  await proof.flushSave();
  const sel = document.getElementById('exportFormat');
  const format = exporter.normalizeExportFormat(sel ? sel.value : 'original');
  const paras = model.getParas();

  let content;
  if (format === 'original'){
    // 原行为：回写引擎文本格式
    content = buildExport(paras, model.getNl(), model.getTrailingBlank());
  } else {
    content = exporter.buildExportText(format, paras, {
      nl: model.getNl(),
      filename: model.getFilename(),
    });
    if (format === 'target' && !content){
      toastError('没有任何已翻译的正文行，纯译文导出会是空文件。\n请先翻译，或改用「双语对照 / 对照 CSV」。');
      return;
    }
  }

  // 原格式导出是"副本"，加前缀避免与原文件同名互相覆盖；新格式自带后缀，无需前缀
  const outName = format === 'original'
    ? '译文_' + saveSuggestedName('original')
    : saveSuggestedName(format);
  setHeaderSaveState('导出中…', 'saving');
  try {
    if (fsx.isTauri()){
      const res = await fsx.saveFileDialog(outName);
      if (!res){ setHeaderSaveState('准备就绪', 'ready'); return; } // 取消,静默
      await fsx.writeFileSource(res.path, content, res.name);
      setHeaderSaveState('已导出', 'saved');
      showToast('✅ 已导出' + exporter.exportFormatLabel(format) + '：' + res.path);
      return;
    }
    fsx.downloadText(content, outName);
    setHeaderSaveState('已导出', 'saved');
    showToast('⬇ 已下载' + exporter.exportFormatLabel(format) + '：' + outName);
  } catch (e){
    setHeaderSaveState('准备就绪', 'ready');
    showToast('❌ 导出失败：' + (e && e.message ? e.message : e), true);
  }
}

async function restoreProgress(){
  if (!model.getFilename()){ toastError('请先导入文件'); return; }
  const saved = await fsx.savedState(model.getStateKey());
  if (!saved || !saved.paras || !saved.paras.length){
    const where = fsx.isTauri() && model.getFilePath() ? ('（' + fsx.progressPathDisplay(model.getFilePath()) + '）') : '';
    toastError('没有找到「' + model.getFilename() + '」的已保存进度' + where);
    return;
  }
  // 与导入恢复一致: 合并而非覆盖 —— 当前文件已有译文优先,只补未翻译的行
  model.setParas(mergeSavedState(model.getParas(), saved.paras));
  model.getParas().forEach(p => model.recalcDone(p));
  rdr.fullRender();
  recomputeMatchesUI(true);
  rdr.focusIdx(0);
  updateProgress(); // 恢复进度后刷新字数统计
  markDirty(); // 恢复的译文尚未写回原文件
}

async function clearAll(){
  if (!model.getParas().length) return;
  const ok = await showConfirm({
    title: '清空当前文件的全部翻译内容',
    message: '人名 / 说话人译名会保留，只清空译文正文。\n此操作可用 Ctrl+Z 撤销。',
    confirmText: '清空', danger: true,
  });
  if (!ok) return;
  pushUndoAll();
  model.getParas().forEach(p => {
    p.translation = ''; // 只清译文正文;人名(nameTr)保留,清空翻译不连带删人名
    model.recalcDone(p);
  });
  rdr.fullRender();
  recomputeMatchesUI(true);
  updateProgress(); // 清空后刷新进度 + 字数统计
  markDirty(); // 内存译文已清空,原文件未动
  // 只清空当前界面(内存),不写进度存储、不触发自动保存:
  // 若未按「保存原文件」就关闭,重新导入仍恢复上次保存的翻译进度(可用 Ctrl+Z 撤销本次清空)。
}

// 清除当前文件的已保存进度:删除该文件的进度记录,重新导入完全干净(无恢复提示)
async function clearProgress(){
  if (!model.getFilename()){ toastError('请先导入文件'); return; }
  const ok = await showConfirm({
    title: '删除「' + model.getFilename() + '」的已保存进度与校对数据',
    message: '重新导入该文件时将全新开始，不会恢复任何内容。\n此操作不可撤销。',
    confirmText: '删除', danger: true,
  });
  if (!ok) return;
  await fsx.removeSavedState(model.getStateKey());
  await proof.clearForFile(); // 同时删除该文件的校对数据(批注/状态/修改记录)
  toast('已清除「' + model.getFilename() + '」的已保存进度与校对数据。');
}

/* ---------------- 术语表 UI ---------------- */

// 侧边栏术语面板顶部显示当前术语表归属(项目目录 / 全局)
function updateGlossProjectLabel(){
  const dir = gloss.getProjectDir();
  const el = document.getElementById('glossProjectLabel');
  const commandStatus = document.getElementById('glossaryCommandStatus');
  if (dir){
    el.textContent = '📖 术语表：' + dir + '/glossary.json';
    el.title = '术语表保存位置：' + dir + '/glossary.json';
    if (commandStatus) commandStatus.textContent = '项目术语库 · glossary.json';
  } else {
    el.textContent = '📖 全局术语表（未打开文件）';
    el.title = '未打开文件,术语表保存在全局位置';
    if (commandStatus) commandStatus.textContent = '全局术语库 · 未打开项目';
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
  del.addEventListener('click', async () => {
    const ok = await showConfirm({ title: '删除术语「' + src + '」', message: '该术语将从当前术语表移除，无法撤销。', confirmText: '删除', danger: true });
    if (ok) onUpdate(src, '');
  });
  s1.addEventListener('change', () => {
    const nk = s1.value.trim();
    if (!nk || nk === src) return;
    // 改名: 删除旧键,新建新键(值保留)
    onUpdate(src, '');
    onUpdate(nk, dst);
  });
  s2.addEventListener('change', () => onUpdate(src, s2.value.trim()));
  // 插入译文走编辑区原文里的高亮词条点击(.term-hit),这里不再提供手动「插入」按钮
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
  if (!src || !dst){ toastError('请填写原文与译文'); return; }
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
  catch (e){ toastError('CSV 解析失败: ' + e.message); return false; }
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
    try { obj = JSON.parse(await fsx.readTextFileSource(res.path)); } catch (e){ toastError('无法解析 JSON: ' + e); return; }
    glossData = { names: obj.names || {}, terms: obj.terms || {} };
    await gloss.saveGlossaryForProject(glossData);
    renderGlossTables();
    rdr.refreshAllRows();
    toast('术语表已导入。');
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
      toast('术语表已导入。');
    } catch (e){ toastError('无法解析: ' + e); }
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
  if (!model.getParas().length){ toastError('请先导入文本文件'); return; }
  const names = Object.keys(glossData.names).length;
  const terms = Object.keys(glossData.terms).length;
  if (!names && !terms){ toastError('术语表为空。'); return; }
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
  refreshProofUI();  // 译文变了 → 漏翻/异常清单与术语一致性 QA 需重算
  if (n > 0 || total > 0) markDirty(); // 应用结果未写回原文件
  toast('已应用术语表:\n人名自动填充 ' + n + ' 行\n译文批量修正 ' + total + ' 行');
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
          if (!sourceAssets.has(src.id)) tryPairMdd(p, src.path, src.id); // 重启后恢复 MDD/CSS 关联(异步)
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
    del.addEventListener('click', async () => {
      const ok = await showConfirm({ title: '删除词典源「' + src.name + '」', message: '该词典源将被移除，相关查询缓存一并清除。', confirmText: '删除', danger: true });
      if (!ok) return;
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
    catch (e){ toastError('无法读取文件: ' + e.message); return; }
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
    catch (e){ toastError('无法读取文件: ' + e.message); }
  };
  input.click();
}

async function installJsonDictSource(raw, path, fallbackName){
  const parsed = dictx.parseDictJson(raw);
  if (!parsed){ alert('词典文件格式不合法:需要 galtrans-dict-v1 JSON(含 entries 字段),详见 docs/dictionary-plugins.md。'); return; }
  const count = Object.keys(parsed.entries).length;
  if (!count){ toastError('词典文件没有有效词条。'); return; }
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

/** 探测同名 .mdd 资源包(含分卷 .1/.2…)与同名 .css(独立样式文件,如新明解 XMJRH.css)并关联到词典(桌面版)。
 *  资源解析顺序: 同名 mdd → 分卷 mdd → 词典目录磁盘文件(KogoGaiji.ttf / 小学馆 image/** 这类同目录资源)。
 *  成功返回资源链,无任何资源源时也返回磁盘兜底(独立 CSS 读入 prov.extraCss({key,text}))。 */
async function tryPairMdd(prov, mdxPath, sourceId){
  if (!fsx.isTauri() || !prov || !mdxPath) return null;
  const profileInfo = dictionaryCssCandidates(mdxPath);
  const profile = profileInfo.profile;
  const dir = mdxPath.replace(/[\\/][^\\/]*$/, '');
  const assets = { profile, css: [], mdd: null };

  // 资源源按顺序回退;分卷从 1 连续编号,断号即停(大词泉 DJS.mdd + DJS.1.mdd)
  const parts = [];
  for (const path of mdx.mddPartPaths(mdxPath)){
    try {
      const mdd = createTauriMdd({ name: prov.name + ' 资源' + (parts.length ? ' · 卷' + parts.length : ''), path });
      await mdd.resourceB64(''); // 触发 mdd_open 校验;文件不存在会抛错
      parts.push(mdd);
    } catch (e){
      if (!parts.length) continue;   // 主 mdd 缺失(正常),继续探测分卷
      break;                         // 已有主卷才出现断号 → 后面不会再有
    }
  }
  // 磁盘兜底永远挂上: mdd 查不到的资源最后落到与 mdx 同目录(或其子目录)的文件上
  parts.push(mdx.createDiskResourceMdd({ name: prov.name + ' 磁盘资源', dir, readB64: fsx.readFileB64 }));

  assets.mdd = parts.length === 1 ? parts[0] : mdx.createCompositeMdd(parts);
  prov.mdd = assets.mdd;

  // 显式 Profile 先解决命名不一致与多 CSS；同名 CSS 由候选列表优先尝试。
  for (const candidate of profileInfo.candidates){
    const cssPath = dir + '/' + candidate;
    try {
      const raw = await fsx.readTextFileSource(cssPath);
      const text = raw && raw.content !== undefined ? raw.content : raw;
      if (text){ assets.css.push({ key: candidate, text }); }
    } catch (e){ /* 缺少候选 CSS 正常 */ }
  }
  if (assets.mdd || assets.css.length){
    sourceAssets.set(sourceId || prov.id, assets);
    prov.extraAssets = assets;
  }
  return assets.mdd;
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
    await tryPairMdd(prov, res.path, src.id); // 探测同目录 .mdd/CSS(词条内资源与样式)
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
  if (!url || !url.includes('{word}')){ toastError('URL 模板必须包含 {word} 占位。'); return null; }
  let headers = {};
  const hraw = document.getElementById('dhHeaders').value.trim();
  if (hraw){
    try { headers = JSON.parse(hraw); }
    catch (e){ toastError('请求头不是合法 JSON: ' + e.message); return null; }
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

async function doDictLookup(word, isFuzzy, source){
  word = String(word || '').trim();
  if (!word) return;
  const box = document.getElementById('dictResults');
  if (!box) return;
  recordDictLookup(word, source || 'input');
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
          const sourceId = seg.sourceId || seg.source || '';
          const assets = sourceAssets.get(sourceId) || sourceAssets.get(seg.source) || { profile: profileForDictionary(seg.source), css: [], mdd: null };
          const profile = assets.profile || profileForDictionary(seg.source);
          body.className = 'dc-html';
          body.dataset.dictProfile = profile.id;
          body.dataset.dictSource = sourceId;
          ensureDictProfileStyle(profile);
          body.innerHTML = mdx.cleanGaijiInHtml(s.html);
          const mdd = assets.mdd || null;
          body.__mdd = mdd;
          line.appendChild(body);
          card.appendChild(line);
          hydrateMddResources(body, assets);
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

/* ---- 最近查询（ROADMAP P2-5）---- */

let dictHistory = [];

async function initDictHistory(){
  dictHistory = dhist.normalizeHistory(await loadDictHistory());
  renderDictHistory();
}

/** 记录一次查询：去重提前 + 截断，落盘失败不阻塞查询本身 */
function recordDictLookup(word, source){
  const entry = dhist.makeEntry(word, Date.now(), source);
  if (!entry) return;
  const next = dhist.pushHistory(dictHistory, entry);
  if (next.length === dictHistory.length && next[0] && entry && dictHistory[0] && dictHistory[0].word === next[0].word
      && dictHistory[0].at === next[0].at) return;   // 值没变（连续查同一个词）→ 不写盘
  dictHistory = next;
  renderDictHistory();
  saveDictHistory(dictHistory).catch(() => {});
}

function renderDictHistory(){
  const box = document.getElementById('dictHistory');
  if (!box) return;
  box.innerHTML = '';
  if (!dictHistory.length){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const label = document.createElement('span');
  label.className = 'dh-label';
  label.textContent = '最近';
  box.appendChild(label);

  for (const it of dictHistory.slice(0, 12)){
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dh-chip';
    chip.dataset.source = it.source;
    chip.textContent = it.word;
    chip.title = dhist.describeHistorySource(it.source) + '查询 · 点击重查';
    chip.addEventListener('click', () => {
      const input = document.getElementById('dictInput');
      if (input) input.value = it.word;
      doDictLookup(it.word, undefined, 'history');
    });
    box.appendChild(chip);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'dh-clear';
  clear.textContent = '清空';
  clear.title = '清空查词历史（不影响收藏）';
  clear.addEventListener('click', () => {
    dictHistory = [];
    renderDictHistory();
    saveDictHistory([]).catch(() => {});
  });
  box.appendChild(clear);
}

function renderDictFavorites(){
  const box = document.getElementById('favList');
  if (!box) return;
  box.innerHTML = '';
  if (!dictFavorites.length){
    box.appendChild(emptyProofItem('还没有收藏的词典词条。查询结果卡片标题旁的 ☆ 可收藏。'));
    return;
  }
  dictFavorites.forEach((f) => {
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
/**
 * MDD 附属资源完整水化: 图片/音频/视频/object/use 的本地 src → data URL;
 * <link rel="stylesheet">(MDD 里的 css)与内联 <style> 文本中的 url()(字体/背景图)一并水化。
 * 无 MDD(浏览器/会话)时移除本地 stylesheet link,避免相对 href 404。
 */
function ensureDictProfileStyle(profile){
  if (!profile || dictProfileStyles.has(profile.id)) return;
  const style = document.createElement('style');
  style.dataset.dictProfile = profile.id;
  style.textContent = profileNormalizationCss(profile);
  document.head.appendChild(style);
  dictProfileStyles.add(profile.id);
}

function decodeBase64Text(b64){
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e){ return null; }
}

function assetCssMatch(assets, href){
  const key = srcToResourceKey(href);
  const base = key.split(/[\\/]/).pop();
  return (assets.css || []).find(x => x.key === key || x.key === base || x.key.split(/[\\/]/).pop() === base) || null;
}

function normalizeInlineDictionaryStyles(body, profile){
  for (const el of body.querySelectorAll('[style]')){
    const raw = el.getAttribute('style') || '';
    const replaced = mdx.replaceCssTokens(raw, profile.tokens || {});
    el.setAttribute('style', mdx.normalizeDictionaryColors(replaced));
  }
  for (const el of body.querySelectorAll('[bgcolor]')){
    const color = el.getAttribute('bgcolor');
    if (color) el.style.backgroundColor = color;
    el.removeAttribute('bgcolor');
  }
  for (const el of body.querySelectorAll('[color]')){
    const color = el.getAttribute('color');
    if (color) el.style.color = color;
    el.removeAttribute('color');
  }
}

function appendDictProfileStyle(body, profile){
  if (body.querySelector('style[data-dict-normalization]')) return;
  const style = document.createElement('style');
  style.dataset.dictNormalization = profile.id;
  style.textContent = profileNormalizationCss(profile);
  body.appendChild(style);
}

/** MDD/CSS 资源水化: 支持多 CSS、独立 CSS、profile 作用域与多种资源路径。 */
function hydrateMddResources(body, assets){
  const mdd = assets && assets.mdd;
  const profile = (assets && assets.profile) || profileForDictionary(body.dataset.dictSource || '');
  const cssScope = '.dc-html[data-dict-profile="' + profile.id + '"]';
  normalizeInlineDictionaryStyles(body, profile);
  const styleEls = [...body.querySelectorAll('style')];
  const linkEls = [...body.querySelectorAll('link[rel="stylesheet"]')].filter(l => {
    const h = l.getAttribute('href'); return h && isMddResourceSrc(h);
  });
  if (!mdd && !(assets && assets.css && assets.css.length)){
    linkEls.forEach(el => el.remove());
  }
  if (mdd){
    for (const el of [...body.querySelectorAll('img[src],audio[src],video[src],source[src],object[data],use[href]')]){
      const raw = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href');
      if (!raw || !isMddResourceSrc(raw)) continue;
      const key = srcToResourceKey(raw);
      mdd.resourceB64(key).then(b64 => {
        if (!b64) return;
        const mime = mimeFromExt(raw);
        const attr = el.hasAttribute('src') ? 'src' : (el.hasAttribute('data') ? 'data' : 'href');
        el.setAttribute(attr, 'data:' + mime + ';base64,' + b64);
      }).catch(() => {});
    }
  }
  const cssResolver = async (href) => {
    const key = srcToResourceKey(href);
    if (mdd){
      const b64 = await mdd.resourceB64(key).catch(() => null);
      if (b64) return decodeBase64Text(b64);
    }
    const extra = assetCssMatch(assets || {}, href);
    return extra ? extra.text : null;
  };
  Promise.all(linkEls.map(async l => ({ l, text: await cssResolver(l.getAttribute('href')) })))
    .then(linkRes => {
      const linkedKeys = new Set(linkEls.map(l => srcToResourceKey(l.getAttribute('href') || '').split(/[\\/]/).pop()));
      const standalone = (assets && assets.css ? assets.css.filter(x => !linkedKeys.has(x.key.split(/[\\/]/).pop())) : []);
      const cssTexts = [...linkRes.filter(x => x.text).map(x => x.text), ...standalone.map(x => x.text), ...styleEls.map(s => s.textContent || '')];
      const needed = [];
      for (const t of cssTexts) for (const u of mdx.extractCssUrls(t)) if (isMddResourceSrc(u)) needed.push(srcToResourceKey(u));
      const unique = [...new Set(needed)];
      const applyCss = (text) => mdx.normalizeDictionaryCss(mdx.hydrateCssUrls(text, () => null), { scope: cssScope, tokens: profile.tokens || {} });
      if (!unique.length){
        for (const el of styleEls) if (el.textContent) el.textContent = applyCss(el.textContent);
        for (const x of linkRes) if (x.text){ const st = document.createElement('style'); st.textContent = applyCss(x.text); x.l.replaceWith(st); }
        for (const x of standalone){ const st = document.createElement('style'); st.dataset.dictAsset = x.key; st.textContent = applyCss(x.text); body.appendChild(st); }
        appendDictProfileStyle(body, profile);
        return;
      }
      return Promise.all(unique.map(k => mdd ? mdd.resourceB64(k).then(b64 => ({ k, b64 })) : Promise.resolve({ k, b64: null }))).then(urls => {
        const umap = new Map(urls.filter(x => x.b64).map(x => [x.k, { b64: x.b64, mime: mimeFromExt(x.k) }]));
        const resolve = k => umap.has(k) ? umap.get(k) : null;
        const applyHydrated = (text) => mdx.normalizeDictionaryCss(mdx.hydrateCssUrls(text, resolve), { scope: cssScope, tokens: profile.tokens || {} });
        for (const el of styleEls) if (el.textContent) el.textContent = applyHydrated(el.textContent);
        for (const x of linkRes){
          if (!x.text) continue;
          const st = document.createElement('style'); st.textContent = applyHydrated(x.text); x.l.replaceWith(st);
        }
        for (const x of standalone){ const st = document.createElement('style'); st.dataset.dictAsset = x.key; st.textContent = applyHydrated(x.text); body.appendChild(st); }
        appendDictProfileStyle(body, profile);
      });
    }).catch(() => { /* 缺失 css/资源: 保留已消毒内容 */ });
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
        // 剥掉 sound:// 协议头再当资源 key 查(大词泉等词典的读音是 href 形式,不带 data-sound)
        const key = mdx.soundResourceKey(soundEl.getAttribute('data-sound') || soundEl.getAttribute('href'));
        try {
          const b64 = await mdd.resourceB64(key);
          if (!b64) { toast('未找到发音文件：' + key); return; }
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
  doDictLookup(word, undefined, 'selection');
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
  del.addEventListener('click', async () => {
    const ok = await showConfirm({ title: '删除片段「' + k + '」', message: '该片段将从片段库移除，无法撤销。', confirmText: '删除', danger: true });
    if (!ok) return;
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
  if (!k || !v.trim()){ toastError('请填写缩写与展开文本'); return; }
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
  markDirty();
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
  const cfg = currentParseFromUI();
  const errors = validateParseConf(cfg);
  if (errors.length){
    document.getElementById('setTestOut').textContent = '规则错误：\n' + errors.map(e => '• ' + e).join('\n');
    return;
  }
  setParseConf(cfg); // 临时套用 UI 上的规则做测试
  const pp = parsePrefix(input);
  // 提取编号(命名组优先;自动模式取前缀第一段)并做名字行判定测试
  let id = pp.named ? pp.id : '';
  if (!id && pp.prefix){
    const cfg = getParseConf();
    const sep = '[' + cfg.open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + cfg.close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']';
    id = (pp.prefix.replace(new RegExp('^' + sep), '').split(new RegExp(sep))[0] || '').trim();
  }
  const pats = cfg.nameIdPatterns;
  const isName = id && pats.some(p => new RegExp(p, 'i').test(id));
  document.getElementById('setTestOut').textContent =
    '前缀: ' + (pp.prefix === '' ? '（无）' : pp.prefix) + '\n' +
    '正文: ' + (pp.content === '' ? '（空）' : pp.content) +
    (id ? '\n编号: ' + id + (pats.length ? '  名字行判定: ' + (isName ? '是' : '否') : '') : '');
  // 测试不落盘;关闭/保存时才真正生效
}

async function saveParseSettings(){
  const nextParse = currentParseFromUI();
  const errors = validateParseConf(nextParse);
  if (errors.length){
    document.getElementById('setTestOut').textContent = '规则错误：\n' + errors.map(e => '• ' + e).join('\n');
    toastError('解析规则无效：' + errors[0]);
    return false;
  }
  const s = await loadSettings();
  s.parse = nextParse;
  await saveSettings(s);
  setParseConf(s.parse);
  closeParseSettings();
  toast('解析规则已保存,重新导入文件后生效。');
  return true;
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
  const srcPaste = document.getElementById('recogSrcPaste');
  const hasFile = !!model.getRawText();
  srcFile.checked = hasFile;
  srcPaste.checked = !hasFile;
  document.getElementById('recogFileHint').textContent = '';
  document.getElementById('recogOut').textContent = '';
  setRecogActions(false);
  recogState = null;
  srcFile.disabled = !hasFile;
  srcFile.parentElement.title = hasFile ? '' : '请先导入文件，或使用「外部文本」';
  toggleRecogSource();
}

function setRecogActions(show, canCanonicalize = show){
  for (const id of ['btnRecogApply', 'btnRecogProfile']){
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  }
  for (const id of ['btnRecogLoad', 'btnRecogCanon']){
    const el = document.getElementById(id);
    if (el) el.hidden = !show || !canCanonicalize;
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
    profile = enrichDetectionProfile(text, recogDetect(text, model.getFilename() || '粘贴文本'));
  }
  let report = renderReport(profile);

  // 镜像格式(如 dc4ph)没有译文标记(marks.close 为空),但规范化/还原流程完整可用 —— 同样放行
  const isMirrorProfile = profile.structure?.shape === 'mirror-dc4ph' ||
    profile.formatProfile?.framing?.shape === 'mirror-dc4ph';

  // 用真实解析器模拟编辑器导入(在 worker 内用同一份 parsers 模块)
  if (profile.marks && (profile.marks.close || isMirrorProfile)){
    try {
      const canon = await wkr.recogCanonicalize(profile);
      const b = await wkr.recogAnalyzeWithParsers(canon, { open: '☆', close: '★', regex: '' }, 'b');
      report += '\n==== 编辑器模拟 ====\n';
      if (!isMirrorProfile){
        const a = await wkr.recogAnalyzeWithParsers(text, profile.parseConfig, 'a');
        report += '[原文件 + 识别配置] 段落 ' + a.paras + ' 有编号 ' + a.withId + '/' + a.paras +
          ' 名字栏可用 ' + a.named + ' 无损还原 ' + (a.roundTrip === true ? '✓' : '✗ ' + a.roundTrip) + '\n';
      }
      report += '[规范化文本] 段落 ' + b.paras + ' 有编号 ' + b.withId + '/' + b.paras +
        ' 名字栏可用 ' + b.named + ' 无损还原 ' + (b.roundTrip === true ? '✓' : '✗ ' + b.roundTrip);
      recogState = { profile, canonicalText: canon };
    } catch (e){
      const fallback = canonicalizeProfile(profile);
      recogState = { profile, canonicalText: fallback.ok ? fallback.text : '' };
      report += '\n(编辑器模拟失败: ' + (e && e.message ? e.message : e) + ')';
      if (!fallback.ok) report += '\n通用规范化已停用：存在无法安全归类的物理行。可下载档案检查，但不会提供可能丢数据的规范化文本。';
    }
  } else {
    recogState = null;
  }
  out.textContent = report;
  setRecogActions(!!recogState && !!profile.marks, !!recogState?.canonicalText);
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
  saveParseSettings().then(saved => {
    if (saved) showToast('✅ 已应用为解析规则: 原文 ' + cfg.open + ' / 译文 ' + (cfg.close || '★') + '（重新导入原文件生效）');
  });
}

function loadCanonicalIntoEditor(){
  if (!recogState || !recogState.canonicalText) return;
  const canon = recogState.canonicalText;
  // 规范化文本是编辑器原生 ☆/★,当前文档用默认规则解析(不改已保存的 settings.parse);
  // # 注释行强制剥离(canonicalParseConf),避免控制行/#0x 地址头落到原文行
  setParseConf(canonicalParseConf());
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
// 漏翻/异常(proof) + 术语一致性(qa) 合并统计。
// 两处 UI（顶栏 chip / 侧栏清单）共用同一函数，避免计数分叉。
function missingIssues(){
  const a = proof.analyzeRows();
  const q = qa.analyzeQA(model.getParas(), glossData);
  return { a, q, total: a.total + q.total };
}

function refreshProofUI(){
  const st = proof.stats();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('pfAll', st.total);
  set('pfPending', st.pending);
  set('pfIssue', st.issue);
  set('pfApproved', st.approved);
  const miss = missingIssues();
  set('pfMissing', miss.total);
  const pvm = document.getElementById('pvMissingCount');
  if (pvm) pvm.textContent = miss.total;
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
  else if (tab === 'mtdiff') renderMtDiff();
  else renderAnnoOverview();
}

// 清单标签 / 语气（issue=需要修，suggestion=可疑待人工判断）。
// 前三个来自 proof.analyzeRows，后四个来自 qa.analyzeQA。
const ISSUE_KIND_LABEL = {
  missing: '漏翻', placeholder: '占位未译', ratio: '长度可疑',
  term: '术语未用', 'name-conflict': '译名冲突', token: '占位符缺失', punct: '半角标点',
};
const ISSUE_KIND_TONE = {
  ratio: 'suggestion', punct: 'suggestion',
};

// QA 条目的补充说明（术语期望值 / 冲突译名 / 缺失占位符 / 建议标点）
function issueDetail(x){
  switch (x.kind){
    case 'term': return `术语「${x.term}」未用约定译名「${x.expect}」`;
    case 'name-conflict': return `译名不统一：${x.values.map((v, k) => `${v}×${x.counts[k]}`).join(' / ')}`;
    case 'token': return `占位符「${x.value}」在译文中缺失`;
    case 'punct': return x.unbalanced ? `引号不配对：「」数量不等` : `半角「${x.ch}」建议改为全角「${x.suggest}」`;
    default: return '';
  }
}

function renderMissingList(){
  const list = document.getElementById('missingList');
  if (!list) return;
  const { a, q, total } = missingIssues();
  document.getElementById('pvMissingCount').textContent = total;
  // 顶栏漏翻计数 chip 同步
  const chip = document.getElementById('pfMissing');
  if (chip) chip.textContent = total;
  list.innerHTML = '';
  if (!total){
    list.appendChild(emptyProofItem('没有漏翻、异常或术语问题。'));
    return;
  }
  const all = [
    ...a.missing, ...a.placeholder, ...a.ratio,
    ...q.term, ...q['name-conflict'], ...q.token, ...q.punct,
  ];
  all.forEach(x => {
    const el = document.createElement('div');
    el.className = 'proof-item';
    el.style.cursor = 'pointer';
    const head = document.createElement('div');
    const kind = document.createElement('span');
    kind.className = 'pr-tag ' + (ISSUE_KIND_TONE[x.kind] === 'suggestion' ? 'pr-tag-suggestion' : 'pr-tag-issue');
    kind.textContent = ISSUE_KIND_LABEL[x.kind] || x.kind;
    head.textContent = '第' + (x.i + 1) + '行 ';
    head.style.color = 'var(--text-muted)';
    head.appendChild(kind);
    el.append(head);

    const detail = issueDetail(x);
    if (detail){
      const d = document.createElement('div');
      d.className = 'proof-item-text';
      d.style.color = 'var(--st-issue-fg)';
      d.textContent = detail;
      el.append(d);
    }

    const orig = document.createElement('div');
    orig.className = 'proof-item-text';
    orig.textContent = x.origPreview;
    const tv = document.createElement('div');
    tv.className = 'proof-item-text muted';
    tv.textContent = x.transPreview || '（译文为空）';
    el.append(orig, tv);

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
    list.appendChild(emptyProofItem('暂无修改记录。开启「📋 校对」后，这里只对比最初文本与最新文本；同一句的中途输入会自动合并，改回原文则不显示。'));
    return;
  }
  changes.forEach(c => {
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
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();   // 只还原,不触发整条记录的跳转
      const r = proof.restoreChange(c.id);
      if (r && r.idx !== undefined){
        rdr.scrollRowIntoView(r.idx);
        rdr.focusIdx(r.idx);
      }
      updateProgress();
      updateUndoButtons();
      refreshProofUI();
    });
    const collectBtn = document.createElement('button');
    collectBtn.className = 'pr-btn obsidian-collect';
    collectBtn.textContent = '收藏到 Obsidian';
    collectBtn.title = '把这次改译与上下文保存为独立经验卡';
    collectBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 快照在打开预览前固定，不让等待设置读取或切换文件改变来源。
      try {
        const snapshot = { ...snapshotChange(model.getParas(), c), document: model.getStateKey(), filename: model.getFilename() };
        showObsidianExport(snapshot).catch(err => toastError('无法收藏：' + err.message));
      } catch (err) { toastError('无法收藏：' + err.message); }
    });
    el.append(src, head, diff, btn, collectBtn);
    // 点击整条记录跳到对应文本行(与 漏翻异常 / 批注总览 / 机翻对比 的行为一致);
    // 行号以 paraId 回查当前下标,和 restoreChange 用同一套映射,避免行号漂移后跳错行
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const idx = model.getParas().findIndex(p => p.orig === c.paraId);
      if (idx === -1){ toastError('该行已不在当前文档中'); return; }
      rdr.scrollRowIntoView(idx);
      rdr.focusIdx(idx);
    });
    list.appendChild(el);
  });
}

function toggleProofMode(){
  const on = !proof.isEnabled();
  proof.setEnabled(on);
  const proofButton = document.getElementById('btnProof');
  proofButton.classList.toggle('active', on);
  proofButton.setAttribute('aria-pressed', String(on));
  proofButton.textContent = on ? '校对中' : '校对';
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
  markDirty(); // 撤销/重做改变内存译文,原文件未动
  afterUndoRedo();
}
function doRedo(){
  const snap = proof.isEnabled() ? proof.snapshot() : null;
  if (!model.redo()) return;
  if (snap) proof.recordDiff(snap, 'redo');
  markDirty(); // 撤销/重做改变内存译文,原文件未动
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
  document.getElementById('textAreaOpacity').value =
    String(theme.normalizeTextAreaTransparency(await loadTextAreaTransparency()));
  updateTextAreaOpacityLabel();
  updateBgPreview(bg.dataUrl, bg.fit);
  // 主题模式
  const mode = theme.normalizeThemeMode(await loadThemeMode() || currentMode);
  for (const r of document.querySelectorAll('input[name="thMode"]')){
    r.checked = r.value === mode;
  }
  // 字体
  syncFontUI(await loadFontSettings());
  // 自定义字体库(元数据在 settings,浏览器端字节在 IndexedDB)
  fontLibrary = fonts.mergeFontLibrary(await loadFontLibrary());
  renderFontLibraryUI();
  renderFontPresetOptions();
  // 阅读密度 / 字节计数口径 / 字数上限
  document.getElementById('densitySelect').value = theme.normalizeDensity(await loadDensity());
  document.getElementById('byteEncSelect').value = bytes.normalizeEncoding(await loadByteEncoding());
  const savedLimit = await loadByteLimit();
  document.getElementById('byteLimitInput').value = savedLimit === null ? '' : String(savedLimit);
  updateByteLimitLabel();
  // 打开时重置到「界面设置」页
  thSwitchTab(document.querySelector('#thTabs button[data-thpage="0"]'));
  document.getElementById('themeModal').classList.add('show');
}

function updateBgOpacityLabel(){
  document.getElementById('bgOpacityVal').textContent =
    Math.round(Number(document.getElementById('bgOpacity').value) * 100) + '%';
}

/** 文本区透明度标签(0% = 实色,100% = 完全透出背景) */
function updateTextAreaOpacityLabel(){
  const el = document.getElementById('textAreaOpacity');
  const out = document.getElementById('textAreaOpacityVal');
  if (!el || !out) return;
  out.textContent = theme.normalizeTextAreaTransparency(el.value) + '%';
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
    pv.innerHTML = '<span>NO BACKDROP</span><small>尚未设置背景</small>';
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
  if (f.size > MAX_BG_SIZE){ toastError('图片过大（超过 4MB）。请压缩后再试。'); return; }
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
  // 文本区透明度(与遮罩强度互补: 遮罩压图片, 透明度让对白行透出图片)
  const textAlpha = theme.normalizeTextAreaTransparency(document.getElementById('textAreaOpacity').value);
  applyTextAreaTransparency(textAlpha);
  await saveTextAreaTransparency(textAlpha);
  // 主题模式
  const mode = theme.normalizeThemeMode(document.querySelector('input[name="thMode"]:checked').value);
  applyTheme(mode);
  await saveThemeMode(mode);
  // 字体
  const font = readFontFromUI();
  applyFonts(font);
  await saveFontSettings(font);
  // 阅读密度 / 字节计数口径
  const density = theme.normalizeDensity(document.getElementById('densitySelect').value);
  applyDensity(density);
  await saveDensity(density);
  const enc = bytes.normalizeEncoding(document.getElementById('byteEncSelect').value);
  applyByteEncoding(enc);
  await saveByteEncoding(enc);
  // 空输入 = 用户选择"不校验" → 存 0（而不是 null，null 语义是"从未配置"）
  const limitRaw = String(document.getElementById('byteLimitInput').value || '').trim();
  const limit = limitRaw ? bytes.normalizeByteLimit(limitRaw) : 0;
  applyByteLimit(limit);
  await saveByteLimit(limit);
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
  for (const id of ['mtProvider', 'btnMTSettings', 'btnMT', 'btnMTBatch', 'mtModal']){
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  document.querySelectorAll('.mt-group, [aria-label="翻译执行"]').forEach(el => { el.style.display = 'none'; });
}

/** 刷新下拉里各 provider 的「（未配置）」标记(配置加载/保存/切换后调用) */
function refreshMTProviderOptions(){
  for (const opt of $mtProvider.options){
    const p = mt.getProvider(opt.value);
    if (p) opt.textContent = '🤖 ' + p.name + (p.isConfigured() ? '' : '（未配置）');
  }
}

async function initMT(){
  if (NO_MT_BUILD) return;
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

/** 批量策略两个字段（Q6）：两种引擎共用，放在「采样参数」页 */
function mtBatchFields(conf){
  return mtField('批量策略（批次模式以返回的行号对齐；行数或控制标签对不上时该批自动退回逐行，不会错位写入）',
    '<select id="mtBatchMode">' +
      '<option value="perLine"' + (conf.batchMode === 'batched' ? '' : ' selected') + '>逐行（默认 · 最稳，失败只影响该行）</option>' +
      '<option value="batched"' + (conf.batchMode === 'batched' ? ' selected' : '') + '>按批次合并请求（一次翻译多行，省往返与时间）</option>' +
    '</select>') +
  mtField('每批行数（仅「按批次合并请求」生效）', mtNum('mtBatchSize', conf.batchSize, 2, 20));
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
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary)) +
    mtBatchFields(conf);
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
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary)) +
    mtBatchFields(conf);
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
  for (const b of document.querySelectorAll('#thTabs button')){
    const active = b === btn;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  }
  const p = Number(btn.dataset.thpage) || 0;
  for (const [index, id] of [[0, 'thPage0'], [1, 'thPage1']]){
    const panel = document.getElementById(id);
    const hidden = p !== index;
    panel.classList.toggle('hidden', hidden);
    panel.setAttribute('aria-hidden', String(hidden));
  }
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
      batchMode: document.getElementById('mtBatchMode').value,
      batchSize: Number(document.getElementById('mtBatchSize').value),
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
    batchMode: document.getElementById('mtBatchMode').value,
    batchSize: Number(document.getElementById('mtBatchSize').value),
  };
}

// 测试翻译一句
async function testMT(){
  const text = document.getElementById('mtTestIn').value.trim();
  if (!text){ toastError('请先输入要测试的日文。'); return; }
  const sel = document.getElementById('mtProviderSel').value;
  const cfg = readMTFormConfig();
  if (sel === 'sakura' && !cfg.host){
    toastError('请填写 Sakura / llama.cpp 服务地址（或点「检测端口」）。');
    return;
  }
  if (sel === 'llm' && (!cfg.baseUrl || !cfg.model)){
    toastError('请填写接口地址与模型名。');
    return;
  }
  const out = document.getElementById('mtTestOut');
  out.textContent = '翻译中…（本地模型可能需要几秒）';
  try {
    // 临时套用 UI 配置做测试(不落盘),失败时还原
    const prev = await mt.getProviderConfig(sel);
    await mt.setProviderConfig(sel, cfg);
    try {
      const result = await mt.translateTextProtected(sel, text, glossData);
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
    toastError('请填写 Sakura / llama.cpp 服务地址（或点「检测端口」自动查找）。');
    return;
  }
  if (sel === 'llm' && (!cfg.baseUrl || !cfg.model)){
    toastError('请填写接口地址与模型名。');
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
  toast('已保存「' + (sel === 'sakura' ? 'Sakura 本地' : '通用大模型') + '」配置。\n顶部「翻译当前行」/「批量翻译」即可使用。');
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
  if (!p){ toastError('请先导入文件'); return; }
  if (p.isName) return; // NAME 条目不机翻
  clearPushTimers();
  try {
    // 取完整结果（非流式），交给比对面板由译者裁定是否采用
    const result = await mt.translateTextProtected($mtProvider.value, p.content, glossData);
    const cleaned = stripBrackets(String(result).trim());
    const finalText = p.brackets ? ('「' + cleaned + '」') : cleaned;
    const ok = await showMtCompare({ orig: p.content, result: finalText });
    if (!ok){
      rdr.refreshRow(i);
      toast('已放弃机翻结果');
      return;
    }
    model.pushUndo([i]);
    p.translation = finalText;
    p.src = 'mt';      // 归因标记：采纳了机翻结果
    model.recalcDone(p);
    model.scheduleAutosave();
    rdr.refreshRow(i);
    updateProgress();
    markDirty();
    await recordMtBaseline([{ i, text: cleaned }]); // 留下机翻基线（机翻对比视图的参照）
  } catch (e){
    rdr.refreshRow(i);
    toastError(e.message || '翻译失败');
  }
}

async function mtTranslateBatch(){
  const paras = model.getParas();
  const pending = [];
  paras.forEach((p, i) => {
    if (!p.isName && !p.done) pending.push(i);
  });
  if (!pending.length){ toastError('没有未翻译的行。'); return; }

  // ① 翻译记忆：精确命中直接套用（零成本）；相似命中只提示，由人决定
  const tmExact = [], tmSimilar = [];
  for (const i of pending){
    const p = paras[i];
    const hit = tm.findExact(tmData, p.content);
    if (hit){ tmExact.push({ i, hit }); continue; }
    const sim = tm.findSimilar(tmData, p.content, { limit: 1 })[0];
    if (sim) tmSimilar.push({ i, sim });
  }
  const tmIndexes = new Set(tmExact.map(x => x.i));
  const toTranslate = pending.filter(i => !tmIndexes.has(i));

  let memApplied = 0;
  if (tmExact.length){
    model.pushUndo(tmExact.map(x => x.i));
    for (const { i, hit } of tmExact){
      const p = paras[i];
      p.translation = p.brackets ? ('「' + hit.dst + '」') : hit.dst;
      p.src = 'tm';   // 归因标记：翻译记忆复用
      model.recalcDone(p);
      rdr.refreshRow(i);
      memApplied++;
    }
    model.scheduleAutosave();
    updateProgress();
    markDirty();
  }

  if (!toTranslate.length){
    showToast('✅ 全部 ' + memApplied + ' 行命中翻译记忆，未调用机翻。'
      + (tmSimilar.length ? '\n另有 ' + tmSimilar.length + ' 行有相似记忆，可右键逐行「套用记忆」。' : ''));
    return;
  }

  const ask = '将批量翻译 ' + toTranslate.length + ' 个未翻译的行（串行调用本地模型，可能需要几分钟）。'
    + (memApplied ? '\n已有 ' + memApplied + ' 行由翻译记忆直接套用，不再调用机翻。' : '')
    + (tmSimilar.length ? '\n另有 ' + tmSimilar.length + ' 行存在相似记忆（需右键手动套用）。' : '')
    + '\n开始吗？';
  if (!confirm(ask)) return;

  await snapshotHistory('batch');   // 批量改写前留档：这是最需要后悔药的一步
  model.pushUndo(toTranslate);
  clearPushTimers();
  const conf = await mt.getProviderConfig($mtProvider.value);
  const batchMode = mt.normalizeBatchMode(conf.batchMode);
  const batchSize = mt.normalizeBatchSize(conf.batchSize);
  const fnameEl = document.getElementById('fname');
  const origFname = fnameEl.textContent;
  let ok = 0;
  let fellBack = 0;
  const failed = [];
  const mtRecords = [];   // 机翻基线（机翻 → 定稿对比视图的参照）

  // 写入一行（与逐行模式完全同一套清理/包括号规则，避免两种模式产出口径分叉）
  const applyOne = (i, raw) => {
    const p = paras[i];
    const cleaned = stripBrackets(String(raw == null ? '' : raw).trim());
    p.translation = p.brackets ? ('「' + cleaned + '」') : cleaned;
    p.src = 'mt';     // 归因标记：机翻写入
    model.recalcDone(p);
    mtRecords.push({ i, text: cleaned });
    ok++;
    rdr.refreshRow(i);
  };

  // 逐行路径：批次模式失败时也回退到这里
  const runPerLine = async (list, done0) => {
    for (let k = 0; k < list.length; k++){
      const i = list[k];
      fnameEl.textContent = '🔄 批量机翻中 ' + (done0 + k + 1) + ' / ' + toTranslate.length + ' …';
      try {
        applyOne(i, await mt.translateTextProtected($mtProvider.value, paras[i].content, glossData));
      } catch (e){
        failed.push({ i, err: e.message });
      }
    }
  };

  if (batchMode === 'batched' && toTranslate.length > 1){
    for (let g = 0; g < toTranslate.length; g += batchSize){
      const group = toTranslate.slice(g, g + batchSize);
      fnameEl.textContent = '🔄 批量机翻中 ' + (g + group.length) + ' / ' + toTranslate.length + ' …';
      let outs = null;
      try {
        outs = group.length === 1
          ? [await mt.translateTextProtected($mtProvider.value, paras[group[0]].content, glossData)]
          : await mt.translateLinesBatched($mtProvider.value, group.map(i => paras[i].content), glossData);
      } catch (e){
        outs = null;   // 网络/接口错误也走回退，让失败粒度落到单行
      }
      if (!outs){
        fellBack += group.length;
        await runPerLine(group, g);
        continue;
      }
      group.forEach((i, k) => applyOne(i, outs[k]));
    }
  } else {
    await runPerLine(toTranslate, 0);
  }

  fnameEl.textContent = origFname;
  model.scheduleAutosave();
  recomputeMatchesUI(true);
  updateProgress();
  if (ok > 0) markDirty(); // 批量机翻结果未写回原文件
  if (ok > 0) await harvestTm(); // 新译文进翻译记忆，下次同句式不再重复扣费
  if (ok > 0) await recordMtBaseline(mtRecords); // 留机翻基线：之后的人工改动可在「机翻对比」里看到
  touchStats();                  // 批量结果计入当天进度（含来源归因）
  const msgs = [];
  if (memApplied) msgs.push('翻译记忆 ' + memApplied + ' 行');
  if (ok) msgs.push('机翻 ' + ok + ' 行');
  if (failed.length) msgs.push('失败 ' + failed.length + ' 行');
  if (fellBack) msgs.push('批次退回逐行 ' + fellBack + ' 行');
  if (failed.length){
    toastError('批量翻译完成：' + msgs.join(' · ') + '。\n失败原因示例：' + failed[0].err);
  } else {
    toast('批量翻译完成：' + msgs.join(' · ') + '。\n想知道自己改了机翻的哪些地方 → 侧栏「校对 → 🤖 机翻对比」。');
  }
}

/* ---------------- 侧边栏 / 文件夹浏览器 ---------------- */

function syncSidebarTop(){
  const tb = document.getElementById('topbar');
  const main = document.getElementById('main');
  const footer = document.querySelector('footer');
  if (!tb || !main) return;
  const h = tb.offsetHeight;
  const fh = footer ? footer.offsetHeight : 0;
  // Stage 内部由 CSS Grid 分配 scene header / review strip / virtual list 的高度。
  main.style.height = 'calc(100vh - ' + h + 'px - ' + fh + 'px)';
}

function setSidebar(open){
  const sb = document.getElementById('sidebar');
  const toggle = document.getElementById('btnSidebar');
  sb.classList.toggle('hidden', !open);
  sb.classList.toggle('is-open', open);
  if (toggle) toggle.setAttribute('aria-pressed', String(open));
  if (open) syncSidebarTop();
}

// 场景树「当前脚本」卡的完成度分段条（规范 §7.2 / §7.5）。
// 与文档标签共用 filestats.js 的纯逻辑，颜色语义也一致；无内容时整条隐藏。
function renderRailProgress(){
  const host = document.getElementById('railProgressBar');
  if (!host) return;
  const counts = countStates(model.getParas());
  host.textContent = '';
  if (!hasData(counts)){ host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.classList.toggle('complete', isComplete(counts));
  const a11y = summaryText(counts);
  host.setAttribute('aria-label', a11y);
  host.title = a11y;

  const bar = document.createElement('div');
  bar.className = 'seg-bar';
  for (const seg of segments(counts)){
    const el = document.createElement('div');
    el.className = 'seg ' + seg.key;
    el.style.flexGrow = String(seg.ratio > 0 ? seg.ratio : 0.0001);
    bar.appendChild(el);
  }
  const pct = document.createElement('span');
  pct.className = 'rail-pct';
  pct.textContent = percentText(counts);
  host.append(bar, pct);
}

function syncEditorialMeta(){
  const file = model.getFilename() || '';
  const count = model.getParas().length;
  const progress = document.getElementById('progress').textContent.trim();
  const stats = document.getElementById('stats').textContent.trim();
  const label = file || '未打开文档';
  const railFile = document.getElementById('railFilename');
  const railProgress = document.getElementById('railProgress');
  const sceneTitle = document.getElementById('sceneTitle');
  const sceneReference = document.getElementById('sceneReference');
  const sceneProgress = document.getElementById('sceneProgress');
  if (railFile) railFile.textContent = label;
  if (railProgress) railProgress.textContent = progress || (count ? count + ' 条对白' : '等待导入');
  renderRailProgress();
  if (sceneTitle) sceneTitle.textContent = file || '从一句对白开始。';
  if (sceneReference) sceneReference.textContent = count ? ('SCRIPT · ' + count + ' LINES') : 'NO SCENE';
  if (sceneProgress) sceneProgress.textContent = stats || progress || '准备就绪';
  touchSession();   // 会话标记跟随当前文档（异常退出后才知道该重开哪个文件）
}

function setHeaderSaveState(label, tone = 'ready'){
  const el = document.getElementById('headerSaveState');
  if (!el) return;
  el.textContent = label;
  el.dataset.state = tone;
}

function updateContextFromRow(i){
  const p = model.getPara(i);
  if (!p) return;
  const ref = p.id ? String(p.id) : ('LINE ' + String(i + 1).padStart(4, '0'));
  const speaker = p.nameTr || p.name || 'NARRATION';
  const original = (p.content || '').replace(/\s+/g, ' ').trim();
  const ctxRef = document.getElementById('contextReference');
  const ctxSpeaker = document.getElementById('contextSpeaker');
  const ctxOrig = document.getElementById('contextOriginal');
  const sceneReference = document.getElementById('sceneReference');
  if (ctxRef) ctxRef.textContent = ref;
  if (ctxSpeaker) ctxSpeaker.textContent = speaker;
  if (ctxOrig) ctxOrig.textContent = original || '人物名或系统文本';
  if (sceneReference) sceneReference.textContent = 'LINE ' + String(i + 1).padStart(4, '0') + ' · ' + ref;
}

/* ---- 侧边栏拖拽调宽: 左缘手柄,宽度记忆在 localStorage,双击复位 ---- */

const SB_W_KEY = 'galtrans_sidebar_width';
const SB_W_MIN = 260, SB_W_DEFAULT = 328;

function sidebarMaxWidth(){
  // 移动端侧栏由 CSS 作为抽屉铺开,不应被桌面端的宽度上限覆盖。
  if (window.innerWidth <= 720) return Math.max(SB_W_MIN, window.innerWidth - 24);
  const rail = window.innerWidth <= 1180 ? 184 : 224;
  return Math.max(SB_W_MIN, Math.min(560, window.innerWidth - rail - 440));
}

function setSidebarWidth(sb, width){
  const w = Math.round(Math.min(Math.max(width, SB_W_MIN), sidebarMaxWidth()));
  sb.style.width = w + 'px';
  // The editorial layout is Grid-based, so the track token, not only the element width, controls the visible panel width.
  document.documentElement.style.setProperty('--context-w', w + 'px');
}

/**
 * 段落行右键菜单接入。
 * 全部动作复用既有函数,本函数不实现任何业务逻辑。
 * 译文 textarea 上不接管右键(见 rowmenu.js 顶部设计说明),保留原生粘贴/输入法候选。
 */
/* ---------------- 翻译进度统计（ROADMAP P2-4） ---------------- */

let statsStore = null;          // 当前项目的统计库（懒加载）
let statsProjectPath = null;    // 落盘位置（源文件绝对路径；浏览器为 null）
let statsWriteTimer = null;

async function loadStatsForProject(sourcePath){
  statsProjectPath = sourcePath || null;
  statsStore = await stats.loadStats(statsProjectPath);
}

/**
 * 把当前进度写进"当天"记录（覆盖写，不是累加）。
 * 口径说明：done/total 用 filestats.countStates（与进度条、场景树同一来源），
 * 来源构成用 stats.countBySource（内部同样以 p.done 为准），两者不会分叉。
 */
function recordStatsNow(){
  if (!statsProjectPath || !statsStore) return false;
  const paras = model.getParas();
  const counts = countStates(paras);
  if (!counts.total) return false;
  const bySrc = stats.countBySource(paras);
  statsStore = stats.recordDay(statsStore, model.getStateKey(), {
    name: model.getFilename() || '',
    at: Date.now(),
    done: counts.done,
    total: counts.total,
    byMt: bySrc.mt, byTm: bySrc.tm, byHuman: bySrc.human,
  });
  return true;
}

/** 落盘节流：连续保存/批量机翻之间不反复写盘 */
function saveStatsSoon(){
  if (statsWriteTimer || !statsProjectPath) return;
  statsWriteTimer = setTimeout(async () => {
    statsWriteTimer = null;
    try { await stats.saveStats(statsProjectPath, statsStore); } catch (e) { /* 统计写不进不阻塞业务 */ }
  }, 15000);
}

/** 记录一次进度（改内存 + 排一次落盘） */
function touchStats(){
  if (recordStatsNow()) saveStatsSoon();
}

/** 立刻落盘（开面板前 / 关窗前） */
async function flushStats(){
  if (statsWriteTimer){ clearTimeout(statsWriteTimer); statsWriteTimer = null; }
  if (!statsProjectPath || !statsStore) return;
  try { await stats.saveStats(statsProjectPath, statsStore); } catch (e) { /* 忽略 */ }
}

async function openStats(){
  if (!model.getParas().length){ toastError('请先导入文本文件'); return; }
  recordStatsNow();
  await flushStats();
  const paras = model.getParas();
  const counts = countStates(paras);
  const summary = stats.summarize({
    history: stats.historyOf(statsStore, model.getStateKey()),
    done: counts.done,
    total: counts.total,
    bySrc: stats.countBySource(paras),
  });
  await showStatsPanel({ docName: model.getFilename() || '', summary });
}

/* ---------------- 机翻基线 / 机翻对比（ROADMAP P2-7） ---------------- */

let mtBaseline = mtbase.emptyBaseline();
let mtProjectPath = null;      // 基线落盘位置（源文件绝对路径；浏览器版为 null）

async function loadMtBaselineForProject(sourcePath){
  mtProjectPath = sourcePath || null;
  mtBaseline = await mtbase.loadBaseline(mtProjectPath, model.getParas().length);
}

/**
 * 把机翻输出写进基线（异步落盘，不阻塞行刷新）。
 * 桌面版才有落盘位置；浏览器版没有基线可比，如实跳过而不是假装记了。
 */
async function recordMtBaseline(entries){
  if (!mtProjectPath || !entries || !entries.length) return;
  const next = mtbase.recordMt(mtBaseline, model.getParas(), entries);
  if (next === mtBaseline) return;
  mtBaseline = next;
  try { await mtbase.saveBaseline(mtProjectPath, mtBaseline); } catch (e) { /* 基线写不进不阻塞 */ }
}

/** 把某行回滚到机翻原稿（从基线取值，括号按行类型包回） */
function revertRowToMt(i){
  const p = model.getPara(i);
  if (!p || p.isName) return false;
  const row = Array.isArray(mtBaseline.rows) ? mtBaseline.rows[i] : null;
  const text = Array.isArray(row) ? String(row[1] || '') : '';
  if (!text.trim()){ toastError('这一行没有机翻基线。'); return false; }
  model.pushUndo([i]);
  p.translation = p.brackets ? ('「' + text + '」') : text;
  p.src = 'mt';    // 回滚即重新采纳机翻
  model.recalcDone(p);
  rdr.refreshRow(i);
  model.scheduleAutosave();
  updateProgress();
  markDirty();
  renderMtDiff();  // 改完重算，让清单立即反映
  return true;
}

function renderMtDiff(){
  const countEl = document.getElementById('pvMtCount');
  const sumEl = document.getElementById('mtDiffSummary');
  const catsEl = document.getElementById('mtDiffCats');
  const listEl = document.getElementById('mtDiffList');
  if (!listEl) return;

  const r = mtbase.mtEdits(mtBaseline, model.getParas());
  if (countEl) countEl.textContent = r.edits.length;
  const s = mtbase.summarizeEdits(r.edits);

  if (sumEl){
    sumEl.innerHTML = '';
    const put = (value, label) => {
      const m = document.createElement('div'); m.className = 'm';
      const b = document.createElement('b'); b.textContent = value;
      const sp = document.createElement('span'); sp.textContent = label;
      m.append(b, sp);
      sumEl.appendChild(m);
    };
    put(r.edits.length, '有人工改动');
    put(r.kept, '直接采纳');
    put(mtbase.keepRateText(r), '机翻采纳率');
    put(mtbase.baselineCount(mtBaseline), '基线条数');
  }

  if (catsEl){
    catsEl.innerHTML = '';
    if (!s.categories.length){
      catsEl.appendChild(emptyProofItem('还没有可归类的人工改动。批量机翻并修改一些行后，这里会按改动类型汇总。'));
    }
    for (const c of s.categories){
      const el = document.createElement('div');
      el.className = 'pr-item';
      const head = document.createElement('div');
      head.style.color = 'var(--text-muted)';
      head.textContent = c.label + ' ';
      const count = document.createElement('span');
      count.className = 'cat-count';
      count.textContent = c.count;
      head.appendChild(count);
      el.appendChild(head);
      for (const x of c.examples){
        const line = document.createElement('div');
        line.className = 'cat-example';
        const b = document.createElement('b');
        b.textContent = '第' + (x.i + 1) + '行';
        line.append(b, ' ' + x.before + ' → ' + x.after);
        el.appendChild(line);
      }
      if (c.count > c.examples.length){
        const more = document.createElement('div');
        more.className = 'cat-example';
        more.textContent = '…以及另外 ' + (c.count - c.examples.length) + ' 条，见下方明细';
        el.appendChild(more);
      }
      catsEl.appendChild(el);
    }
  }

  listEl.innerHTML = '';
  if (!r.edits.length){
    listEl.appendChild(emptyProofItem('机翻结果与当前译文完全一致，或还没有机翻基线。'));
    return;
  }
  for (const e of r.edits.slice().sort((a, b) => a.i - b.i)){
    const el = document.createElement('div');
    el.className = 'pr-item';

    const head = document.createElement('div');
    head.style.color = 'var(--text-muted)';
    head.textContent = '第' + (e.i + 1) + '行 ';
    const tag = document.createElement('span');
    tag.className = 'pr-tag pr-tag-suggestion';
    tag.textContent = mtbase.EDIT_LABELS[mtbase.classifyEdit(e.before, e.after)] || '改动';
    head.appendChild(tag);
    el.appendChild(head);

    const rows = document.createElement('div');
    rows.className = 'mt-row';
    const line = (label, text, cls) => {
      const l = document.createElement('div'); l.className = 'mt-line';
      const t = document.createElement('span'); t.className = 'mt-tag'; t.textContent = label;
      const d = document.createElement('div'); d.className = 'mt-text ' + cls; d.textContent = text || '（空）';
      l.append(t, d);
      return l;
    };
    rows.append(line('机翻', e.before, 'mt-before'), line('定稿', e.after, 'mt-after'));
    el.appendChild(rows);

    const btn = document.createElement('button');
    btn.className = 'pr-btn';
    btn.textContent = '用机翻';
    btn.title = '把这一行改回机翻原稿（可 Ctrl+Z 撤销）';
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); revertRowToMt(e.i); });
    el.appendChild(btn);

    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      rdr.scrollRowIntoView(e.i);
      rdr.focusIdx(e.i);
    });
    listEl.appendChild(el);
  }
}

/** 清空基线：只抹参照不动译文（是破坏性操作，需确认） */
async function clearMtBaseline(){
  if (!mtbase.baselineCount(mtBaseline)){ toastError('还没有机翻基线可清。'); return; }
  const ok = await showConfirm({
    title: '清空机翻基线（' + mtbase.baselineCount(mtBaseline) + ' 条）',
    message: '清空后「机翻对比」将没有参照可用，直到下一次批量机翻重新写入。\n译文本身不会被改动。',
    confirmText: '清空基线',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  mtBaseline = mtbase.emptyBaseline();
  if (mtProjectPath) await mtbase.saveBaseline(mtProjectPath, mtBaseline);
  renderMtDiff();
  showToast('已清空机翻基线（译文未改动）');
}

/* ---------------- 翻译记忆 TM（ROADMAP P1-3） ---------------- */

let tmData = tm.emptyTm();     // { version, entries }
let tmProjectPath = null;      // 记忆库定位用的源文件绝对路径（浏览器版为 null）

async function loadTmForProject(sourcePath){
  tmProjectPath = sourcePath || null;
  tmData = await tm.loadTm(tmProjectPath);
}

/**
 * 把当前文档已完成行收割进记忆库并落盘。
 * 在"保存原文件"与"批量机翻"之后调用 —— 这两处是译文真正稳定下来的时点。
 */
async function harvestTm(){
  const { tm: next, added } = tm.collectFromParas(model.getParas(), tmData, Date.now());
  tmData = next;
  if (added > 0) await tm.saveTm(tmProjectPath, tmData);
  return added;
}

/** 行菜单建议文案：精确命中优先，否则最高相似命中；都没有返回 ''（菜单项禁用） */
function tmHintFor(p){
  if (!p || p.isName) return '';
  const hit = tm.findExact(tmData, p.content);
  if (hit) return tm.suggestLabel(hit.dst);
  const sim = tm.findSimilar(tmData, p.content, { limit: 1 })[0];
  return sim ? tm.suggestLabel(sim.entry.dst) : '';
}

/** 取某行可用的记忆条目（精确优先，否则最高相似） */
function tmHitFor(p){
  if (!p || p.isName) return null;
  return tm.findExact(tmData, p.content)
    || (tm.findSimilar(tmData, p.content, { limit: 1 })[0] || {}).entry
    || null;
}

/** 套用记忆到某行。相似命中也会套用 —— 是用户从菜单里主动选的，不是自动填。 */
function applyTmToRow(i){
  const p = model.getPara(i);
  const hit = tmHitFor(p);
  if (!hit){ toastError('翻译记忆里没有可用条目。'); return false; }
  model.pushUndo([i]);
  p.translation = p.brackets ? ('「' + hit.dst + '」') : hit.dst;
  p.src = 'tm';    // 归因标记：翻译记忆复用（不计入机翻占比）
  model.recalcDone(p);
  rdr.refreshRow(i);
  model.scheduleAutosave();
  updateProgress();
  markDirty();
  showToast('✅ 已套用翻译记忆：' + tm.suggestLabel(hit.dst, 30));
  return true;
}

/**
 * 段落行右键菜单接入。
 * 全部动作复用既有函数,本函数不实现任何业务逻辑。
 * 译文 textarea 上不接管右键(见 rowmenu.js 顶部设计说明),保留原生粘贴/输入法候选。
 */
/* ---------------- 行级版本快照 / 本地历史（ROADMAP P1-2） ---------------- */

let lastSnapshotAt = 0;   // 当前文档上次留档时间（同一文档 5 分钟内不重复留档）

/**
 * 在"译文即将被大面积改写"之前留一份快照。
 * reason: 'save'（写回原文件前）/ 'batch'（批量机翻前）/ 'force'（强制）
 * 浏览器版拿不到可落盘目录，直接跳过（不假装做了）。
 */
async function snapshotHistory(reason){
  const path = model.getFilePath();
  if (!path || !model.getParas().length) return false;
  if (!history.shouldSnapshot(lastSnapshotAt, Date.now(), reason)) return false;
  const snap = history.buildSnapshot(model.getParas(), Date.now(), reason);
  const { saved } = await history.writeSnapshot(path, model.getFilename(), snap);
  if (saved) lastSnapshotAt = snap.at;
  return saved;
}

const HISTORY_REASON_LABEL = {
  save: '写回原文件前', batch: '批量机翻前', force: '恢复前留档', manual: '手动留档',
};

/** 行菜单「历史版本…」：列快照 → 选一条 → 二次确认后果 → 覆盖式恢复 */
async function openHistoryPicker(){
  const path = model.getFilePath();
  if (!path){ toastError('浏览器版无法保存历史版本（需要能落盘的目录）。'); return; }
  const found = await history.listSnapshots(path, model.getFilename());
  if (!found.length){
    toastError('这篇文档还没有历史版本。写回原文件或批量机翻时会自动留档。');
    return;
  }

  const rows = [];
  for (const it of found){
    const snap = await history.readSnapshot(path, model.getFilename(), it.id);
    if (!snap){
      rows.push({ id: it.id, label: history.snapshotTimeLabel(it.id), detail: '（损坏，无法读取）', broken: true });
      continue;
    }
    const st = history.snapshotStats(snap);
    const d = history.diffSnapshot(snap, model.getParas());
    rows.push({
      id: it.id,
      label: history.snapshotTimeLabel(it.id),
      detail: (HISTORY_REASON_LABEL[snap.reason] || snap.reason || '留档')
        + ' · 当时已译 ' + st.translated + ' 行'
        + (d.changed.length ? ' · 与当前 ' + d.changed.length + ' 行差异' : ' · 与当前一致'),
      broken: false,
    });
  }

  const picked = await showHistoryList({
    title: '历史版本',
    intro: '「' + (model.getFilename() || '当前文档') + '」的本地留档，最多保留最近 '
      + history.HISTORY_MAX + ' 份。恢复以该版本为准覆盖当前译文。',
    items: rows,
  });
  if (!picked) return;
  if (picked.broken){ toastError('这份快照已损坏，无法恢复。'); return; }

  const snap = await history.readSnapshot(path, model.getFilename(), picked.id);
  if (!snap){ toastError('这份快照已损坏，无法恢复。'); return; }
  const d = history.diffSnapshot(snap, model.getParas());
  if (!d.changed.length){ showToast('当前内容与该版本一致，无需恢复。'); return; }

  const go = await showConfirm({
    title: '将把 ' + d.changed.length + ' 行改回 ' + picked.label + ' 的版本',
    message: (d.willClear ? '其中 ' + d.willClear + ' 行会被清空译文（该版本里它们还没有译文）。\n' : '')
      + '恢复后可用 Ctrl+Z 撤销；恢复前的内容也会先自动留一份快照，随时能退回来。',
    confirmText: '恢复',
    cancelText: '取消',
    danger: true,
  });
  if (!go) return;

  await snapshotHistory('force');   // 先给"恢复前"留档，恢复本身也可后悔
  const patch = history.patchFromSnapshot(snap, model.getParas());
  if (!patch.length){ showToast('没有需要改动的行。'); return; }

  model.pushUndo(patch.map(x => x.i));
  for (const x of patch){
    const p = model.getPara(x.i);
    if (!p) continue;
    p.translation = x.translation;
    p.nameTr = x.nameTr;
    model.recalcDone(p);
  }
  rdr.fullRender();
  recomputeMatchesUI(true);
  updateProgress();
  model.scheduleAutosave();
  markDirty();
  showToast('✅ 已恢复到 ' + picked.label + ' 的版本（' + patch.length + ' 行）');
}

function initRowMenu(){
  const list = document.getElementById('list');
  if (!list) return;

  bindRowContextMenu({
    listEl: list,
    getCtx: (i) => {
      const p = model.getPara(i);
       const prov = NO_MT_BUILD ? null : mt.getProvider($mtProvider.value);
      return {
        index: i,
        isName: !!(p && p.isName),
        hasTranslation: !!(p && (p.isName ? p.nameTr : transValue(p))),
        proofMode: proof.isEnabled(),
        canUndo: model.canUndo(),
        mtReady: !!(prov && prov.isConfigured()),
        tmHit: tmHintFor(p),
      };
    },
    handlers: {
      copyOrigToTrans: (i) => {
        const p = model.getPara(i);
        if (!p || p.isName) return;
        // stripBrackets 幂等: 原文带「」时去掉,transInputHandler 会按行类型包回
        transInputHandler(i, stripBrackets(p.content));
        const r = rdr.getRow(i);
        if (r) r.trans.value = transValue(p);
      },
      copyOrig: (i) => {
        const p = model.getPara(i);
        if (!p) return;
        rdr.copyText(p.isName ? p.name : p.content);
      },
      mtRow: (i) => {
        if (NO_MT_BUILD) return;
        rdr.focusIdx(i);          // mtTranslateCurrent 取 currentActiveIdx(),需先聚焦
        mtTranslateCurrent();
      },
      applyTm: (i) => { applyTmToRow(i); },
      history: () => { openHistoryPicker(); },
      clearRow: (i) => {
        transInputHandler(i, '');
        const r = rdr.getRow(i);
        if (r) r.trans.value = '';
      },
      proofApprove: (i) => { const r = rdr.getRow(i); if (r && r.btnApprove) r.btnApprove.click(); },
      proofIssue:   (i) => { const r = rdr.getRow(i); if (r && r.btnIssue)   r.btnIssue.click(); },
      proofNotes:   (i) => { const r = rdr.getRow(i); if (r && r.btnNotes)   r.btnNotes.click(); },
      undo: () => doUndo(),
    },
  });
}

function initSidebarResize(){
  const sb = document.getElementById('sidebar');
  const handle = document.getElementById('sbResize');
  if (!sb || !handle) return;
  let saved = parseInt(localStorage.getItem(SB_W_KEY), 10);
  if (saved >= SB_W_MIN && window.innerWidth > 720){
    setSidebarWidth(sb, saved);
  }
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 900) return;
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault(); // 避免拖动时选中文本
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.round(Math.min(Math.max(window.innerWidth - e.clientX, SB_W_MIN), sidebarMaxWidth()));
    setSidebarWidth(sb, w); // 列表区自动让位,虚拟滚动经 ResizeObserver 重测行宽
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
    document.documentElement.style.setProperty('--context-w', SB_W_DEFAULT + 'px');
    try { localStorage.removeItem(SB_W_KEY); } catch (e) {}
  });
}

function switchSidebarTab(name){
  document.querySelectorAll('.side-tab[data-tab]').forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.getElementById('panel-files').classList.toggle('hidden', name !== 'files');
  document.getElementById('panel-glossary').classList.toggle('hidden', name !== 'glossary');
  const pd = document.getElementById('panel-dict');
  if (pd) pd.classList.toggle('hidden', name !== 'dict');
  const pp = document.getElementById('panel-proof');
  if (pp) pp.classList.toggle('hidden', name !== 'proof');
  if (name === 'proof') renderProofPanel();
}

function closeUtilityPanel(){
  const panel = document.getElementById('utilityPanel');
  const scrim = document.getElementById('utilityScrim');
  const more = document.getElementById('btnCommandPanel');
  if (panel) panel.classList.add('hidden');
  if (scrim){
    scrim.classList.add('hidden');
    scrim.setAttribute('aria-hidden', 'true');
  }
  if (more) more.setAttribute('aria-expanded', 'false');
}

function setWorkspaceMode(name){
  const strip = document.getElementById('commandStrip');
  if (strip) strip.dataset.panel = name;
  document.querySelectorAll('.workspace-nav-item').forEach(b => {
    const active = b.dataset.workspace === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'search') requestAnimationFrame(() => $q.focus());
}

// 兼容现有快捷键调用名: 工作模式现在切换固定的上下文工具栏,不再打开遮罩浮层。
function openUtilityPanel(name){
  closeUtilityPanel();
  setWorkspaceMode(name);
}

function toggleMorePanel(){
  const panel = document.getElementById('utilityPanel');
  const more = document.getElementById('btnCommandPanel');
  if (!panel || !more) return;
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  more.setAttribute('aria-expanded', String(open));
}

function toggleStoryRail(){
  const rail = document.getElementById('storyRail');
  rail.classList.toggle('is-open');
}

function initWorkspaceNavigation(){
  document.getElementById('btnSaveAll').addEventListener('click', saveAllDocs);
  document.getElementById('btnCommandPanel').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMorePanel();
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('utilityPanel');
    const more = document.getElementById('btnCommandPanel');
    if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== more){
      closeUtilityPanel();
    }
  });
  document.getElementById('btnRailNext').addEventListener('click', jumpToNextUntranslated);
  document.getElementById('btnGlossaryPanel').addEventListener('click', () => {
    setSidebar(true);
    switchSidebarTab('glossary');
  });
  document.querySelectorAll('.workspace-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.workspace;
      openUtilityPanel(mode);
      if (mode === 'glossary'){
        setSidebar(true);
        switchSidebarTab('glossary');
      }
    });
  });
}

/* 模态统一管理: 保留各业务自己的取消逻辑,这里只补齐键盘、焦点和背景滚动语义。 */
function initModalA11y(){
  const masks = Array.from(document.querySelectorAll('.modal-mask'));
  const restore = new WeakMap();
  for (const mask of masks){
    const dialog = mask.querySelector('.modal');
    if (!dialog) continue;
    mask.setAttribute('aria-hidden', 'true');
    const focusables = () => Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.offsetParent !== null);
    mask.addEventListener('keydown', (e) => {
      if (!mask.classList.contains('show')) return;
      if (e.key === 'Escape'){
        e.preventDefault();
        const cancel = dialog.querySelector('button[id$="Cancel"]');
        if (cancel) cancel.click();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    });
    const observer = new MutationObserver(() => {
      const open = mask.classList.contains('show');
      mask.setAttribute('aria-hidden', String(!open));
      if (open){
        if (!restore.has(mask) && document.activeElement && !dialog.contains(document.activeElement)) restore.set(mask, document.activeElement);
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
          if (!mask.classList.contains('show')) return;
          const first = focusables()[0];
          if (first && !dialog.contains(document.activeElement)) first.focus();
        });
      } else {
        if (!masks.some(x => x.classList.contains('show'))) document.body.classList.remove('modal-open');
        const previous = restore.get(mask);
        if (previous && previous.isConnected) previous.focus();
        restore.delete(mask);
      }
    });
    observer.observe(mask, { attributes:true, attributeFilter:['class'] });
  }
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
      toastError(e.message);
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
    toastError('无法读取文件夹: ' + e.message);
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
      caret.className = 'caret';           // 形状由 CSS ::before 画，不写字形字符（§7.2）
      const label = document.createElement('span');
      label.className = 'lbl'; label.textContent = en.name;
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
      spacer.className = 'tree-file-dot';       // 12px = caret 宽，保证文本左缘与目录对齐
      spacer.style.width = '12px';
      const label = document.createElement('span');
      label.className = 'fname'; label.textContent = en.name;
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
            await openDoc(f, en.name);
          } else {
            await openDoc({ path: en.path }, en.name);
          }
        } catch (err){ toastError('无法打开文件:' + err.message); }
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
  initModalA11y();
  initWorkspaceNavigation();
  document.getElementById('btnImport').addEventListener('click', importWithPicker);
  document.getElementById('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await openDoc(f, f.name);
    e.target.value = '';
  });
  document.getElementById('btnSaveFile').addEventListener('click', saveDirect);
  document.getElementById('btnSave').addEventListener('click', exportFile);
  document.getElementById('btnRestore').addEventListener('click', restoreProgress);
  document.getElementById('btnClear').addEventListener('click', clearAll);
  document.getElementById('btnClearProgress').addEventListener('click', clearProgress);
  // 主题设置(主题模式 + 背景 + 字体)
  document.getElementById('btnThemeModal').addEventListener('click', openThemeSettings);
  document.getElementById('btnStats').addEventListener('click', openStats);
  // 机翻对比（ROADMAP P2-7）
  document.getElementById('btnMtDiffRefresh').addEventListener('click', async () => {
    await loadMtBaselineForProject(model.getFilePath());
    renderMtDiff();
  });
  document.getElementById('btnMtDiffReset').addEventListener('click', clearMtBaseline);
  document.querySelectorAll('input[name="thMode"]').forEach(r => {
    r.addEventListener('change', () => applyTheme(r.value));
  });
  document.getElementById('foReset').addEventListener('click', resetOrigFont);
  document.getElementById('ftReset').addEventListener('click', resetTransFont);
  // 自定义字体库: 导入文件 / 指定文件夹 / 重新扫描 / 清空 / 逐族移除
  document.getElementById('btnFontImport').addEventListener('click', onFontImportClick);
  document.getElementById('btnFontFolder').addEventListener('click', onFontFolderClick);
  document.getElementById('btnFontRefresh').addEventListener('click', onFontRefreshClick);
  document.getElementById('btnFontClear').addEventListener('click', onFontClearClick);
  document.getElementById('fontFileInput').addEventListener('change', onFontFileInputChange);
  document.getElementById('fontLibList').addEventListener('click', (e) => {
    const btn = e.target.closest('.fl-del');
    if (btn && btn.dataset.family) onFontRemove(btn.dataset.family);
  });
  // 「跟随主题」勾选: 勾上=颜色槽位清空(用主题默认色),取消=恢复为当前主题默认色值供编辑
  for (const p of ['fo', 'ft']){
    document.getElementById(p + 'Follow').addEventListener('change', (e) => {
      const color = document.getElementById(p + 'Color');
      if (e.target.checked){
        color.disabled = true;
        color.value = colorToHex(themeDefaultColor(p));
      } else {
        color.disabled = false;
      }
      previewFontFromUI();
    });
  }
  // 字体/字号/颜色实时预览(输入即生效,保存才落盘);
  // 字体族多一步: 若选中的是已导入字体,先按需注册再预览
  for (const id of ['foFamily', 'ftFamily']){
    document.getElementById(id).addEventListener('input', onFontFamilyInput);
  }
  for (const id of ['foSize', 'foColor', 'ftSize', 'ftColor']){
    document.getElementById(id).addEventListener('input', previewFontFromUI);
  }
  document.getElementById('bgFile').addEventListener('change', onBgFileChange);
  // 阅读密度 / 字节口径: 即时预览,保存外观时才落盘(取消则随 applyAppearance 还原)
  document.getElementById('densitySelect').addEventListener('change', (e) => applyDensity(e.target.value));
  document.getElementById('byteEncSelect').addEventListener('change', (e) => applyByteEncoding(e.target.value));
  document.getElementById('byteLimitInput').addEventListener('input', (e) => {
    updateByteLimitLabel();
    const raw = String(e.target.value || '').trim();
    applyByteLimit(raw ? bytes.normalizeByteLimit(raw) : 0);
  });
  document.getElementById('bgOpacity').addEventListener('input', () => {
    updateBgOpacityLabel();
    const pending = document.getElementById('bgFile').dataset.pending;
    if (pending) previewBg(pending);
  });
  // 文本区透明度: 即时预览(与背景/遮罩一样,「保存外观」才落盘)
  document.getElementById('textAreaOpacity').addEventListener('input', (e) => {
    updateTextAreaOpacityLabel();
    applyTextAreaTransparency(e.target.value);
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
  if (!NO_MT_BUILD){
    $mtProvider.addEventListener('change', () => setMTProvider($mtProvider.value));
    document.getElementById('btnMTSettings').addEventListener('click', openMTSettings);
    document.getElementById('mtProviderSel').addEventListener('change', mtSelChanged);
    document.querySelectorAll('#mtTabs button').forEach(b => b.addEventListener('click', () => mtSwitchTab(b)));
  }
  const themeTabs = Array.from(document.querySelectorAll('#thTabs button'));
  themeTabs.forEach((b, index) => {
    b.addEventListener('click', () => thSwitchTab(b));
    b.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = themeTabs[(index + 1) % themeTabs.length];
      else if (e.key === 'ArrowLeft') next = themeTabs[(index - 1 + themeTabs.length) % themeTabs.length];
      else if (e.key === 'Home') next = themeTabs[0];
      else if (e.key === 'End') next = themeTabs[themeTabs.length - 1];
      if (!next) return;
      e.preventDefault();
      thSwitchTab(next);
      next.focus();
    });
  });
  if (!NO_MT_BUILD){
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
  }

  // 侧边栏
  document.getElementById('btnSidebar').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    setSidebar(sb.classList.contains('hidden'));
  });
  document.getElementById('btnSidebarClose').addEventListener('click', () => setSidebar(false));
  document.querySelectorAll('.side-tab[data-tab]').forEach(b => {
    b.addEventListener('click', () => {
      switchSidebarTab(b.dataset.tab);
      if (b.dataset.tab === 'glossary') setWorkspaceMode('glossary');
    });
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
      document.getElementById('pv-mtdiff').classList.toggle('hidden', v !== 'mtdiff');
      renderProofPanel();
    });
  });
  document.getElementById('btnLogRefresh').addEventListener('click', renderProofPanel);
  document.getElementById('btnExportProofReport').addEventListener('click', async (e) => {
    const button=e.currentTarget; if(button.disabled)return;
    button.disabled=true;
    try {
      // 点击按钮时输入框已失焦结算；导出内容在任何异步保存前固定。
      const report=buildProofReport(model.getParas(),proof.getChanges(),{filename:model.getFilename()});
      if(!report.count){toast('当前脚本还没有批注或保留的改译记录。请先添加批注，或开启校对后修改译文。');return;}
      const result=await saveProofReport(report.markdown,model.getFilename());
      const missing=report.missingBeforeCount?`（${report.missingBeforeCount} 项缺少旧译，已注明）`:'';
      toast(result.downloaded?`已下载 ${report.count} 项校对意见${missing}，可放入 Obsidian 的“校对意见”目录。`:`已导出 ${report.count} 项校对意见${missing}：${result.path}`);
    } catch(err){toastError('导出校对意见失败：'+(err.message||err));}
    finally{button.disabled=false;}
  });

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
        await openDoc(f, f.name);
        return;
      } catch (err){
        toastError('无法读取拖入的文件: ' + err.message);
      }
    }
    toastError('拖拽仅支持本机文件。桌面版也可用「导入文本」选择文件。');
  });

  // 桌面版: 拖拽文件路径由 Rust 窗口事件下发(Webview 拦截了 HTML5 drop)
  if (fsx.isTauri()){
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('galtrans-drag-drop', (ev) => {
        const paths = ev.payload;
        if (!paths || !paths.length) return;
        const p = String(paths[0]);
        if (!/\.(txt|ks|ks\.txt)$/i.test(p)) {
          toastError('仅支持打开 .txt / .ks 文本文件。');
          return;
        }
        openDoc({ path: p }, p.split(/[\\/]/).pop() || p).catch(err => toastError('无法打开拖入的文件: ' + err.message));
      });
    }).catch(() => {});
  }

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    // 校对快捷键录制(弹窗打开时优先拦截)
    if (recordingAction){ recordKeyEvent(e); return; }
    const key = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's'){ e.preventDefault(); saveDirect(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'f'){ e.preventDefault(); openUtilityPanel('search'); $q.select(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'g'){ e.preventDefault(); document.getElementById('jumpInput').focus(); document.getElementById('jumpInput').select(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'z'){ e.preventDefault(); doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && key === 'y'){ e.preventDefault(); doRedo(); return; }
    if (e.key === 'F3'){ e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F2'){ e.preventDefault(); jumpToNextUntranslated(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); replaceCurrent(); return; }
    if (e.key === 'Escape' && !document.querySelector('.modal-mask.show')){
      const panel = document.getElementById('utilityPanel');
      if (!panel.classList.contains('hidden')){ closeUtilityPanel(); return; }
      const rail = document.getElementById('storyRail');
      if (rail.classList.contains('is-open')){ rail.classList.remove('is-open'); return; }
    }
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

/* ---------------- 异常退出检测（ROADMAP P2-8） ---------------- */

// 会话标记：启动时写入，正常退出时封存（补 closedAt）。
// 下次启动若读到"未封存"的标记 → 说明上次没走完退出流程 → 提示恢复。
let sessionMarker = null;
let sessionWriteTimer = null;

/** 让标记跟随当前文档（文件名 / 路径变化时重写；同值不写） */
function touchSession(){
  if (!sessionMarker) return;
  const doc = model.getFilename() || '';
  const path = model.getFilePath() || '';
  if (sessionMarker.doc === doc && sessionMarker.path === path) return;
  sessionMarker.doc = doc;
  sessionMarker.path = path;
  if (sessionWriteTimer) return;
  sessionWriteTimer = setTimeout(async () => {
    sessionWriteTimer = null;
    try { await recovery.writeSession(sessionMarker); } catch (e) { /* 写不进不阻塞业务 */ }
  }, 1000);
}

/** 封存会话（正常退出）。桌面版关窗前 await 调用。 */
async function sealSession(){
  if (!sessionMarker) return;
  sessionWriteTimer = null;
  recordStatsNow();               // 关窗前把当天进度落定
  try { await flushStats(); } catch (e) { /* 忽略 */ }
  try { await recovery.writeSession(recovery.sealMarker(sessionMarker)); } catch (e) { /* 忽略 */ }
}

/** 封存会话（同步分支）——beforeunload 里只能用这个，异步 await 会被卸载打断。 */
function sealSessionSync(){
  if (!sessionMarker) return;
  sessionWriteTimer = null;
  try { recovery.writeSessionSync(recovery.sealMarker(sessionMarker)); } catch (e) { /* 忽略 */ }
}

/**
 * 启动时检测异常退出。有未封存标记时提示：恢复进度 / 从头打开。
 * 恢复 = 用标记里的路径重新打开该文件，再由既有的 openDoc 自动合并进度
 * （不另写一套恢复逻辑，避免与"恢复进度"按钮分叉）。
 * 浏览器版拿不到路径（File System 授权不持久），如实告知而不是假装恢复了。
 */
async function checkRecovery(){
  const sessionId = recovery.newSessionId();
  let prev = null;
  try { prev = await recovery.readSession(); } catch (e) { prev = null; }

  sessionMarker = recovery.makeMarker({
    sessionId,
    startedAt: Date.now(),
    doc: model.getFilename() || '',
    path: model.getFilePath() || '',
  });
  try { await recovery.writeSession(sessionMarker); } catch (e) { /* 忽略 */ }

  if (!recovery.shouldOfferRecovery(prev, sessionId)) return;

  const msg = recovery.recoveryMessage(prev);
  const restore = await showConfirm({ ...msg, danger: false });
  if (!restore) return;

  if (!prev.path){
    toastError('上次会话没有可自动重开的文件路径（浏览器版不保留文件授权）。\n进度仍在本地保存：重新导入该文件后会自动恢复。');
    return;
  }
  try {
    await openDoc({ path: prev.path }, prev.doc || '');
    showToast('✅ 已重新打开「' + (prev.doc || prev.path) + '」并恢复进度');
  } catch (e) {
    toastError('恢复失败：' + (e && e.message ? e.message : e) + '\n可手动导入该文件，进度会自动恢复。');
  }
}

/* ---------------- 关闭前兜底保存 + 未保存退出提示 ---------------- */

// 桌面版: 注册 onCloseRequested,仅当存在未保存文本时才拦截弹窗三选
// (保存并退出 / 直接退出 / 取消);无未保存内容时直接放行,不影响正常关窗。
// ⚠ 依赖 capabilities: core:window:allow-destroy —— v2 的 JS API 在放行关闭时
// 内部会调用 destroy(),缺这条权限会出现「点 ✕ 关不掉窗口」(2026-09 实际踩过)。
function setupCloseFlush(){
  if (fsx.isTauri()){
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.onCloseRequested(async (event) => {
        try {
          if (!anyUnsaved()){
            // 干净退出也要封存会话，否则下次启动会误报"异常退出"。
            // 先 preventDefault → 封存落盘 → 再 destroy，保证顺序（与下面分支同一套写法）。
            event.preventDefault();
            await sealSession();
            try { await win.destroy(); }
            catch (e) { await win.close().catch(() => {}); }
            return;
          }
        } catch (e) { return; }      // 判断异常 → 宁可少提示不可关不掉
        event.preventDefault();      // 有未保存文本 → 先问再关
        const choice = await showExitConfirm();
        try {
          if (choice === 'save'){
            await saveAllDocs();
            await model.flushAutosave().catch(() => {});
            await sealSession();
            await win.destroy();
          } else if (choice === 'discard'){
            await sealSession();
            await win.destroy();
          }
          // choice === 'stay' → 什么都不做,窗口保留（不封存：会话仍在继续）
        } catch (e) {
          // destroy 失败(权限异常等): 清掉脏标记后走 close 兜底,保证窗口能关
          docDirty = false;
          tb.list().forEach(t => { if (t.snap) t.snap.dirty = false; });
          win.close().catch(() => {});
        }
      });
    }).catch(() => { /* API 不可用时退化为无提示关闭(自动保存仍生效) */ });
    return;
  }
  window.addEventListener('beforeunload', (e) => {
    model.flushAutosave().catch(() => {});
    proof.flushSave().catch(() => {});
    sealSessionSync();   // 同步封存，避免下次启动误报异常退出
    if (anyUnsaved()){
      e.preventDefault();
      e.returnValue = ''; // 触发浏览器原生「确定要离开吗?」
    }
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
  await initDictHistory();      // 查词历史（最近 100 条）
  if (NO_MT_BUILD || !fsx.isTauri()) hideMTUI(); // 单文件 HTML 版与 no-mt 版不含本地机翻
  if (!NO_MT_BUILD) await initMT();
  initEvents();
  initSidebarResize(); // 侧边栏拖拽调宽(恢复上次宽度)
  initPalette();       // 命令面板 Ctrl+Shift+P(触发现有按钮,不重写业务)
  initRowMenu();       // 段落行右键菜单(译文框保留原生菜单)
  syncSidebarTop();
  updateUndoButtons();
  setSidebar(true);
  syncEditorialMeta();
  await checkRecovery();  // 上次未正常关闭 → 提示恢复进度（ROADMAP P2-8）
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
