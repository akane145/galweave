// search-remote.js — search.js 的非破坏包装,供 Worker 使用。
// 与 src/search.js 同样的算法,但 operate 时不改 paras,而是返回 deltas
// 供主线程 model 应用(live 数组留在主线程)。
// 纯逻辑,无 DOM;node 下可直接 import 做单测。
import { findIdx, escapeRegex } from './search.js';

/** computeMatches 的直通(只读,不改 paras;直接转发 search.js 既有函数)。 */
export { computeMatches, countMatches, jumpToIndex } from './search.js';

/**
 * replaceAllInParas 非破坏版本: 返回 deltas 数组而非原地改 paras。
 * deltas: [{ i, translation, nameTr, count }]
 *   count = 该行被替换掉的文字次数（供逐行预览显示"替换 N 处"）。
 * 同时返回 { total, nameTotal }(与原签名一致)。
 *
 * ⚠️ 本函数是**替换预览与应用的共同规则来源**：预览用它的 deltas 展示，
 * 应用直接消费同一份 deltas，不另算一遍（两套规则必然随时间分叉）。
 * NAME 行与空译文不参与译文替换；同值替换由调用方按 before===after 过滤。
 */
export function replaceAllInParasDeltas(paras, q, rep, scope, cs){
  const deltas = [];
  // 空查找串直接返回：与 search.replaceAllInParas 一致。
  // 少了这一条，replaceAllText 里 `i = j + find.length` 会原地不动 → 死循环。
  if (q === '') return { deltas, total: 0, nameTotal: 0 };
  const replaceTrans = scope === 'all' || scope === 'trans';
  const replaceName = scope === 'name';
  let total = 0, nameTotal = 0;
  for (let i = 0; i < paras.length; i++){
    const p = paras[i];
    let touched = false;
    let nextTranslation = p.translation;
    let nextNameTr = p.nameTr;
    let count = 0;
    if (replaceTrans && !p.isName){
      const tv = p.translation || '';
      if (tv.trim() !== ''){
        const c = occurrences(tv, q, cs);
        if (c > 0){
          nextTranslation = replaceAllText(tv, q, rep, cs);
          total += c;
          count += c;
          touched = true;
        }
      }
    }
    if (replaceName){
      const nv = p.nameTr || '';
      if (nv){
        const c = occurrences(nv, q, cs);
        if (c > 0){
          nextNameTr = replaceAllText(nv, q, rep, cs);
          nameTotal += c;
          count += c;
          touched = true;
        }
      }
    }
    if (touched){
      deltas.push({ i, translation: nextTranslation, nameTr: nextNameTr, count });
    }
  }
  return { deltas, total, nameTotal };
}

function occurrences(src, find, cs){
  let n = 0, i = 0;
  while ((i = findIdx(src, find, i, cs)) !== -1){ n++; i += Math.max(1, find.length); }
  return n;
}

function replaceAllText(src, find, rep, cs){
  if (find === '') return src; // 空匹配 = 不改（防死循环，见 replaceAllInParasDeltas）
  let out = '', i = 0;
  while (i <= src.length){
    const j = findIdx(src, find, i, cs);
    if (j === -1){ out += src.slice(i); break; }
    out += src.slice(i, j) + rep;
    i = j + find.length;
  }
  return out;
}

export { findIdx, escapeRegex }; /* 保持 import 兼容 */