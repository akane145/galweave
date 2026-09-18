// qa.js — 术语 / 一致性质量检查（纯逻辑，不依赖 DOM）
//
// 与 proof.js 的「漏翻 / 异常」互补，两者分工明确：
//   proof.js  检查**单行内部**的完成度：译文为空 / 照抄原文 / 长度比越界
//   qa.js     检查**跨行、跨术语表**的一致性：术语用没用、译名统不统一、占位符丢没丢
// 两类结果汇入同一个「漏翻/异常清单」UI（main.js renderMissingList），因此本模块
// **不重复报 proof 已覆盖的情形**：空译文、照抄原文一律跳过，交回 proof 报。
//
// 四类检查：
//   term           源句含术语表词条，译文却没用约定译名
//   name-conflict  同一源名在本篇出现多个不同译名
//   token          源文里的数字 / 【…】占位符在译文里缺失
//   punct          译文里半角标点紧贴中日文字符，或「」引号不配对
//
// ⚠️ 全部判定都是**启发式**。清单是给人看的，噪音会让人直接放弃它，
//    所以每条阈值都写死成常量、都配单测，且一律**宁漏报不误报**。

import { transValue } from './parsers.js';
import { checkKinjiru, kinjiruLabel } from './textnorm.js';
import { tokenizeInline } from './universal-parser.js';

/* ---------------- 阈值（改动需同步 docs/DEVELOPMENT.md 维护契约与单测） ---------------- */

/** 单字词条不做"未应用"检查 —— 「私」「你」「僕」这类命中率过高，纯噪音 */
export const MIN_TERM_LEN = 2;
/** 每行最多报几条缺术语（长词条优先，避免一行刷满） */
export const MAX_TERM_HITS_PER_ROW = 3;
/** 每行最多报几个缺失占位符 */
export const MAX_TOKEN_HITS_PER_ROW = 3;
/** 每行最多报几处半角标点 */
export const MAX_PUNCT_HITS_PER_ROW = 3;
/** 【…】里超过这个长度就不当占位符（多半是正文，不是 token） */
export const MAX_BRACKET_LEN = 20;
/** 每行最多报几处避头尾问题（一条译文里换行很多时不该刷满胶囊） */
export const MAX_KINJIRU_HITS_PER_ROW = 2;

/** 全部检查类别，顺序 = 清单里的展示顺序 */
export const QA_KINDS = ['term', 'name-conflict', 'token', 'punct'];

/* ---------------- 纯工具 ---------------- */

const preview = (s, n) => {
  const x = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n) + '…' : x;
};

/** 全角数字 / 全角逗号 → 半角，并去掉千分位逗号，用于跨字宽的占位符比对 */
export function normalizeDigits(s){
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[，,]/g, '');
}

/**
 * 术语条目归一化：只保留可用于检查的条目。
 * @param {object} gloss { names, terms } —— 与 glossary.js 的项目术语表同构
 * @param {number} [minLen] 源词最短长度，默认 MIN_TERM_LEN
 * @returns {Array<{src:string,dst:string,group:'terms'|'names'}>} 按 src 长度降序
 */
export function termEntries(gloss, minLen = MIN_TERM_LEN){
  const g = (gloss && typeof gloss === 'object') ? gloss : {};
  const min = Number.isFinite(minLen) ? minLen : MIN_TERM_LEN;
  const out = [];
  for (const group of ['terms', 'names']){
    const map = (g[group] && typeof g[group] === 'object') ? g[group] : {};
    for (const src of Object.keys(map)){
      const dst = map[src];
      if (typeof dst !== 'string') continue;
      const s = src.trim(), d = dst.trim();
      if (!s || !d || s === d) continue;        // 空条目 / 未翻译的映射不参与
      if (s.length < min) continue;
      out.push({ src: s, dst: d, group });
    }
  }
  // 长词条优先：同时命中「東京」与「東京大学」时应报长的那条
  out.sort((a, b) => b.src.length - a.src.length || a.src.localeCompare(b.src));
  return out;
}

