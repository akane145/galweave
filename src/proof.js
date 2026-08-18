// proof.js — 校对模式(状态管理 / 批注 / 修改记录 / 持久化)
// 对齐 Galweave 校对功能的规格:
//   - 三态: 待校对(pending) / 有问题(issue) / 已通过(approved)
//   - 四类批注: 问题/建议/疑问/备注;新增未解决的「问题/疑问」批注 → 该行自动标「有问题」,
//     全部解决 → 自动回「待校对」
//   - 已通过行再次发生文本变化 → 旧通过状态失效(回到待校对)
//   - 修改记录: 校对模式下记录译文/译名整句改动(编辑/撤销/重做/还原/批量),最新在前,最多 500 条
//   - 持久化: 桌面 <源文件>.proof.json;浏览器 IndexedDB(键 'proof:<文件名>')
// 本模块不直接操作 DOM;行刷新/统计刷新通过 setProofUI 注入的回调完成(便于单元测试)。

import * as model from './model.js';
import * as fsx from './fs.js';
import { transValue } from './parsers.js';

export const STATUS = { PENDING: 'pending', APPROVED: 'approved', ISSUE: 'issue' };
export const ANNO_TYPES = { issue: '问题', suggestion: '建议', question: '疑问', note: '备注' };
export const CHANGE_SOURCES = { edit: '编辑', undo: '撤销', redo: '重做', restore: '还原', batch: '批量' };

const CHANGE_LIMIT = 500;
const SETTLE_MS = 1200;      // 整句结算延迟(与 Galweave 一致)
const SAVE_DEBOUNCE = 400;   // 校对数据脏写防抖

/* ---------------- UI 回调(main.js 注入;测试可不注入) ---------------- */

const ui = { refreshRow: null, refreshAll: null, refreshUI: null };
export function setProofUI(h){ Object.assign(ui, h); }
function touch(i){
  if (ui.refreshRow) ui.refreshRow(i);
  if (ui.refreshUI) ui.refreshUI();
  scheduleSave();
}

/* ---------------- 状态 ---------------- */

let enabled = false;        // 校对模式开关
let filter = 'all';         // 行过滤: all | pending | issue | approved
let viewTab = 'anno';       // 侧栏校对面板: anno | log
let changes = [];           // 修改记录(最新在前)
let proofPath = null;       // 桌面: <源文件>.proof.json 完整路径
let proofKey = '';          // 浏览器: 存储键
let activeForFile = false;  // 当前文件是否可写校对数据
let saveTimer = null;
let saveChain = Promise.resolve();
let settleMap = new Map();  // 行编辑结算计时器
export let proofKeys = { approve: 'q', issue: 'w', annotate: 'a', nextIssue: '', toggleMode: '' };

export function defaultKeys(){ return { approve: 'q', issue: 'w', annotate: 'a', nextIssue: '', toggleMode: '' }; }
export function isEnabled(){ return enabled; }
export function setEnabled(v){
  enabled = !!v;
  if (!enabled) clearSettleTimers();
}
export function getFilter(){ return filter; }
export function setFilter(v){ filter = v; }
export function getViewTab(){ return viewTab; }
export function setViewTab(v){ viewTab = v; }
export function getChanges(){ return changes; }
export function setKeys(k){ proofKeys = Object.assign(defaultKeys(), k || {}); }

/* ---------------- 每行校对数据访问 ---------------- */

function prOf(i){
  const p = model.getPara(i);
  if (!p) return null;
  if (!p.pr) p.pr = { status: STATUS.PENDING, annotations: [] };
  return p.pr;
}
export function statusOf(i){
  const pr = prOf(i);
  return pr ? pr.status : STATUS.PENDING;
}
export function annotationsOf(i){
  const pr = prOf(i);
  return pr ? pr.annotations : [];
}
export function unresolvedCount(i){
  return annotationsOf(i).filter(a => !a.resolved).length;
}

/* ---------------- 状态切换 / 批注 ---------------- */

export function toggleApprove(i){
  const pr = prOf(i);
  if (!pr) return;
  pr.status = pr.status === STATUS.APPROVED ? STATUS.PENDING : STATUS.APPROVED;
  touch(i);
}

export function toggleIssue(i){
  const pr = prOf(i);
  if (!pr) return;
  pr.status = pr.status === STATUS.ISSUE ? STATUS.PENDING : STATUS.ISSUE;
  touch(i);
}

