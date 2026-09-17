// tm.js — 翻译记忆（Translation Memory）：纯逻辑 + 极薄 IO
//
// 动机（docs/ROADMAP.md P1-3）：galgame 文本重复句式极多。机翻已有批次上下文，
// 但**同一句式重复出现仍会重复扣费、风格还不稳**；术语表只做精确替换，不覆盖句级复用。
//
// 做法：
//   1. 已完成行入库（源句轻量规范化 → 译文），随项目存 `<项目目录>/.galweave/tm.json`；
//   2. 未翻行查 TM：**精确命中**直接套用（零成本、全篇统一），**高相似命中**在行右键菜单里
//      以「套用记忆：<译文>」的形式给出建议，由人决定；
//   3. 批量机翻前先剔除精确命中行，省 token。
//
// 为什么用 bigram Dice 而不是编辑距离：日文没有词边界，字符二元组对这个语种更稳，
// 且 O(n) 可增量算。阈值见 TM_SIMILARITY（0.75，实测标定）。
//
// ⚠️ 相似命中**只做建议不自动填**：TM 相似 ≠ 语义相同（「おはよう」/「おはようございます」
//    相似度很高但译文该不该一样由人判断）。精确命中才自动套用。

import { isPlaceholderTrans, transValue } from './parsers.js';

export const TM_VERSION = 1;
/**
 * 默认相似阈值（0–1）。
 * 取 0.75 是实测标定：只差一个语气的句子（「…天気ですね」↔「…天気だね」）
 * bigram Dice ≈ 0.82，同句式换主语 ≈ 0.5–0.7，无关句 < 0.2。
 * 定在 0.82 会把"只差一个助词"的句子挡在门外（实测踩过），定在 0.5 又会把
 * 同句式不同内容的句子混进来 —— 相似命中只做建议，所以宁可稍微放宽一点。
 */
export const TM_SIMILARITY = 0.75;
/** 条目上限，超出按最后使用时间裁剪（防止 tm.json 无限膨胀） */
export const TM_LIMIT = 20000;
/** 入记忆的最短源句长度：过短的寒暄（「はい」「ええ」）复用价值低且易误套 */
export const TM_MIN_SRC_LEN = 2;

/* ---------------- 规范化 ---------------- */

/**
 * 源句轻量规范化：只做"显然等价"的归一，不做激进清洗。
 *   - 去首尾空白、压缩内部空白（全角空格也算）
 *   - 剥掉整体包裹的 「」『』
 *   - 去掉结尾的语气标点 。．！？…‥
 * 有意**不做**：全角/半角字母数字折叠、去内部标点 —— 那些会把不同句子并成一条。
 */
export function normalizeSource(src){
  let s = String(src == null ? '' : src)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  // 整体包裹的引号（可能是多层）
  for (let k = 0; k < 2; k++){
    if (s.length >= 2){
      const a = s[0], b = s[s.length - 1];
      if ((a === '「' && b === '」') || (a === '『' && b === '』') || (a === '"' && b === '"')) s = s.slice(1, -1).trim();
      else break;
    }
  }
  s = s.replace(/[。．.!！?？…‥、]+$/, '').trim();
  return s;
}

