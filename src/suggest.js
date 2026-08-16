// suggest.js — 译文输入建议(术语/片段)纯逻辑,零 DOM
// 词元 = 光标前到最后一个分隔符的连续文本,上限 12 字符。
// 运行: node --test tests/dict.test.mjs

const SEPARATORS = new Set('「」『』()（）・。、，,．.！!？?；;：:…—―‐- \t\r\n　'.split(''));
const MAX_TOKEN = 12;

/** 取光标前正在输入的词元;caret 越界自动夹取 */
export function currentToken(value, caret){
  if (value == null) return '';
  const s = String(value);
  const pos = Math.max(0, Math.min(caret | 0, s.length));
  let start = pos;
  while (start > 0 && !SEPARATORS.has(s[start - 1]) && (pos - start) < MAX_TOKEN) start--;
  return s.slice(start, pos);
}

/**
 * 匹配建议: 术语表 terms(原文→译文) + 片段 snippets(缩写→展开)。
 * 排序: 精确命中 > 前缀命中 > 包含命中;同级按源串短者在前。
 * 返回 [{kind:'term'|'snippet', src, dst}](上限 limit,默认 8)。
 */
export function matchSuggestions(token, terms, snippets, limit = 8){
  if (!token) return [];
  const out = [];
  const add = (kind, src, dst) => {
    if (!src || dst === undefined || dst === '') return;
    let score;
    if (src === token) score = 0;
    else if (src.startsWith(token)) score = 1;
    else if (src.includes(token)) score = 2;
    else return;
    out.push({ kind, src, dst, score });
  };
  for (const [k, v] of Object.entries(terms || {})) add('term', k, v);
  for (const [k, v] of Object.entries(snippets || {})) add('snippet', k, v);
  out.sort((a, b) => a.score - b.score || a.src.length - b.src.length || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
  return out.slice(0, limit).map(x => ({ kind: x.kind, src: x.src, dst: x.dst }));
}