export function addAnnotation(i, type, text){
  const pr = prOf(i);
  if (!pr || !text || !text.trim()) return null;
  const anno = {
    id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    type, text: text.trim(), created: Date.now(),
    resolved: false, resolvedAt: null,
  };
  pr.annotations.push(anno);
  // 新增未解决的「问题/疑问」批注 → 自动标「有问题」
  if ((type === 'issue' || type === 'question') && pr.status !== STATUS.ISSUE) pr.status = STATUS.ISSUE;
  touch(i);
  return anno;
}

export function resolveAnnotation(i, id){
  const pr = prOf(i);
  if (!pr) return;
  const a = pr.annotations.find(x => x.id === id);
  if (!a || a.resolved) return;
  a.resolved = true;
  a.resolvedAt = Date.now();
  demoteIssueIfClean(i);
  touch(i);
}

export function deleteAnnotation(i, id){
  const pr = prOf(i);
  if (!pr) return;
  const k = pr.annotations.findIndex(x => x.id === id);
  if (k === -1) return;
  pr.annotations.splice(k, 1);
  demoteIssueIfClean(i);
  touch(i);
}

// 未解决的「问题/疑问」批注清空后 → 回「待校对」
export function demoteIssueIfClean(i){
  const pr = prOf(i);
  if (!pr || pr.status !== STATUS.ISSUE) return;
  if (pr.annotations.some(a => !a.resolved && (a.type === 'issue' || a.type === 'question'))) return;
  pr.status = STATUS.PENDING;
}

// 已通过行发生文本变化 → 旧通过状态失效;返回是否降级
export function demoteApproved(i){
  const pr = prOf(i);
  if (!pr || pr.status !== STATUS.APPROVED) return false;
  pr.status = STATUS.PENDING;
  touch(i);
  return true;
}

/* ---------------- 修改记录 ---------------- */

// 输入时调用: 记下整句改动前状态,1200ms 无输入后结算
export function noteInput(i){
  if (!enabled) return;
  const p = model.getPara(i);
  if (!p) return;
  let s = settleMap.get(i);
  if (!s){
    s = { beforeT: p.translation, beforeN: p.nameTr, timer: null };
    settleMap.set(i, s);
  }
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => settleInput(i), SETTLE_MS);
}

// 整句结算: 译文/译名任一变化 → 记录一条修改记录
export function settleInput(i){
  const s = settleMap.get(i);
  if (!s) return;
  settleMap.delete(i);
  if (s.timer) clearTimeout(s.timer);
  const p = model.getPara(i);
  if (!p) return;
  if (s.beforeT === p.translation){
    if (s.beforeN !== p.nameTr) recordChange(i, 'nameTr', s.beforeN, p.nameTr, 'edit');
  } else {
    recordChange(i, 'translation', s.beforeT, p.translation, 'edit');
  }
}

export function clearSettleTimers(){
  for (const s of settleMap.values()) if (s.timer) clearTimeout(s.timer);
  settleMap.clear();
}

export function recordChange(i, field, before, after, source){
  if (!enabled || before === after) return false;
  const p = model.getPara(i);
  if (!p) return false;
  changes.unshift({
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    paraId: p.orig, line: i + 1, field, before, after, at: Date.now(), source,
  });
  if (changes.length > CHANGE_LIMIT) changes.length = CHANGE_LIMIT;
  scheduleSave();
  return true;
}

// 批量操作(替换/术语应用/撤销/重做/还原)前调用: 快照 {orig: {t, n}}
export function snapshot(){
  const m = new Map();
  for (const p of model.getParas()) m.set(p.orig, { t: p.translation, n: p.nameTr });
  return m;
}

// 批量操作后调用: 对比快照,逐行记录变化并让「已通过」失效
export function recordDiff(snap, source){
  if (!enabled || !snap) return;
  model.getParas().forEach((p, i) => {
    const s = snap.get(p.orig);
    if (!s) return;
    if (s.t === p.translation){
      if (s.n !== p.nameTr){
        recordChange(i, 'nameTr', s.n, p.nameTr, source);
        demoteApproved(i);
      }
    } else {
      recordChange(i, 'translation', s.t, p.translation, source);
      demoteApproved(i);
    }
  });
}

