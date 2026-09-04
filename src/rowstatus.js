// rowstatus.js — 单行翻译状态判定(纯逻辑,无 DOM 依赖,可 node --test 单测)
//
// v3 规范 §0.3 / §7.5：四态用「形状编码 + 文字标签」双表达,不靠色区分(色觉障碍兜底)。
//   未翻译 ○  /  待校对 ◐  /  有问题 ▲  /  已定稿 ✓
//
// 判定唯一来源:
//   - p.done      : 段落是否已翻译(挂在段落对象自身,model 维护)
//   - p.pr.status : 校对三态 approved / issue / pending(挂在 p.pr,proof.js 懒初始化)
// 与 filestats.js 的双维度口径一致: 无 pr 记录的已译行 = pending(待校对)。

export const ST_TODO = 'todo';
export const ST_PENDING = 'pending';
export const ST_ISSUE = 'issue';
export const ST_APPROVED = 'approved';

/**
 * 由段落对象推算行状态信息。
 * @param {object|null} p 段落对象
 * @returns {{key:string, glyph:string, label:string, cls:string}}
 */
export function rowStatusInfo(p){
  if (!p) return { key: ST_TODO, glyph: '○', label: '未翻译', cls: ST_TODO };
  if (!p.done) return { key: ST_TODO, glyph: '○', label: '未翻译', cls: ST_TODO };

  const st = p.pr && p.pr.status;
  if (st === 'issue')    return { key: ST_ISSUE,    glyph: '▲', label: '有问题', cls: ST_ISSUE };
  if (st === 'approved') return { key: ST_APPROVED, glyph: '✓', label: '已定稿', cls: ST_APPROVED };
  return { key: ST_PENDING, glyph: '◐', label: '待校对', cls: ST_PENDING };
}

/** 仅取 cls(供 DOM className 直接拼接) */
export function rowStatusClass(p){
  return 'rs-' + rowStatusInfo(p).cls;
}
