// mtbaseline.js — 机翻基线 + 「机翻 → 定稿」diff 学习视图（纯逻辑 + thin IO）
//
// 动机（docs/ROADMAP.md P2-7）：`showMtCompare` 只在采纳当下做单行比对，
// 机翻结果一落盘就被人工改动覆盖，**没人知道改了什么、为什么改**。
// 于是同一类错误（漏助词、标点体例、译名不统一）会在每一批里重复出现。
//
// 做法：凡是机翻写进某行的译文，都在 `.galweave/mtbaseline.json` 里留一份**基线**；
// 此后人工怎么改都只改正文，基线不动。于是"机翻 → 定稿"的差异随时可算，
// 并按**可判定的类别**聚类，让"我到底在改什么"一眼可见。
//
// 行数据格式与 `src/history.js` 完全一致（`[orig, tr, nameTr]`），因此
// **差异计算直接复用 `history.diffSnapshot`** —— 重复 orig 的次数对齐、brackets 处理
// 这些容易踩的坑只在一个地方实现、只被一套单测钉住。
//
// ⚠️ 基线是**稠密数组**（每个段落一格，没机翻过的格子是空串），不是稀疏表。
//    这样"第 i 段 ↔ 第 i 行基线"是恒等的，不需要 occurrence 推演；
//    文档结构变化（重新导入）时按位置校验 orig，对不上就整格作废。

import { diffSnapshot } from './history.js';
import { transValue } from './parsers.js';

export const MT_BASELINE_VERSION = 1;
/** 面板里每类最多展示几个例子 */
export const MAX_EXAMPLES = 3;

/* ---------------- 类别判定 ---------------- */

// 中日文标点 + ASCII 标点，用于"只差标点"的判定
const PUNCT_RE = /[\s\u3000、。，．！？…‥「」『』（）〔〕［］｛｝〈〉《》【】〜～ー－—…·:：;；,.'"!?()[\]{}<>\-]/g;

/** 去掉全部标点与空白（用于判定"只差标点"） */
export function stripPunct(s){
  return String(s == null ? '' : s).replace(PUNCT_RE, '');
}

/** NFKC 规范化（把全角字母数字、半角片假名等折叠成同一形式） */
export function nfkc(s){
  const t = String(s == null ? '' : s);
  return typeof t.normalize === 'function' ? t.normalize('NFKC') : t;
}

/** 去掉末尾 n 个字符（短于 n 时返回空串） */
export function tailTrim(s, n = 2){
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, -n) : '';
}

