// history.js — 行级版本快照 / 本地历史（纯逻辑 + 薄 IO）
//
// 动机（docs/ROADMAP.md P1-2）：持久化只有单槽 `saveState` + 内存 undo（UNDO_LIMIT=100，
// 关掉就没了）。"想回到昨天翻的那版"目前不可行；批量机翻 / 术语表批量替换这类
// **一次性改很多行**的操作更是没有后悔药。
//
// 做法：在"译文稳定下来"的时点（写回原文件、批量机翻前）把整篇译文存一份快照，
// 滚动保留最近 HISTORY_MAX 份，放在 `<源目录>/.galweave/history/<文件名>/<id>.json`。
//
// 存储取舍：
//   - 快照只存 **有译文的行**（+改过的译名）。空行不存 —— 全篇空行占大头，存了纯浪费，
//     而"当时是空"可以由"不在快照里"无歧义地表达（同一文件、按 orig 匹配）。
//   - 行数据用数组 [orig, translation, nameTr] 而不是对象：同结构下体积约省 1/3。
//   - 没有索引文件：列表由目录 enumerator 得出，避免每次写索引都产生一个 .bak。
//
// ⚠️ 恢复是**整篇覆盖式补丁**：快照里没有的行会被清空翻译。所以恢复前必须
//    在 UI 上写清"将把 N 行改回该版本"，且默认焦点在取消（规范 §8.5 L3）。

import { transValue } from './parsers.js';

export const HISTORY_VERSION = 1;
/** 每篇文档保留的快照份数上限 */
export const HISTORY_MAX = 20;
/** 同一文档两次快照的最小间隔，避免连续保存刷出一堆几乎相同的版本 */
export const HISTORY_MIN_INTERVAL_MS = 5 * 60 * 1000;

/* ---------------- 命名 ---------------- */

/** 快照 id：把 ISO 时间压成可排序的文件名安全串（20260910-213005） */
export function snapshotId(at){
  const d = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 快照 id → 可读时间（回显用） */
export function snapshotTimeLabel(id){
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(id || ''));
  if (!m) return String(id || '');
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
}

