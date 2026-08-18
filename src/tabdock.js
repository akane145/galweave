// tabdock.js — 多文档标签注册表(纯逻辑,无 DOM / 异步,可单测)
// 一个标签 = 一个文件路径(规范化 key)。重复打开同一文件 → 聚焦已有标签。
// 快照字段由调用方(main.js)组装,本模块只负责标签的存在性 / 顺序 / 活动项与快照容器。

let tabs = [];            // [{ key, name, snap }] snap 为调用方存入的文档快照(可 null=未加载)
let curActive = null;     // 活动标签 key(可能为 null=未打开任何文件)

/** 规范化标签 key: 统一分隔符 */
export function docKey(path){
  return String(path || '').replace(/\\/g, '/');
}

/** 打开(或聚焦): 已存在返回既有 key;否则创建并返回新 key */
export function open(path, name){
  const key = docKey(path);
  const existing = tabs.find(t => t.key === key);
  if (existing) return existing.key;
  tabs.push({ key, name: name || basename(path), snap: null });
  return key;
}

function basename(p){
  const s = String(p || '').replace(/\\/g, '/').split('/').pop();
  return s || '未命名';
}

export function has(key){ return tabs.some(t => t.key === key); }

export function list(){ return tabs.slice(); }

export function get(key){ return tabs.find(t => t.key === key) || null; }

export function activeKey(){ return curActive; }

export function setActive(key){
  if (key !== null && !has(key)) return false;
  curActive = key;
  return true;
}

/** 存入/更新某标签的快照;尚未创建的标签自动创建(用于切换前兜底) */
export function capture(key, snap){
  const k = docKey(key);
  let t = tabs.find(x => x.key === k);
  if (!t){ t = { key: k, name: basename(k), snap: null }; tabs.push(t); }
  t.snap = snap;
  return k;
}

export function getSnap(key){ const t = get(key); return t ? t.snap : null; }

export function setName(key, name){
  const t = get(key);
  if (t && name) t.name = name;
}

/** 关闭标签: 返回被关闭项;活动项被关时 activeKey 置 null(由调用方切相邻) */
export function close(key){
  const i = tabs.findIndex(t => t.key === key);
  if (i === -1) return null;
  const [removed] = tabs.splice(i, 1);
  if (curActive === key) curActive = null;
  return removed;
}

/** 在活动项被关闭后,返回应切到的相邻标签 key(优先右邻居,否则左邻居),无则 null */
export function neighborAfterClose(listAfter, wasIndex){
  if (!listAfter.length) return null;
  const idx = Math.min(wasIndex, listAfter.length - 1);
  return listAfter[idx].key;
}
