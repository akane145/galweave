// replace-apply.js — 「全部替换」预览与提交的纯逻辑（无 DOM）
//
// 为什么单独成模块：预览要展示什么、提交要写哪些字段、撤销要记录什么，
// 是三条必须一致的口径。放在 main.js 里时测试只能自写一份 applySelected 去证明，
// 结果正是 R1（只勾名字却把译文写回预览时的旧值）没被覆盖出来的原因。
// 现在 preview / 校验 / 写入都走这里，测试直接调用生产函数。
//
// 两条硬约定：
//   1. **只写本次替换的目标字段**。deltas 里两个字段都带着预览时的值，
//      但未替换的那个字段可能在预览期间被机翻或人工更新过，不能回写。
//   2. 撤销快照必须capture**提交前**两个字段的真实状态，否则撤销会把
//      另一字段恢复成更早的旧值。

import { replaceAllInParasDeltas } from './search-remote.js';

/**
 * 某替换范围实际写入的字段。
 * `replaceAllInParasDeltas` 的规则：scope 为 `name` 时只改名字，其余（all / trans）只改译文。
 */
export function replaceTargetField(scope){
  return scope === 'name' ? 'nameTr' : 'translation';
}

/**
 * 计算替换预览：只保留**真正会改变**的行（同值替换不算），并带上只读上下文。
 *
 * @param {Array} paras
 * @param {string} q 查找串
 * @param {string} rep 替换串
 * @param {'all'|'trans'|'name'} scope
 * @param {boolean} cs 区分大小写
 * @returns {{
 *   field: string,
 *   rows: Array<{i:number, ref:string, orig:string, before:string, after:string, count:number}>,
 *   total:number, nameTotal:number, grand:number
 * }}
 */
export function buildReplacePlan(paras, q, rep, scope, cs){
  const field = replaceTargetField(scope);
  const deltas = replaceAllInParasDeltas(paras, q, rep, scope, cs);
  const rows = [];
  for (const d of deltas.deltas){
    const p = paras[d.i];
    if (!p) continue;
    const before = String(p[field] || '');
    const after = String(d[field] || '');
    if (before === after) continue; // 同值替换：不是真正改变，不进预览也不产生撤销项
    rows.push({
      i: d.i,
      ref: String(p.id || ''),
      orig: String(p.content || p.orig || ''),
      before,
      after,
      count: d.count || 1,
    });
  }
  return {
    field,
    rows,
    total: deltas.total,
    nameTotal: deltas.nameTotal,
    grand: deltas.total + deltas.nameTotal,
  };
}

/**
 * 生成提交清单：过滤未勾选行，并核对每行**目标字段**的原值。
 *
 * 只核对目标字段是有意的：另一字段与本次替换无关，它在预览期间被更新
 * 不应导致整体拒绝，也不应被回写。
 *
 * @returns {{ok:true, field:string, entries:Array}|{ok:false, reason:'row-missing'|'row-changed', i:number}}
 */
export function planReplaceCommit({ paras, rows, picked, field }){
  const sel = new Set(Array.isArray(picked) ? picked : []);
  const entries = [];
  for (const row of rows){
    if (!sel.has(row.i)) continue;
    const p = paras[row.i];
    if (!p) return { ok: false, reason: 'row-missing', i: row.i };
    if (String(p[field] || '') !== row.before) return { ok: false, reason: 'row-changed', i: row.i };
    entries.push({ i: row.i, field, value: row.after, before: row.before, count: row.count });
  }
  return { ok: true, field, entries };
}

/**
 * 执行字段写入 + 行级归因。**只写 entries 指定的字段**，另一字段保持调用时的当前值。
 *
 * 归因（`p.src`）也由本函数按**同一个字段边界**决定：
 *   - 只改译名 → **不动**译文来源。原机翻草稿仍是草稿，保存时收割进 TM 仍是 draft，
 *     不会被自动扩散（R3：旧实现无条件写 human，等于把一次未复核机翻"确认"了）。
 *   - 改了译文 → 记 `human`（批量替换是人工动作），与逐行人工修改同一归因。
 *
 * 调用方必须先 `model.pushUndo(entries.map(e => e.i))` —— 撤销快照捕获提交前
 * 两个字段**与来源**的真实状态，因此一次 Ctrl+Z 能完整回退（文本与归因一致）。
 *
 * @returns {number[]} 实际写入的行号（供调用方做校对/同步/版本号 bookkeeping）
 */
export function commitReplaceEntries(paras, entries, field){
  // 同一批 entries 的字段必然一致（由 planReplaceCommit 产出）；允许调用方显式传入以让边界可见
  const targetField = field || (entries.length ? entries[0].field : '');
  const applied = [];
  for (const e of entries){
    const p = paras[e.i];
    if (!p) continue;
    p[e.field] = e.value;
    applied.push(e.i);
  }
  if (targetField === 'translation'){
    for (const i of applied) paras[i].src = 'human';
  }
  return applied;
}