/** 文档名 → 历史子目录名（去掉路径分隔与非法字符，避免建出怪目录） */
export function snapshotDirName(docName){
  return String(docName == null ? '' : docName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

/** 相对 `.galweave/` 的快照文件路径 */
export function snapshotRelPath(docName, id){
  return 'history/' + snapshotDirName(docName) + '/' + id + '.json';
}

/* ---------------- 构造 / 解析 ---------------- */

/**
 * 构造快照。只收"有内容"的行：译文非空 或 译名与原名不同。
 * @returns {{version:number, at:number, reason:string, total:number, rows:Array}}
 *          rows 项为 [orig, translation, nameTr]
 */
export function buildSnapshot(paras, at, reason){
  const list = Array.isArray(paras) ? paras : [];
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const rows = [];
  for (const p of list){
    if (!p) continue;
    const orig = String(p.orig == null ? '' : p.orig);
    if (!orig) continue;
    const isName = !!p.isName;
    const tr = isName ? '' : String(transValue(p) || '');
    const nameTr = String(p.nameTr == null ? '' : p.nameTr);
    // 名字只在"确实改过"时才记。对照基准取说话人名，NAME 行没有独立 name 时退回 orig ——
    // 直接和 p.name 比会在 name 缺失的行上把"未改"误判成"改过"（单测钉住过这个坑）。
    const srcName = String(p.name || p.orig || '');
    const keepName = !!nameTr && nameTr !== srcName;
    if (!tr.trim() && !keepName) continue;
    rows.push([orig, tr, keepName ? nameTr : '']);
  }
  return {
    version: HISTORY_VERSION,
    at: t,
    reason: String(reason || 'manual'),
    total: list.length,
    rows,
  };
}

/** 解析快照文件；损坏/结构不符返回 null（一个坏文件不该让整份列表打不开） */
export function parseSnapshot(raw){
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string'){
    const s = raw.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (Number(obj.version) !== HISTORY_VERSION) return null;
  if (!Array.isArray(obj.rows)) return null;
  const rows = [];
  for (const r of obj.rows){
    if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
    rows.push([r[0], typeof r[1] === 'string' ? r[1] : '', typeof r[2] === 'string' ? r[2] : '']);
  }
  return {
    version: HISTORY_VERSION,
    at: Number.isFinite(Number(obj.at)) ? Number(obj.at) : 0,
    reason: String(obj.reason || ''),
    total: Number.isFinite(Number(obj.total)) ? Number(obj.total) : rows.length,
    rows,
  };
}

/** 摘要：供列表显示 */
export function snapshotStats(snapshot){
  const rows = (snapshot && Array.isArray(snapshot.rows)) ? snapshot.rows : [];
  let translated = 0, names = 0;
  for (const r of rows){
    if (r[2]) names++;
    if (String(r[1] || '').trim()) translated++;
  }
  return { total: (snapshot && snapshot.total) || 0, translated, names, stored: rows.length };
}

/* ---------------- 比较 / 裁剪 ---------------- */

// 按 orig 分组并保持出现顺序：同一 orig 的多行要靠"第几次出现"对齐，
// 否则重复 orig 的行会被同一份数据一起改写（HANDOFF 里 `id#occurrence` 同一个坑）。
// 注意行数据是数组 [orig, tr, nameTr]（省体积），不是对象 —— 取值用 r[0]。
function groupByOrig(rows, valueOf){
  const map = new Map();
  for (const r of rows){
    const orig = Array.isArray(r) ? String(r[0]) : (typeof r === 'string' ? r : String((r && r.orig) || ''));
    if (!orig) continue;
    const stamp = { orig, value: valueOf(r) };
    if (!map.has(orig)) map.set(orig, []);
    map.get(orig).push(stamp);
  }
  return map;
}

/**
 * 当前文档 vs 快照的差异。
 * `wasEmpty` 是不在快照里的行数 —— 它们的语义是"当时是空译文"，恢复时会被清空，
 * 所以另外给出 `willClear`（当前有字、恢复后会变空的行数），供 UI 写清后果。
 * @returns {{changed:Array<{i:number,before:string,after:string,orig:string}>, willClear:number, wasEmpty:number}}
 */
export function diffSnapshot(snapshot, paras){
  const list = Array.isArray(paras) ? paras : [];
  const snap = (snapshot && Array.isArray(snapshot.rows)) ? snapshot.rows : [];
  const grouped = groupByOrig(snap, r => ({ tr: String(r[1] || ''), nameTr: String(r[2] || '') }));

  const changed = [];
  let wasEmpty = 0;
  list.forEach((p, i) => {
    if (!p) return;
    const orig = String(p.orig == null ? '' : p.orig);
    const bucket = grouped.get(orig);
    const slot = bucket && bucket.length ? bucket.shift() : null;
    if (!slot){ wasEmpty++; return; }
    const cur = p.isName
      ? String(p.nameTr == null ? '' : p.nameTr)
      : String(transValue(p) || '');
    const was = p.isName ? slot.value.nameTr : slot.value.tr;
    if (cur !== was) changed.push({ i, before: was, after: cur, orig });
  });
  const willClear = changed.filter(c => String(c.after || '').trim() !== '' && String(c.before || '').trim() === '').length;
  return { changed, willClear, wasEmpty };
}

/**
 * 生成"恢复到该快照"的补丁。
 * 快照中缺席的行会被清空（当时的语义就是空译文），这是**有意**的覆盖行为。
 * @returns {Array<{i:number, translation:string, nameTr:string}>}
 */
export function patchFromSnapshot(snapshot, paras){
  const list = Array.isArray(paras) ? paras : [];
  const snap = (snapshot && Array.isArray(snapshot.rows)) ? snapshot.rows : [];
  const grouped = groupByOrig(snap, r => ({ tr: String(r[1] || ''), nameTr: String(r[2] || '') }));

  const out = [];
  list.forEach((p, i) => {
    if (!p) return;
    const orig = String(p.orig == null ? '' : p.orig);
    const bucket = grouped.get(orig);
    const slot = bucket && bucket.length ? bucket.shift() : null;
    const tr = slot ? slot.value.tr : '';
    const nameTr = slot ? slot.value.nameTr : '';
    if (p.isName){
      // NAME 行只动译名；快照没记名字（= 当时未改）就保持现状，不把名字清空
      if (nameTr && nameTr !== p.nameTr) out.push({ i, translation: p.translation, nameTr });
      return;
    }
    const cur = String(transValue(p) || '');
    const curName = String(p.nameTr == null ? '' : p.nameTr);
    const wantTr = p.brackets && tr ? ('「' + tr + '」') : tr;
    const wantName = nameTr || curName;    // 快照没记名字 → 保持现状
    if (cur === tr && wantName === curName) return;
    out.push({ i, translation: wantTr, nameTr: wantName });
  });
  return out;
}

/**
 * 裁剪计划：保留最新 max 份，其余删除。
 * @param {Array<{id:string, at:number}>} entries
 * @returns {{keep:Array, remove:Array}}
 */
export function planPrune(entries, max = HISTORY_MAX){
  const list = (Array.isArray(entries) ? entries.filter(e => e && e.id) : [])
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const n = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : HISTORY_MAX;
  return { keep: list.slice(0, n), remove: list.slice(n) };
}

/** 是否该为新快照让路（距上次快照太近则跳过，但 reason 为 'force' 时总是写） */
export function shouldSnapshot(lastAt, now, reason, minInterval = HISTORY_MIN_INTERVAL_MS){
  if (reason === 'force') return true;
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return (t - last) >= minInterval;
}

/* ---------------- IO（薄层，不参与单测） ---------------- */

const LS_PREFIX = 'galtrans_hist_v1:';

/** 列目录里的快照条目（只认 <id>.json），按时间降序；列表与排序都来自文件名，不读每个文件 */
export function listFromDirEntries(entries){
  const out = [];
  for (const e of (Array.isArray(entries) ? entries : [])){
    if (!e || e.kind !== 'file') continue;
    const name = String(e.name || '');
    const m = /^(\d{8}-\d{6})\.json$/.exec(name);
    if (!m) continue;
    out.push({ id: m[1], at: 0, path: e.path || '' });
  }
  // 文件名本身可排序，不需要读文件内容
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

/**
 * 读某文档的历史快照列表（不含内容）。
 * 桌面版枚举 `<源目录>/.galweave/history/<文件名>/`；浏览器版读 IndexedDB 里的 id 列表。
 */
export async function listSnapshots(docPath, docName){
  if (!docPath) return [];
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      const { listDirTree } = fsx;
      const dir = fsx.galweavePath(docPath, 'history/' + snapshotDirName(docName));
      if (!dir) return [];
      try {
        const entries = await listDirTree(dir);
        return listFromDirEntries(entries);
      } catch (e) { return []; }   // 目录还不存在 = 没有历史
    }
    const ids = await fsx.kvGet(LS_PREFIX + 'ids:' + docPath);
    return (Array.isArray(ids) ? ids : []).map(id => ({ id, at: 0, path: '' }));
  } catch (e) { return []; }
}

/** 读一份快照内容；不存在/损坏返回 null */
export async function readSnapshot(docPath, docName, id){
  if (!docPath || !id) return null;
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      const raw = await fsx.readGalweaveFile(docPath, snapshotRelPath(docName, id));
      return raw ? parseSnapshot(raw) : null;
    }
    const raw = await fsx.kvGet(LS_PREFIX + 'snap:' + docPath + ':' + id);
    return raw ? parseSnapshot(raw) : null;
  } catch (e) { return null; }
}

