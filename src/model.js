// model.js — 数据模型 / 撤销重做 / 自动保存
// paras 是全部模块共享的数据;所有写操作只碰 translation / nameTr,原文 orig 永不修改。

import { computeDone } from './parsers.js';
import { saveState } from './fs.js';

const UNDO_LIMIT = 100;

let paras = [];
let filename = '';
let filePath = null;   // Tauri 端当前文件绝对路径
let nl = '\n';         // 文件换行风格
let trailingBlank = false; // 原文件是否以空行结尾
let rawText = '';      // 当前文件的原始文本(格式识别/还原用)
let canonicalDoc = false; // 「规范化并载入」生成的文档:显示名保留原名,存储键加标记避免与原文件进度混淆
// 读入时的编码。**保存默认沿用它** —— 否则 Shift-JIS 的脚本存回去变 UTF-8，
// 引擎读出来就是乱码，而用户以为保存成功了（v5.10 修）。
let sourceEncoding = '';
let recordKey = ''; // 记录包的本机独立存储键；不冒充真实文件路径。
export function setRecordKey(key){ recordKey = key || ''; }

let undoStack = [];    // 每项: [{ i, translation, nameTr }] 增量快照(变更前状态)
let redoStack = [];
let saveTimer = null;

export function getParas(){ return paras; }
export function getPara(i){ return paras[i]; }
export function getFilename(){ return filename; }
export function getFilePath(){ return filePath; }
export function getNl(){ return nl; }
export function getTrailingBlank(){ return trailingBlank; }

// 进度存储键: 桌面端用完整路径,避免不同目录下同名文件互相覆盖缓存;
// 浏览器端拿不到路径,退回文件名(与旧版一致)。
// 规范化文档加 .canonical 后缀,与同名原文件分开存。
export function getStateKey(){ return recordKey || (filePath || filename) + (canonicalDoc ? '.canonical' : ''); }

export function setCanonicalDoc(v){ canonicalDoc = !!v; }
export function isCanonicalDoc(){ return canonicalDoc; }

export function setParas(arr){
  paras = arr;
  undoStack = [];
  redoStack = [];
}

export function setFileInfo(info){
  filename = info.name || '';
  filePath = info.path || null;
  if (info.nl !== undefined) nl = info.nl;
  if (info.trailingBlank !== undefined) trailingBlank = !!info.trailingBlank;
  if (info.encoding !== undefined) sourceEncoding = info.encoding || '';
}

/**
 * 读入时的编码（保存默认沿用它）。
 * 空串 = 未知（新文件/浏览器端未检测），调用方回退 UTF-8。
 */
export function getSourceEncoding(){ return sourceEncoding; }

// 当前文件的原始文本(导入时保存;「规范化并载入」后为规范化文本)。格式识别/还原 GUI 使用。
export function setRawText(t){ rawText = t || ''; }
export function getRawText(){ return rawText; }

/** 计算段落的“是否已翻译”状态并写回 p.done
    口径与 parsers.computeDone 完全同源(镜像格式的预填原文占位算未翻译)。 */
export function recalcDone(p){
  p.done = computeDone(p);
  return p.done;
}

/* ---------------- 撤销 / 重做(增量快照) ---------------- */

/**
 * 一行的可撤销状态。
 *
 * `src`（译文来源归因 'mt'/'human'/'tm'/''）必须和文本一起进出撤销栈：
 * 只恢复文本会让"撤销一次批量替换/手工改写"在归因上仍留下 human，
 * 保存时收割进翻译记忆就成了 confirmed，未复核的机翻会被当作定论自动扩散（R3）。
 */
function rowSnapshot(i){
  const p = paras[i];
  return {
    i,
    translation: p ? p.translation : '',
    nameTr: p ? p.nameTr : '',
    src: p ? String(p.src || '') : '',
  };
}

// 变更前调用: 记录这些行当前的状态,便于撤销
export function pushUndo(list){
  if (!list || !list.length) return;
  undoStack.push(list.map(rowSnapshot));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function applyDeltas(deltas){
  for (const d of deltas){
    const p = paras[d.i];
    if (!p) continue;
    p.translation = d.translation;
    p.nameTr = d.nameTr;
    // 老形状的快照（无 src 字段）不动归因，避免把来源清空
    if (typeof d.src === 'string') p.src = d.src;
    recalcDone(p);
  }
}

export function undo(){
  const d = undoStack.pop();
  if (!d) return false;
  redoStack.push(d.map(x => rowSnapshot(x.i)));
  applyDeltas(d);
  return true;
}

export function redo(){
  const d = redoStack.pop();
  if (!d) return false;
  undoStack.push(d.map(x => rowSnapshot(x.i)));
  applyDeltas(d);
  return true;
}

export function canUndo(){ return undoStack.length > 0; }
export function canRedo(){ return redoStack.length > 0; }

/* ---------------- 自动保存(500ms 防抖,异步写 IndexedDB) ---------------- */

export function scheduleAutosave(){
  if (!getStateKey()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doAutosave, 500);
}

async function doAutosave(){
  saveTimer = null;
  const key = getStateKey();
  if (!key) return;
  await saveState(key, paras);
}

/** 立即保存(保存原文件前调用,确保进度同步) */
export function flushAutosave(){
  if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  const key = getStateKey();
  if (key) return saveState(key, paras);
  return Promise.resolve();
}

/* ---------------- 文档快照/恢复(多标签页) ---------------- */

/** 捕获当前文档全部内存状态(含 undo/redo 栈)。paras 用引用(非活动标签冻结,无并发修改)。 */
export function snapshotState(){
  return {
    paras, filename, filePath, nl, trailingBlank, rawText, canonicalDoc, sourceEncoding, recordKey,
    undoStack: undoStack.slice(),
    redoStack: redoStack.slice(),
  };
}

/** 恢复文档状态。不走 setParas(不清空 undo/redo)。 */
export function restoreState(s){
  if (!s) return;
  paras = Array.isArray(s.paras) ? s.paras : [];
  filename = s.filename || '';
  filePath = s.filePath || null;
  if (typeof s.nl === 'string') nl = s.nl;
  if (typeof s.trailingBlank === 'boolean') trailingBlank = s.trailingBlank;
  rawText = typeof s.rawText === 'string' ? s.rawText : '';
  canonicalDoc = !!s.canonicalDoc;
  sourceEncoding = typeof s.sourceEncoding === 'string' ? s.sourceEncoding : '';
  recordKey = typeof s.recordKey === 'string' ? s.recordKey : '';
  undoStack = Array.isArray(s.undoStack) ? s.undoStack : [];
  redoStack = Array.isArray(s.redoStack) ? s.redoStack : [];
}