/** 字符二元组集合（长度 < 2 时退化为单元素集合） */
function bigrams(s){
  const out = new Set();
  if (s.length < 2){ if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * bigram Dice 相似度，0–1。空串返回 0；完全相等（含规范化后相等）返回 1。
 * 用集合而非多重集：重复二元组不再加权，避免叠词句虚高。
 */
export function similarity(a, b){
  const x = normalizeSource(a);
  const y = normalizeSource(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const denom = A.size + B.size;
  return denom ? (2 * inter) / denom : 0;
}

/* ---------------- 数据 ---------------- */

/** 空记忆库 */
export function emptyTm(){ return { version: TM_VERSION, entries: [] }; }

/**
 * 归一化从磁盘读回的记忆库：丢弃结构不符项、按 key 去重、截断。
 * 文件可能被手改或来自旧版本，这里兜住不让坏数据进查询路径。
 */
export function normalizeTm(raw, limit = TM_LIMIT){
  const out = emptyTm();
  const src = (raw && Array.isArray(raw.entries)) ? raw.entries : [];
  const seen = new Set();
  for (const e of src){
    if (!e || typeof e.src !== 'string' || typeof e.dst !== 'string') continue;
    const key = normalizeSource(e.src);
    if (!key || key.length < TM_MIN_SRC_LEN) continue;
    const dst = String(e.dst).trim();
    if (!dst) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.entries.push({
      key,
      src: String(e.src),
      dst,
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0,
      hits: Number.isFinite(Number(e.hits)) ? Math.max(0, Math.floor(Number(e.hits))) : 0,
    });
  }
  return pruneTm(out, limit);
}

/** 按最后使用时间裁剪到 limit 条（不改原对象） */
export function pruneTm(tm, limit = TM_LIMIT){
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : TM_LIMIT;
  const out = list.slice();
  if (out.length > n){
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    out.length = n;
  }
  return { version: TM_VERSION, entries: out };
}

/** 当前条目数 */
export function tmSize(tm){
  return (tm && Array.isArray(tm.entries)) ? tm.entries.length : 0;
}

/**
 * 写入一条记忆。同一规范键覆盖（更新译文与时间），否则新增。返回新对象（不改原库）。
 */
export function addEntry(tm, src, dst, at){
  const key = normalizeSource(src);
  const value = String(dst == null ? '' : dst).trim();
  if (!key || key.length < TM_MIN_SRC_LEN || !value) return tm;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const base = tm && Array.isArray(tm.entries) ? tm.entries : [];
  const entries = base.filter(e => e.key !== key);
  entries.unshift({ key, src: String(src), dst: value, at: t, hits: 0 });
  return pruneTm({ version: TM_VERSION, entries });
}

/** 精确命中（按规范键）；未命中返回 null */
export function findExact(tm, src){
  const key = normalizeSource(src);
  if (!key) return null;
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  for (const e of list) if (e.key === key) return e;
  return null;
}

/**
 * 高相似命中列表（按相似度降序）。
 * @param {object} tm
 * @param {string} src
 * @param {{threshold?:number, limit?:number, excludeExact?:boolean}} [opts]
 * @returns {Array<{entry:object, score:number}>}
 */
export function findSimilar(tm, src, opts = {}){
  const key = normalizeSource(src);
  if (!key) return [];
  const thr = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : TM_SIMILARITY;
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 5;
  const excludeExact = opts.excludeExact !== false;
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  const out = [];
  for (const e of list){
    if (excludeExact && e.key === key) continue;
    const score = similarity(key, e.key);
    if (score >= thr) out.push({ entry: e, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 从段落里收割已完成行入记忆（批量入库的入口）。
 * 只收非 NAME、译文非空、且源句够长的行；译文取 `transValue`（剥掉外层「」），
 * 套用时再按目标行类型包回，这样同一条记忆能在「有括号 / 无括号」两种行上复用。
 * 译文与原文相同的占位行（镜像格式未翻译时预填原文）不入记忆 —— 那不是翻译，
 * 收进去会产出「原文→原文」的垃圾条目，污染后续的建议命中。
 * @returns {{tm:object, added:number}} added = 真正新增或译文发生变化的条数（重复收割同一句不算）
 */
export function collectFromParas(paras, tm, at){
  let cur = tm && Array.isArray(tm.entries) ? tm : emptyTm();
  let added = 0;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  for (const p of (Array.isArray(paras) ? paras : [])){
    if (!p || p.isName) continue;
    const src = String(p.content || '');
    if (normalizeSource(src).length < TM_MIN_SRC_LEN) continue;
    const dst = String(transValue(p) || '').trim();
    if (!dst) continue;
    if (isPlaceholderTrans(p)) continue; // 预填/照抄的原文占位: 不是译文,不入库
    const prev = findExact(cur, src);
    if (prev && prev.dst === dst) continue;   // 已收割过且没变，跳过
    cur = addEntry(cur, src, dst, t);
    added++;
  }
  return { tm: cur, added };
}

/** 建议条文案（行菜单 / Toast 用）：截断到 n 个字符 */
export function suggestLabel(dst, n = 18){
  const s = String(dst == null ? '' : dst).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------------- IO（薄层，不参与单测） ---------------- */

const LS_PREFIX = 'galtrans_tm_v1:';

function storeKey(projectPath){
  return LS_PREFIX + (projectPath || 'global');
}

/**
 * 读记忆库。
 * 桌面版 + 有绝对路径 → `<源目录>/.galweave/tm.json`；
 * 其余（浏览器 / 未保存文件）→ IndexedDB（键 tm:<路径或 global>）。
 * 任何失败都返回空库而不抛错 —— TM 是加速器，不该阻断翻译流程。
 */
export async function loadTm(projectPath){
  if (!projectPath) return emptyTm();
  try {
    const { isTauri } = await import('./fs.js');
    if (isTauri()){
      const { readGalweaveFile } = await import('./fs.js');
      const raw = await readGalweaveFile(projectPath, 'tm.json');
      if (raw){
        try { return normalizeTm(JSON.parse(raw)); } catch (e) { return emptyTm(); }
      }
      return emptyTm();
    }
    const { kvGet } = await import('./fs.js');
    const data = await kvGet(storeKey(projectPath));
    return data ? normalizeTm(data) : emptyTm();
  } catch (e) { return emptyTm(); }
}

/** 写记忆库。返回是否成功落盘。 */
export async function saveTm(projectPath, tm){
  if (!projectPath) return false;
  const payload = { version: TM_VERSION, updatedAt: new Date().toISOString(), entries: pruneTm(tm).entries };
  try {
    const { isTauri } = await import('./fs.js');
    if (isTauri()){
      const { writeGalweaveFile } = await import('./fs.js');
      return await writeGalweaveFile(projectPath, 'tm.json', JSON.stringify(payload, null, 2));
    }
    const { kvPut } = await import('./fs.js');
    await kvPut(storeKey(projectPath), payload);
    return true;
  } catch (e) { return false; }
}
