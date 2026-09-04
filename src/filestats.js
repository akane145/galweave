// filestats.js — 文档完成度统计（纯逻辑，不依赖 DOM）
// 供文档标签（#tabs > .doc-tab）的分段进度条使用（规范 §7.5「完成度分段条」）。
//
// ⚠️ 状态来源（踩过坑，别再改错）：
//   运行时状态挂在 **para 对象自身** 的 `p.pr.status` 上（proof.js:65 懒初始化，
//   proof.js:402 注释明确「行级 p.pr 已随 paras 快照携带」）。
//   `annotations[p.orig] = p.pr` 只是 .proof.json 的**持久化映射**（proof.js:310），
//   不是运行时查询源。所以本模块只读 p.pr.status，不接受外部 annotations。
//
// ⚠️ 判定必须与 renderer 行内显示一致：无 pr 记录的段落 = pending（待校对）。
//
// 对规范的一处刻意偏离：
//   规范只定义了 approved/pending/issue 三段。但用户没进校对模式时全部行都是
//   pending —— 条子一色，零信息量。而翻译完成度（已译/未译）才是主线工作。
//   因此这里做**双维度**：有任何校对记录走三态，否则退回「已译/未译」两段。
//   由 hasProof 标记决定，视觉层据此选色。

/** 校对状态常量（与 proof.js:15 的 STATUS 对齐，此处独立定义以保持零依赖） */
export const APPROVED = 'approved';
export const PENDING = 'pending';
export const ISSUE = 'issue';

/**
 * 统计一个文档的完成度。
 * @param {Array} paras 段落数组（model.snapshotState().paras 或 model.getParas()）
 * @returns {{total:number, done:number, undone:number,
 *            approved:number, pending:number, issue:number, hasProof:boolean}}
 */
export function countStates(paras) {
  const out = {
    total: 0,
    done: 0, undone: 0,
    approved: 0, pending: 0, issue: 0,
    hasProof: false,
  };
  if (!Array.isArray(paras) || !paras.length) return out;

  out.total = paras.length;
  for (const p of paras) {
    if (!p) { out.undone++; out.pending++; continue; }

    // 翻译维度：直接用 model.recalcDone 写入的 p.done，不重算(避免与 model 分叉)
    if (p.done) out.done++; else out.undone++;

    // 校对维度
    const st = (p.pr && p.pr.status) || PENDING;
    if (p.pr) out.hasProof = true;
    if (st === APPROVED) out.approved++;
    else if (st === ISSUE) out.issue++;
    else out.pending++;      // pending 及任何未知状态都归入待校对
  }
  return out;
}

/**
 * 生成分段条的段落数据。
 * 有校对记录 → 三段（已定稿 / 待校对 / 有问题）
 * 无校对记录 → 两段（已译 / 未译）
 *
 * 只返回 count > 0 的段（避免 flex-grow:0 的空段吃掉 1px gap）。
 * @returns {Array<{key:string, count:number, ratio:number}>}
 */
export function segments(counts) {
  const c = counts;
  if (!c || !c.total) return [];

  const dims = c.hasProof
    ? [[APPROVED, c.approved], [PENDING, c.pending], [ISSUE, c.issue]]
    : [['done', c.done], ['undone', c.undone]];

  const out = [];
  for (const [key, n] of dims) {
    if (n > 0) out.push({ key, count: n, ratio: n / c.total });
  }
  return out;
}

/**
 * 完成度比例 0..1。
 * 有校对记录时以「已定稿」为准，否则以「已译」为准。
 */
export function ratio(counts) {
  if (!counts || !counts.total) return 0;
  const n = counts.hasProof ? counts.approved : counts.done;
  return n / counts.total;
}

/** 百分比整数（0..100），向下取整；只有真正 100% 才显示 100 */
export function percent(counts) {
  const r = ratio(counts);
  if (r >= 1) return 100;
  return Math.floor(r * 100);
}

/** 百分比文本，形如 "72%"；无数据时返回空串（此时不该画条） */
export function percentText(counts) {
  if (!hasData(counts)) return '';
  return percent(counts) + '%';
}

/** 是否 100% 完成（用于切强调色 + 条前方加圆点，规范 §7.5） */
export function isComplete(counts) {
  if (!hasData(counts)) return false;
  return counts.hasProof
    ? counts.approved === counts.total
    : counts.done === counts.total;
}

/** 是否有数据可画（决定要不要渲染分段条） */
export function hasData(counts) {
  return !!counts && counts.total > 0;
}

/** 无障碍文案，供 aria-label / title 用 */
export function summaryText(counts) {
  if (!hasData(counts)) return '暂无内容';
  if (counts.hasProof) {
    return `共 ${counts.total} 行：已定稿 ${counts.approved}，待校对 ${counts.pending}，有问题 ${counts.issue}`;
  }
  return `共 ${counts.total} 行：已译 ${counts.done}，未译 ${counts.undone}`;
}