// 修改记录 → 还原该行到修改前;返回 { idx } 或 null / { missing: true }
export function restoreChange(id){
  const c = changes.find(x => x.id === id);
  if (!c) return null;
  const idx = model.getParas().findIndex(p => p.orig === c.paraId);
  if (idx === -1) return { missing: true };
  const p = model.getPara(idx);
  const current = c.field === 'translation' ? p.translation : p.nameTr;
  model.pushUndo([idx]);
  if (c.field === 'translation') p.translation = c.before;
  else p.nameTr = c.before;
  model.recalcDone(p);
  recordChange(idx, c.field, current, c.before, 'restore');
  demoteApproved(idx);
  if (ui.refreshRow) ui.refreshRow(idx);
  if (ui.refreshUI) ui.refreshUI();
  return { idx };
}

/* ---------------- 统计 / 行过滤 ---------------- */

export function stats(){
  let total = 0, pending = 0, approved = 0, issue = 0;
  for (const p of model.getParas()){
    total++;
    const st = p.pr ? p.pr.status : STATUS.PENDING;
    if (st === STATUS.APPROVED) approved++;
    else if (st === STATUS.ISSUE) issue++;
    else pending++;
  }
  return { total, pending, approved, issue };
}

export function rowPassesFilter(i){
  if (!enabled || filter === 'all') return true;
  return statusOf(i) === filter;
}

/* ---------------- 漏翻 / 异常分析(运行时派生,不入库) ---------------- */

// 译文/原文长度比阈值: 日译中通常 0.3~3.5,越界视为可疑(可能漏译/过度扩写)
export const RATIO_MIN = 0.3, RATIO_MAX = 3.5;

/**
 * 分析单行是否漏翻/异常。NAME 行与正常行返回 null。
 * 返回 { kind:'missing'|'placeholder'|'ratio', ratio? } 或 null。
 *   missing     — 译文为空
 *   placeholder — 译文照抄原文(占位未译)
 *   ratio       — 译文/原文长度比越界(可疑)
 */
export function analyzeRow(p){
  if (!p || p.isName) return null;
  const orig = p.content || '';
  const tv = transValue(p);
  if (!tv.trim()) return { kind: 'missing' };
  if (p.translation === p.content) return { kind: 'placeholder' };
  const r = tv.length / (orig.length || 1);
  if (r < RATIO_MIN || r > RATIO_MAX) return { kind: 'ratio', ratio: +r.toFixed(2) };
  return null;
}

const preview = (s, n) => { const x = String(s || ''); return x.length > n ? x.slice(0, n) + '…' : x; };

/** 全量漏翻/异常分析 → { missing, placeholder, ratio, total }，每项含 i/origPreview/transPreview */
export function analyzeRows(paras){
  const out = { missing: [], placeholder: [], ratio: [] };
  const list = paras || model.getParas();
  list.forEach((p, i) => {
    const a = analyzeRow(p);
    if (!a) return;
    out[a.kind].push({
      i, kind: a.kind,
      origPreview: preview(p.content, 40),
      transPreview: preview(transValue(p), 40),
      ...(a.ratio !== undefined ? { ratio: a.ratio } : {}),
    });
  });
  return { ...out, total: out.missing.length + out.placeholder.length + out.ratio.length };
}

/* ---------------- 持久化 ---------------- */

// 收集可持久化的校对数据(proof.json 内容): 批注按 orig 索引 + 修改记录
export function collect(){
  const annotations = {};
  for (const p of model.getParas()){
    if (p.pr && (p.pr.status !== STATUS.PENDING || (p.pr.annotations && p.pr.annotations.length))){
      annotations[p.orig] = p.pr;
    }
  }
  return { version: 1, annotations, changes };
}

function applyData(data){
  if (!data) return;
  if (Array.isArray(data.changes)) changes = data.changes;
  if (data.annotations){
    for (const [orig, pr] of Object.entries(data.annotations)){
      const p = model.getParas().find(x => x.orig === orig);
      if (p) p.pr = pr;
    }
  }
}

