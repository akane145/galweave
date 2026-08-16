// search.js — 搜索 / 替换 / 跳转(纯逻辑,不碰 DOM)
// 匹配数据: { i: 行号, col: 'orig'|'trans'|'name', from, to }
// 铁律: 替换只作用于 translation / nameTr, 从不修改 orig。

import { getParas, recalcDone } from './model.js';
import { transValue } from './parsers.js';

// 大小写敏感感知的 indexOf
export function findIdx(hay, needle, start, cs){
  const h = cs ? hay : hay.toLowerCase();
  const n = cs ? needle : needle.toLowerCase();
  return h.indexOf(n, start);
}

export function escapeRegex(s){
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 收集全部匹配,返回数组 */
export function computeMatches(paras, q, scope, cs){
  const matches = [];
  if (q === '') return matches;
  paras.forEach((p, i) => {
    if (scope === 'all' || scope === 'orig'){
      let idx = 0;
      while ((idx = findIdx(p.content, q, idx, cs)) !== -1){
        matches.push({ i, col: 'orig', from: idx, to: idx + q.length });
        idx += Math.max(q.length, 1);
      }
    }
    if (scope === 'all' || scope === 'trans'){
      let idx = 0;
      while ((idx = findIdx(p.translation, q, idx, cs)) !== -1){
        matches.push({ i, col: 'trans', from: idx, to: idx + q.length });
        idx += Math.max(q.length, 1);
      }
    }
    if (scope === 'name'){
      let idx = 0;
      while ((idx = findIdx(p.nameTr, q, idx, cs)) !== -1){
        matches.push({ i, col: 'name', from: idx, to: idx + q.length });
        idx += Math.max(q.length, 1);
      }
    }
  });
  return matches;
}

/** 对某段的某个字段做单次替换(返回是否发生) */
export function replaceOnce(p, m, rep){
  if (m.col === 'orig') return false;
  if (m.col === 'name'){
    p.nameTr = p.nameTr.slice(0, m.from) + rep + p.nameTr.slice(m.to);
    recalcDone(p); // NAME 行的 done = nameTr !== name,改完需刷新
    return true;
  }
  p.translation = p.translation.slice(0, m.from) + rep + p.translation.slice(m.to);
  p.done = transValue(p).trim() !== '';
  return true;
}

// 大小写感知的全量字符串替换(返回新串;无匹配则原样返回)
export function replaceAllText(src, find, rep, cs){
  if (find === '') return src;
  const f = cs ? find : find.toLowerCase();
  const s = cs ? src : src.toLowerCase();
  if (s.indexOf(f) === -1) return src;
  let res = '', i = 0;
  while (true){
    const j = s.indexOf(f, i);
    if (j === -1){ res += src.slice(i); break; }
    res += src.slice(i, j) + rep;
    i = j + find.length;
  }
  return res;
}

/** 全部替换。返回 { total, nameTotal }(替换前的命中次数) */
export function replaceAllInParas(paras, q, rep, scope, cs){
  if (q === '') return { total: 0, nameTotal: 0 };
  const replaceTrans = (scope === 'all' || scope === 'trans');
  const replaceName = (scope === 'name');
  let total = 0, nameTotal = 0;
  paras.forEach(p => {
    if (replaceTrans && findIdx(p.translation, q, 0, cs) !== -1){
      // 先数替换前的命中次数
      let idx = 0;
      while ((idx = findIdx(p.translation, q, idx, cs)) !== -1){ total++; idx += Math.max(q.length, 1); }
      p.translation = replaceAllText(p.translation, q, rep, cs);
      p.done = transValue(p).trim() !== '';
    }
    if (replaceName && findIdx(p.nameTr, q, 0, cs) !== -1){
      let idx = 0;
      while ((idx = findIdx(p.nameTr, q, idx, cs)) !== -1){ nameTotal++; idx += Math.max(q.length, 1); }
      p.nameTr = replaceAllText(p.nameTr, q, rep, cs);
      recalcDone(p); // NAME 行的 done = nameTr !== name,批量改完需刷新
    }
  });
  return { total, nameTotal };
}

/** 统计出现次数(替换前确认用) */
export function countMatches(paras, q, scope, cs){
  let total = 0, nameTotal = 0;
  const replaceTrans = (scope === 'all' || scope === 'trans');
  const replaceName = (scope === 'name');
  paras.forEach(p => {
    if (replaceTrans){
      let idx = 0;
      while ((idx = findIdx(p.translation, q, idx, cs)) !== -1){ total++; idx += Math.max(q.length, 1); }
    }
    if (replaceName){
      let idx = 0;
      while ((idx = findIdx(p.nameTr, q, idx, cs)) !== -1){ nameTotal++; idx += Math.max(q.length, 1); }
    }
  });
  return { total, nameTotal };
}

/**
 * 快速跳转行: 输入 3 / TEXT|0 / NAME|11
 * 1) 先按 id 末尾数字匹配; 2) 再按完整 id 忽略大小写匹配。
 * 返回 paras 下标或 -1。
 */
export function jumpToIndex(paras, v){
  const input = String(v).trim();
  if (!input) return -1;
  const n = parseInt(input, 10);
  if (!isNaN(n)){
    for (let i = 0; i < paras.length; i++){
      const m = (paras[i].id || '').match(/(\d+)\s*$/);
      if (m && parseInt(m[1], 10) === n) return i;
    }
  }
  const low = input.toLowerCase();
  for (let i = 0; i < paras.length; i++){
    if ((paras[i].id || '').toLowerCase() === low) return i;
  }
  return -1;
}

export { getParas };
