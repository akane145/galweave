// recovery.js — 异常退出检测（纯判定 + 极薄的持久化）
//
// 原理：启动时写一份「会话标记」，正常退出时在标记上补 `closedAt`（封存）。
// 下次启动读到**没有 closedAt 的标记** = 上次没走完退出流程 = 异常退出，提示恢复。
//
// 为什么用"补字段"而不是"删文件"：Tauri 侧没有删除软件目录文件的接口（fs.js 只有读/写），
// 而补字段只需要一次写。副作用是标记文件会一直存在，这是有意的——它同时兼作"上次会话摘要"。
//
// ⚠️ 桌面版在 `onCloseRequested` 里 **先 preventDefault、封存、再 destroy**，
//    这样封存一定落盘后才关窗（与既有"保存并退出"路径同一套写法）。
//    浏览器版走 `beforeunload` 的**同步**分支（localStorage 同步写），异步 await 会被卸载打断。
//
// 判定与文案等纯逻辑无 DOM / 无 IO 依赖，配 node --test。

import { isTauri } from './fs.js';

export const SESSION_FILE = 'galweave-session.json';
const LEGACY_SESSION_FILE = 'galtrans-session.json';
const LS_KEY = 'galtrans_session_v1';

/* ---------------- 纯判定 ---------------- */

/** 构造会话标记 */
export function makeMarker({ sessionId, startedAt, doc, path } = {}){
  return {
    v: 1,
    sessionId: String(sessionId || ''),
    startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now(),
    doc: String(doc || ''),
    path: String(path || ''),
  };
}

/**
 * 解析标记。损坏 / 结构不符 / v 不匹配 → null（当作"没有标记"，即干净启动）。
 * 宁可漏报也不要在启动时弹一个看不懂的框。
 */
export function parseMarker(raw){
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string'){
    const s = raw.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (Number(obj.v) !== 1) return null;
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) return null;
  const out = makeMarker({ sessionId: obj.sessionId, startedAt: obj.startedAt, doc: obj.doc, path: obj.path });
  if (obj.closedAt !== undefined){
    const c = Number(obj.closedAt);
    if (!Number.isFinite(c)) return null;      // closedAt 存在但非法 → 数据可疑，判为无标记
    out.closedAt = c;
  }
  return out;
}

/** 封存标记（补 closedAt），表示本次会话正常结束 */
export function sealMarker(marker, at){
  if (!marker) return null;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  return { ...marker, closedAt: t };
}

/**
 * 是否需要提示恢复。
 * @param {object|null} marker 上次会话标记（parseMarker 的产物或 null）
 * @param {string} sessionId 本次会话 id
 * @returns {boolean}
 */
export function shouldOfferRecovery(marker, sessionId){
  if (!marker) return false;
  if (marker.closedAt) return false;                       // 正常退出过
  if (String(sessionId) === marker.sessionId) return false; // 同一次会话（不应发生，防御）
  return true;
}

function fmtTime(ts){
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '未知时间';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 恢复提示文案。标题必须写出具体后果（规范 §8.5 L3），所以带上文件名与中断时间。
 * @returns {{title:string, message:string, confirmText:string, cancelText:string}}
 */
export function recoveryMessage(marker){
  const doc = (marker && marker.doc) || '';
  const at = fmtTime(marker && marker.startedAt);
  return {
    title: '检测到上次异常退出',
    message: '上次会话开始于 ' + at + (doc ? '，正在编辑「' + doc + '」' : '')
      + '，但没有走完退出流程（崩溃或被强制结束）。\n\n'
      + '「恢复进度」会用自动保存的内容重建当前文档的翻译进度；'
      + '「从头打开」则忽略它，按正常流程重新导入文件。',
    confirmText: '恢复进度',
    cancelText: '从头打开',
  };
}

/* ---------------- 持久化 ---------------- */

/** 同步读（浏览器 / localStorage） */
export function readSessionSync(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? parseMarker(raw) : null;
  } catch (e) { return null; }
}

/** 同步写（浏览器 / localStorage）—— beforeunload 里只能用这个 */
export function writeSessionSync(marker){
  try {
    if (marker) localStorage.setItem(LS_KEY, JSON.stringify(marker));
    else localStorage.removeItem(LS_KEY);
    return true;
  } catch (e) { return false; }
}

/** 异步读：桌面版读软件目录，浏览器回退 localStorage */
export async function readSession(){
  if (isTauri()){
    try {
      const { readAppFile } = await import('./fs.js');
       for (const file of [SESSION_FILE, LEGACY_SESSION_FILE]){
         const raw = await readAppFile(file);
         if (raw !== null && raw !== undefined){
           const m = parseMarker(raw);
           if (m) return m;
         }
       }
    } catch (e) { /* 读取失败 → 当作没有标记 */ }
  }
  return readSessionSync();
}

/** 异步写：桌面版写软件目录（失败回退 localStorage），浏览器写 localStorage */
export async function writeSession(marker){
  if (isTauri()){
    try {
      const { writeAppFile } = await import('./fs.js');
      await writeAppFile(SESSION_FILE, JSON.stringify(marker, null, 2));
      return true;
    } catch (e) { /* 回退 localStorage */ }
  }
  return writeSessionSync(marker);
}

/** 生成会话 id（时间戳 + 随机，够用且不需 crypto） */
export function newSessionId(){
  return 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
