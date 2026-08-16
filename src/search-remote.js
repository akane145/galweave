// search-remote.js — search.js 的非破坏包装,供 Worker 使用。
// 与 src/search.js 同样的算法,但 operate 时不改 paras,而是返回 deltas
// 供主线程 model 应用(live 数组留在主线程)。
// 纯逻辑,无 DOM;node 下可直接 import 做单测。
import { findIdx, escapeRegex } from './search.js';

/** computeMatches 的直通(只读,不改 paras;直接转发 search.js 既有函数)。 */
export { computeMatches, countMatches, jumpToIndex } from './search.js';

/**
 * replaceAllInParas 非破坏版本: 返回 deltas 数组而非原地改 paras。
 * deltas: [{ i, translation, nameTr }]
 * 同时返回 { total, nameTotal }(与原签名一致)。
 */
export function replaceAllInParasDeltas(paras, q, rep, scope, cs){
  const deltas = [];
  const replaceTrans = scope === 'all' || scope === 'trans';
  const replaceName = scope === 'name';
  let total = 0, nameTotal = 0;
  for (let i = 0; i < paras.length; i++){
    const p = paras[i];
    let touched = false;
    let nextTranslation = p.translation;
    let nextNameTr = p.nameTr;
    if (replaceTrans && !p.isName){
      const tv = p.translation || '';
      if (tv.trim() !== ''){
        const c = occurrences(tv, q, cs);
        if (c > 0){
          nextTranslation = replaceAllText(tv, q, rep, cs);
          total += c;
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
          touched = true;
        }
      }
    }
    if (touched){
      deltas.push({ i, translation: nextTranslation, nameTr: nextNameTr });
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