/**
 * 抽取源文里需要原样保留到译文的占位符。
 * 数字按**归一化后**的串匹配（源文用全角数字、译文用半角也算保留）；
 * 【…】取括号内文本做精确匹配。
 * @returns {Array<{type:'num'|'bracket', value:string}>}
 */
export function extractTokens(src){
  const text = normalizeDigits(src);
  const out = [];
  let m;
  const numRe = /\d+/g;
  while ((m = numRe.exec(text))) out.push({ type: 'num', value: m[0] });
  const brRe = /【([^】]+)】/g;
  while ((m = brRe.exec(text))){
    const inner = m[1].trim();
    if (inner && inner.length <= MAX_BRACKET_LEN) out.push({ type: 'bracket', value: inner });
  }
  return out;
}

/* ---------------- 单项检查 ---------------- */

/** 该行是否应参与检查：NAME 行 / 空译文 / 照抄原文都不归 qa.js 管 */
function checkable(p){
  if (!p || p.isName) return null;
  const tv = transValue(p);
  if (!tv.trim()) return null;                 // 空译文 → proof.missing
  if (p.translation === p.content) return null; // 照抄原文 → proof.placeholder
  const src = String(p.content == null ? '' : p.content);
  if (!src.trim()) return null;
  return { src, tv: String(tv) };
}

/**
 * 术语未应用：源句命中词条，译文却没有约定译名。
 * @param {Array} paras
 * @param {Array} entries termEntries() 的产物
 */
export function termMisses(paras, entries){
  const list = Array.isArray(paras) ? paras : [];
  const ents = Array.isArray(entries) ? entries : [];
  if (!ents.length) return [];
  const out = [];
  list.forEach((p, i) => {
    const c = checkable(p);
    if (!c) return;
    let hits = 0;
    for (const e of ents){
      if (hits >= MAX_TERM_HITS_PER_ROW) break;
      if (!c.src.includes(e.src)) continue;
      if (c.tv.includes(e.dst)) continue;
      hits++;
      out.push({
        i, kind: 'term', term: e.src, expect: e.dst,
        origPreview: preview(c.src, 40), transPreview: preview(c.tv, 40),
      });
    }
  });
  return out;
}

/**
 * 同一源名多个译名。每个冲突名只报**首次出现行**一条，不逐行刷屏。
 * 只统计 nameTr !== name 的"已译名"；缺译名或仍等于原文名的行视为未译，不参与。
 */
export function nameConflicts(paras){
  const list = Array.isArray(paras) ? paras : [];
  const bySrc = new Map();      // src -> Map(dst -> count)
  const firstIdx = new Map();   // src -> 首次出现的下标
  list.forEach((p, i) => {
    if (!p || !p.name) return;
    const dst = String(p.nameTr == null ? '' : p.nameTr).trim();
    if (!dst || dst === p.name) return;
    if (!bySrc.has(p.name)){ bySrc.set(p.name, new Map()); firstIdx.set(p.name, i); }
    const m = bySrc.get(p.name);
    m.set(dst, (m.get(dst) || 0) + 1);
  });

  const out = [];
  for (const [src, m] of bySrc){
    if (m.size < 2) continue;   // 只有一个译名 = 一致，无需报告
    const values = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.push({
      i: firstIdx.get(src),
      kind: 'name-conflict',
      name: src,
      values: values.map(v => v[0]),
      counts: values.map(v => v[1]),
      origPreview: preview(src, 40),
      transPreview: preview(values.map(v => v[0] + '×' + v[1]).join(' / '), 40),
    });
  }
  out.sort((a, b) => a.i - b.i);
  return out;
}

/** 数字 / 【…】占位符在译文里缺失 */
export function tokenMisses(p){
  const c = checkable(p);
  if (!c) return [];
  const tvNorm = normalizeDigits(c.tv);
  const out = [];
  for (const tok of extractTokens(c.src)){
    if (out.length >= MAX_TOKEN_HITS_PER_ROW) break;
    if (tvNorm.includes(tok.value)) continue;
    out.push({ type: tok.type, value: tok.value });
  }
  return out;
}