/** 写一份快照并裁剪到 HISTORY_MAX 份；返回 {saved, pruned} */
export async function writeSnapshot(docPath, docName, snapshot){
  if (!docPath || !snapshot) return { saved: false, pruned: 0 };
  const id = snapshotId(snapshot.at);
  const payload = JSON.stringify({
    version: HISTORY_VERSION, at: snapshot.at, reason: snapshot.reason,
    total: snapshot.total, rows: snapshot.rows,
  });
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      await fsx.writeGalweaveFile(docPath, snapshotRelPath(docName, id), payload);
    } else {
      await fsx.kvPut(LS_PREFIX + 'snap:' + docPath + ':' + id, JSON.parse(payload));
      const ids = await fsx.kvGet(LS_PREFIX + 'ids:' + docPath);
      const next = [...new Set([id, ...(Array.isArray(ids) ? ids : [])])];
      await fsx.kvPut(LS_PREFIX + 'ids:' + docPath, next);
    }
  } catch (e) { return { saved: false, pruned: 0 }; }

  // 裁剪：先按目录/ID 列表算出该删哪些，再逐个删
  let pruned = 0;
  try {
    const existing = await listSnapshots(docPath, docName);
    const withAt = existing.map(e => ({ ...e, at: parseIdToTime(e.id) }));
    const { remove } = planPrune(withAt, HISTORY_MAX);
    if (remove.length){
      const fsx = await import('./fs.js');
      for (const r of remove){
        if (fsx.isTauri()){
          const rel = snapshotRelPath(docName, r.id);
          await fsx.removeFile(fsx.galweavePath(docPath, rel));
        } else {
          await fsx.kvDel(LS_PREFIX + 'snap:' + docPath + ':' + r.id);
        }
        pruned++;
      }
    }
  } catch (e) { /* 裁剪失败不影响已保存的快照 */ }
  return { saved: true, pruned };
}

/** id → 时间戳（裁剪排序用） */
export function parseIdToTime(id){
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(id || ''));
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
