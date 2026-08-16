// model.js — 数据模型 / 撤销重做 / 自动保存
// paras 是全部模块共享的数据;所有写操作只碰 translation / nameTr,原文 orig 永不修改。

import { transValue } from './parsers.js';
import { saveState } from './fs.js';

const UNDO_LIMIT = 100;

let paras = [];
let filename = '';
let filePath = null;   // Tauri 端当前文件绝对路径
let nl = '\n';         // 文件换行风格
let trailingBlank = false; // 原文件是否以空行结尾
let rawText = '';      // 当前文件的原始文本(格式识别/还原用)
let canonicalDoc = false; // 「规范化并载入」生成的文档:显示名保留原名,存储键加标记避免与原文件进度混淆

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
export function getStateKey(){ return (filePath || filename) + (canonicalDoc ? '.canonical' : ''); }

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
}

// 当前文件的原始文本(导入时保存;「规范化并载入」后为规范化文本)。格式识别/还原 GUI 使用。
export function setRawText(t){ rawText = t || ''; }
export function getRawText(){ return rawText; }

/** 计算段落的“是否已翻译”状态并写回 p.done */
export function recalcDone(p){
  if (p.isName){
    // NAME 行: 名字框有内容(原文名/译名)即已翻译,自动确认;清空名字框才回到未翻译
    p.done = (p.nameTr || '').trim() !== '';
  } else {
    p.done = transValue(p).trim() !== '';
  }
  return p.done;
}

/* ---------------- 撤销 / 重做(增量快照) ---------------- */

// 变更前调用: 记录这些行当前的状态,便于撤销
export function pushUndo(list){
  if (!list || !list.length) return;
  const snapshot = list.map(i => ({
    i,
    translation: paras[i] ? paras[i].translation : '',
    nameTr: paras[i] ? paras[i].nameTr : ''
  }));
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function applyDeltas(deltas){
  for (const d of deltas){
    const p = paras[d.i];
    if (!p) continue;
    p.translation = d.translation;
    p.nameTr = d.nameTr;
    recalcDone(p);
  }
}

export function undo(){
  const d = undoStack.pop();
  if (!d) return false;
  redoStack.push(d.map(x => ({ i: x.i, translation: paras[x.i] ? paras[x.i].translation : '', nameTr: paras[x.i] ? paras[x.i].nameTr : '' })));
  applyDeltas(d);
  return true;
}

export function redo(){
  const d = redoStack.pop();
  if (!d) return false;
  undoStack.push(d.map(x => ({ i: x.i, translation: paras[x.i] ? paras[x.i].translation : '', nameTr: paras[x.i] ? paras[x.i].nameTr : '' })));
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