// 半角 → 全角映射（只覆盖中文正文里最常见的几个）
const HALF_PUNCT = { ',': '，', '.': '。', ';': '；', ':': '：', '!': '！', '?': '？', '(': '（', ')': '）' };
// 中日文范围：平/片假名 + 汉字 + 全角符号
const CJK = '\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF01-\uFF60\uFFE0-\uFFE6';

/**
 * 半角标点异常：半角标点**紧贴中日文字符**时视为可疑（中文正文该用全角）。
 * 只在紧贴 CJK 时报 —— 译文里的「Sakura 3.0」「(CV: xxx)」属正常拉丁语境，不该误报。
 * 另检查「」配对：数量不等说明多半漏了收尾引号。
 */
export function punctMisses(p){
  const c = checkable(p);
  if (!c) return [];
  const tv = c.tv;
  const out = [];
  const re = new RegExp('([' + CJK + '])([,.;:!?()])|([,.;:!?()])([' + CJK + '])', 'g');
  let m;
  while ((m = re.exec(tv))){
    if (out.length >= MAX_PUNCT_HITS_PER_ROW) break;
    const ch = m[2] || m[3];
    out.push({ ch, suggest: HALF_PUNCT[ch] || ch });
  }
  const open = (tv.match(/「/g) || []).length;
  const close = (tv.match(/」/g) || []).length;
  if (open !== close){
    out.push({ ch: open > close ? '「' : '」', suggest: '引号配对', unbalanced: true });
  }
  return out;
}

/* ---------------- 控制符核对（手动编辑） ---------------- */

/**
 * 手改译文时核对引擎控制符：原文里有的记号，译文里该在的还在不在。
 *
 * 为什么需要：机翻链路的控制符保护已经很严密（universal-parser 的遮蔽 + 还原 +
 * 严格性分级，mt.js 在破坏时直接拒绝写入），但**手动编辑那条路完全不校验**
 * （transInputHandler 直接赋值）。译者挪断点、改语序时敲坏或误删 [r] / <r> /
 * %p…; 这类记号，脚本行为就变了，而且不会有任何提示。
 *
 * 判定刻意保守（沿用本文件的"宁漏报不误报"）：
 *   - 只比**控制符的多重集合**，不要求顺序 —— 中文语序调整后记号位置本就该变
 *     （universal-parser.js 也明确写了"译文断行要随中文长度重排"）。
 *   - 只报"译文里比原文**少**"的记号（丢失/敲坏）；多出来的一律不报，
 *     因为译者可能有意加断行标签来适配对话框。
 *   - 全角误输（[r] 敲成 ［ｒ］）是丢失的常见成因，单独给出提示措辞。
 *
 * @returns {Array<{ch:string, role:string, count:number, fullwidth:boolean}>}
 */
export function controlMisses(p){
  const c = checkable(p);
  if (!c) return [];
  const src = tokenizeInline(c.src).filter(t => t.protected);
  if (!src.length) return [];                 // 原文没有控制符 → 无从漏起

  const tv = c.tv;
  const tvTokens = tokenizeInline(tv).filter(t => t.protected);

  // 归一化键：大小写不敏感（[R] 与 [r] 是同一个记号）
  const key = v => String(v).toLowerCase();
  const have = new Map();
  for (const t of tvTokens) have.set(key(t.value), (have.get(key(t.value)) || 0) + 1);

  // 全角误输检测：把译文里的全角括号/字母折成半角再试一次，命中则是"敲成全角"而非真丢了
  const folded = tv.replace(/［/g, '[').replace(/］/g, ']')
    .replace(/[＜]/g, '<').replace(/[＞]/g, '>')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const foldedHave = new Map();
  for (const t of tokenizeInline(folded).filter(x => x.protected)) {
    foldedHave.set(key(t.value), (foldedHave.get(key(t.value)) || 0) + 1);
  }

  const need = new Map();
  for (const t of src) need.set(key(t.value), (need.get(key(t.value)) || 0) + 1);

  const out = [];
  for (const [k, n] of need){
    const got = have.get(k) || 0;
    if (got >= n) continue;                    // 够用
    const orig = src.find(t => key(t.value) === k);
    out.push({
      ch: orig ? orig.value : k,
      role: orig ? orig.role : 'command',
      count: n - got,
      fullwidth: (foldedHave.get(k) || 0) >= n, // 折半角后够了 → 多半是敲成全角
    });
  }
  return out;
}