/** 公共前缀长度 */
export function commonPrefixLen(a, b){
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** "只差词尾"允许的最大尾部差异字数（です/だ、ました/ます 一类） */
export const TAIL_MAX = 3;
/**
 * "明显精简/扩写"的最小绝对字数差。
 * 只比比例会在短句上失控：6 字 → 8 字是 +33%，但那只是一句话的正常改写，不是"扩写"。
 */
export const MIN_LEN_DELTA = 4;

/**
 * 给一条"机翻 → 定稿"改动归类。判序有意从"最保守"到"最宽松"：
 * 先排除"其实没改"，再逐级放宽到"整句重写"。
 * @returns {'same'|'punct'|'width'|'tail'|'shortened'|'expanded'|'rewrite'}
 */
export function classifyEdit(before, after){
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  if (a === b) return 'same';
  if (stripPunct(a) === stripPunct(b)) return 'punct';
  if (nfkc(a) === nfkc(b)) return 'width';
  // 只差词尾：公共前缀要覆住较短串的**大部分**（≥60%），且尾部差异不超过 TAIL_MAX 字。
  // 只判「尾部差异很短」不够：4 字的「今天天气 / 今天下雨」尾部也只差 2 字，
  // 但那是改写不是词尾变化 —— 所以 60% 覆盖度这一条不能省。
  const cp = commonPrefixLen(a, b);
  const minLen = Math.min(a.length, b.length);
  if (cp >= 2 && (minLen - cp) <= TAIL_MAX && cp >= Math.ceil(minLen * 0.6)) return 'tail';
  const la = stripPunct(a).length;
  const lb = stripPunct(b).length;
  if (la - lb >= MIN_LEN_DELTA && la > 0 && lb / la < 0.8) return 'shortened';
  if (lb - la >= MIN_LEN_DELTA && la > 0 && lb / la > 1.25) return 'expanded';
  return 'rewrite';
}

/** 类别中文名（面板与文案共用） */
export const EDIT_LABELS = {
  same: '未改动',
  punct: '标点差异',
  width: '全/半角差异',
  tail: '只差词尾',
  shortened: '明显精简',
  expanded: '明显扩写',
  rewrite: '整句重写',
};

/** 类别排序（面板展示顺序：从"最轻"到"最重"） */
export const EDIT_ORDER = ['punct', 'width', 'tail', 'shortened', 'expanded', 'rewrite'];

/* ---------------- 基线构造 ---------------- */

export function emptyBaseline(){ return { version: MT_BASELINE_VERSION, at: 0, total: 0, rows: [] }; }

/**
 * 把机翻输出写进基线。
 * @param {object} baseline 现有基线
 * @param {Array} paras 段落数组（提供 orig 用于对齐校验）
 * @param {Array<{i:number, text:string}>} entries 本次写入的行与机翻原文
 * @returns {object} 新基线（不改原对象）
 */
export function recordMt(baseline, paras, entries){
  const list = Array.isArray(paras) ? paras : [];
  const prev = (baseline && Array.isArray(baseline.rows)) ? baseline.rows : [];
  // 稠密对齐：位置 i ↔ 第 i 段；orig 变了说明文档换过，该格作废（不能把 A 文档的机翻当 B 文档的基线）
  const rows = list.map((p, i) => {
    const orig = String((p && p.orig) || '');
    const old = prev[i];
    return (Array.isArray(old) && String(old[0]) === orig) ? [orig, String(old[1] || ''), String(old[2] || '')] : [orig, '', ''];
  });
  for (const e of (Array.isArray(entries) ? entries : [])){
    const i = Number(e && e.i);
    if (!Number.isInteger(i) || i < 0 || i >= rows.length) continue;
    const text = String((e && e.text) == null ? '' : e.text);
    if (!text.trim()) continue;
    rows[i][1] = text;
  }
  return { version: MT_BASELINE_VERSION, at: Date.now(), total: list.length, rows };
}

/** 归一化从磁盘读回的基线（丢坏数据、长度对齐到 paras） */
export function normalizeBaseline(raw, total){
  const n = Number.isFinite(Number(total)) && Number(total) > 0 ? Math.floor(Number(total)) : 0;
  if (!raw || typeof raw !== 'object') return emptyBaseline();
  if (Number(raw.version) !== MT_BASELINE_VERSION) return emptyBaseline();
  const rows = [];
  const src = Array.isArray(raw.rows) ? raw.rows : [];
  for (let i = 0; i < (n || src.length); i++){
    const r = src[i];
    rows.push(Array.isArray(r) && typeof r[0] === 'string'
      ? [r[0], typeof r[1] === 'string' ? r[1] : '', typeof r[2] === 'string' ? r[2] : '']
      : ['', '', '']);
  }
  return {
    version: MT_BASELINE_VERSION,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    total: n || rows.length,
    rows,
  };
}

/** 基线里有几条有效的机翻记录 */
export function baselineCount(baseline){
  const rows = (baseline && Array.isArray(baseline.rows)) ? baseline.rows : [];
  let n = 0;
  for (const r of rows) if (Array.isArray(r) && String(r[1] || '').trim()) n++;
  return n;
}

/* ---------------- 差异汇总 ---------------- */

/**
 * 算「机翻 → 定稿」的差异。
 * 只保留**基线里确实有内容**的行 —— 基线为空的格子是纯人工翻译，不属于"改了机翻"。
 * @returns {{edits:Array<{i:number,before:string,after:string,orig:string}>, kept:number, total:number}}
 */
export function mtEdits(baseline, paras){
  const d = diffSnapshot(baseline, paras);
  const list = Array.isArray(paras) ? paras : [];
  const rows = (baseline && Array.isArray(baseline.rows)) ? baseline.rows : [];
  // kept = 机翻写进去了、且至今一字未改的行（"直接采纳"）
  let kept = 0;
  rows.forEach((r, i) => {
    const before = Array.isArray(r) ? String(r[1] || '') : '';
    if (!before.trim()) return;
    const p = list[i];
    if (!p) return;
    // 与 diffSnapshot 用同一取值口径（transValue 会剥掉 brackets 行的外层「」），
    // 否则带括号的行会被误判成"改过"，采纳率凭空变低
    const after = p.isName ? String(p.nameTr == null ? '' : p.nameTr) : String(transValue(p) || '');
    if (after === before) kept++;
  });
  const edits = d.changed.filter(c => String(c.before || '').trim() !== '');
  return { edits, kept, total: edits.length + kept };
}

/**
 * 按类别聚合改动，供面板展示"高频改动模式"。
 * @param {Array} edits mtEdits().edits
 * @param {number} [maxExamples]
 * @returns {{total:number, categories:Array<{key:string,label:string,count:number,examples:Array}>}}
 */
export function summarizeEdits(edits, maxExamples = MAX_EXAMPLES){
  const list = Array.isArray(edits) ? edits : [];
  const cap = Number.isFinite(Number(maxExamples)) && Number(maxExamples) >= 0 ? Math.floor(Number(maxExamples)) : MAX_EXAMPLES;
  const buckets = new Map();
  for (const e of list){
    const key = classifyEdit(e.before, e.after);
    if (key === 'same') continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const categories = [];
  for (const key of EDIT_ORDER){
    const items = buckets.get(key);
    if (!items || !items.length) continue;
    categories.push({
      key,
      label: EDIT_LABELS[key] || key,
      count: items.length,
      examples: items.slice(0, cap),
    });
  }
  return { total: categories.reduce((a, c) => a + c.count, 0), categories };
}

/** 采纳率文案（机翻直接可用比例） */
export function keepRateText(r){
  const total = Number(r && r.total) || 0;
  if (!total) return '—';
  return Math.round((Number(r.kept) || 0) / total * 1000) / 10 + '%';
}

/* ---------------- IO（薄层，不参与单测） ---------------- */

const LS_PREFIX = 'galtrans_mtbase_v1:';
const FILE = 'mtbaseline.json';

export async function loadBaseline(docPath, total){
  if (!docPath) return emptyBaseline();
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      const raw = await fsx.readGalweaveFile(docPath, FILE);
      if (raw){ try { return normalizeBaseline(JSON.parse(raw), total); } catch (e) { return emptyBaseline(); } }
      return emptyBaseline();
    }
    const data = await fsx.kvGet(LS_PREFIX + docPath);
    return data ? normalizeBaseline(data, total) : emptyBaseline();
  } catch (e) { return emptyBaseline(); }
}

export async function saveBaseline(docPath, baseline){
  if (!docPath || !baseline) return false;
  const payload = { version: MT_BASELINE_VERSION, at: baseline.at, total: baseline.total, rows: baseline.rows };
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      return await fsx.writeGalweaveFile(docPath, FILE, JSON.stringify(payload));
    }
    await fsx.kvPut(LS_PREFIX + docPath, payload);
    return true;
  } catch (e) { return false; }
}