// 新文件加载时调用: 清空旧状态并读取该文件的校对数据
export async function loadForFile(){
  resetState();
  if (!model.getParas().length) return;

  const path = model.getFilePath();
  const name = model.getFilename();
  let ok = false;
  if (path){
    // 新位置: <源目录>/.galweave/<文件名>.proof.json;旧位置(同目录 <源文件>.proof.json)回退+迁移
    proofPath = galweaveProofPath(path);
    const legacy = path + '.proof.json';
    const raw = await safeRead(proofPath);
    if (raw){ applyData(JSON.parse(raw)); ok = true; }
    else {
      const legacyRaw = await safeRead(legacy);
      if (legacyRaw){
        applyData(JSON.parse(legacyRaw));
        ok = true;
        await migrateLegacyProof(proofPath, legacy); // 搬到新位置后清理旧文件
      }
    }
  }
  if (!ok && name){
    // 浏览器存储键: 用 getStateKey(规范化文档会带 .canonical 后缀,与原文件分开)
    proofKey = 'proof:' + model.getStateKey();
    try {
      const data = await fsx.proofState(model.getStateKey());
      if (data){ applyData(data); ok = true; }
    } catch (e){ /* 忽略 */ }
  }
  activeForFile = !!(path || name);
  if (ui.refreshAll) ui.refreshAll();
  if (ui.refreshUI) ui.refreshUI();
}

/** <源目录>/.galweave/<文件名>.proof.json(纯字符串切分,与 fs.js 的 dirOf/basenameOf 同规则) */
function galweaveProofPath(filePath){
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = i > 0 ? filePath.slice(0, i) : '';
  const base = i >= 0 ? filePath.slice(i + 1) : filePath;
  return dir + '/.galweave/' + base + '.proof.json';
}

async function safeRead(p){
  try {
    const raw = await fsx.readTextFileSource(p);
    return raw || null;
  } catch (e){ return null; }
}

async function migrateLegacyProof(newPath, legacyPath){
  try {
    // 把旧文件内容写到新位置
    const raw = await safeRead(legacyPath);
    if (raw) await fsx.writeTextFileSource(newPath, raw);
  } catch (e){ /* 迁移失败不阻塞 */ }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('remove_file', { path: legacyPath });
  } catch (e){ /* 旧文件删不掉不阻塞 */ }
}

// 清空模块状态(新文档加载 / 测试用;保留校对模式开关)
export function resetState(){
  clearSettleTimers();
  if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  changes = [];
  proofPath = null;
  proofKey = '';
  activeForFile = false;
}

/* ---------------- 状态快照/恢复(多标签页) ---------------- */

/** 捕获校对内存状态(changes/proof 句柄)。行级 p.pr 已随 paras 快照携带。 */
export function snapshotState(){
  return { changes, proofPath, proofKey, activeForFile };
}

/** 恢复校对状态(切换标签时;不清 enabled/filter/viewTab 等全局偏好)。 */
export function restoreState(s){
  clearSettleTimers();
  if (!s) return;
  changes = Array.isArray(s.changes) ? s.changes : [];
  proofPath = s.proofPath || null;
  proofKey = s.proofKey || '';
  activeForFile = !!s.activeForFile;
}

// 脏写控制: 数据变化后防抖保存;保存串行化避免竞态覆盖
export function scheduleSave(){
  if (!activeForFile) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, SAVE_DEBOUNCE);
}

export function flushSave(){
  if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  if (!activeForFile) return Promise.resolve();
  const data = collect();
  const path = proofPath;
  const key = proofKey;
  saveChain = saveChain.then(async () => {
    try {
      if (path) await fsx.writeTextFileSource(path, JSON.stringify(data, null, 2));
      else if (key) await fsx.saveProofState(model.getStateKey(), data);
    } catch (e){ /* 写失败不阻塞 */ }
  });
  return saveChain;
}

// 「清除进度」时调用: 删除校对数据(批注/状态/修改记录)
export async function clearForFile(){
  clearSettleTimers();
  if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  changes = [];
  for (const p of model.getParas()) delete p.pr;
  const path = proofPath;
  const key = proofKey;
  proofPath = null;
  proofKey = '';
  activeForFile = false;
  try {
    if (path) await fsx.writeTextFileSource(path, JSON.stringify({ version: 1, annotations: {}, changes: [] }, null, 2));
    else if (key) await fsx.removeProofState(model.getStateKey());
  } catch (e){ /* 忽略 */ }
  if (ui.refreshAll) ui.refreshAll();
  if (ui.refreshUI) ui.refreshUI();
}