/* ---------------- 汇总 ---------------- */

/**
 * 汇总一次全文 QA 检查。
 * @param {Array} paras 段落数组
 * @param {object} gloss 项目术语表 { names, terms }
 * @returns {{term:Array,'name-conflict':Array,token:Array,punct:Array,total:number}}
 */
export function analyzeQA(paras, gloss){
  const list = Array.isArray(paras) ? paras : [];
  const entries = termEntries(gloss);

  const out = {
    term: termMisses(list, entries),
    'name-conflict': nameConflicts(list),
    token: [],
    punct: [],
  };

  list.forEach((p, i) => {
    const c = checkable(p);
    if (!c) return;
    for (const t of tokenMisses(p)){
      out.token.push({
        i, kind: 'token', tokenType: t.type, value: t.value,
        origPreview: preview(c.src, 40), transPreview: preview(c.tv, 40),
      });
    }
    for (const x of punctMisses(p)){
      out.punct.push({
        i, kind: 'punct', ch: x.ch, suggest: x.suggest, unbalanced: !!x.unbalanced,
        origPreview: preview(c.src, 40), transPreview: preview(c.tv, 40),
      });
    }
  });

  const total = out.term.length + out['name-conflict'].length + out.token.length + out.punct.length;
  return { ...out, total };
}

/* ---------------- 单行入口（行级实时门禁） ---------------- */

/**
 * 单行 QA：判一行有没有术语未用 / 占位符缺失 / 标点异常。
 *
 * 供行级实时门禁调用（renderer 的行内胶囊）。**判定与阈值全部复用上面的
 * termMisses / tokenMisses / punctMisses，不另设一套标准** —— 实时化若放宽阈值，
 * 行视图会立刻被噪音淹没，这条纪律见文件头的"宁漏报不误报"。
 *
 * 不含 name-conflict：那一项按定义就是跨行统计（同一源名的多个译名），
 * 单行范围内无法判定，由批量 analyzeQA 负责。
 *
 * @param {object} p 单行
 * @param {Array} entries termEntries() 的产物（调用方缓存，勿逐行重建）
 * @returns {{issues:Array, total:number, term:object|null}}
 *          issues 扁平列表，每项带 kind；term 为第一条"术语未应用"（供一键填入），无则 null
 */
export function analyzeRowQA(p, entries){
  const issues = [];
  // termMisses 面向 paras 数组（内部自行 checkable），传单元素数组即可复用同一套判定
  for (const t of termMisses([p], Array.isArray(entries) ? entries : [])){
    issues.push({ kind: 'term', term: t.term, expect: t.expect });
  }
  for (const t of tokenMisses(p)){
    issues.push({ kind: 'token', tokenType: t.type, value: t.value });
  }
  for (const x of punctMisses(p)){
    issues.push({ kind: 'punct', ch: x.ch, suggest: x.suggest, unbalanced: !!x.unbalanced });
  }
  // 避头尾：只在译者自己按的换行处判断（自动折行归引擎管，报出来是噪音）。
  // 与上面几类共用同一个胶囊，不另造 UI —— 同一条译文的问题集中在一处提示。
  const c = checkable(p);
  if (c){
    let kHits = 0;
    for (const k of checkKinjiru(c.tv)){
      if (kHits >= MAX_KINJIRU_HITS_PER_ROW) break;
      kHits++;
      issues.push({ kind: 'kinjiru', ch: k.ch, lineKind: k.kind, label: kinjiruLabel(k) });
    }
    // 控制符核对（手动编辑链路的口子，机翻链路由 universal-parser 保护）
    for (const m of controlMisses(p)){
      issues.push({ kind: 'control', ch: m.ch, role: m.role, count: m.count, fullwidth: m.fullwidth });
    }
  }
  return {
    issues,
    total: issues.length,
    term: issues.find(x => x.kind === 'term') || null,
  };
}
