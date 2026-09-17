// rowmenu.js — 段落行右键菜单（绑定层）
//
// 分层：
//   contextmenu.js  通用菜单渲染 / 定位 / 关闭
//   rowmenu.js      本文件 —— 段落行的菜单项定义与事件绑定
//
// 设计判断（重要）：
//   译文 textarea.trans 上【不接管】右键。接管后就必须自己实现剪切/复制/粘贴，
//   而 navigator.clipboard.readText() 在 Tauri WebView 未必有权限 —— 那是功能退化。
//   只在行的非输入区（.num 序号列 / .orig-cell 原文列 / 行空白）接管右键，
//   译文框保留浏览器原生菜单（粘贴、输入法候选、拼写检查全部照旧）。
//
// 菜单项动作用字符串 key 表达，由 main.js 注入 handlers 映射 ——
// 因此 rowMenuItems() 是无 DOM 依赖的纯函数，可单测。

import { openMenu, closeMenu, isMenuOpen } from './contextmenu.js';

/* ══════════ 纯逻辑 ══════════ */

/**
 * 按行上下文生成菜单项描述。
 *
 * @param {object} ctx
 *   index         行号（0 基）
 *   isName        是否 NAME 条目（不可机翻）
 *   hasTranslation 该行是否已有译文（决定"清空"可用性）
 *   proofMode     是否处于校对模式（决定校对三项可用性）
 *   canUndo       是否可撤销
 *   mtReady       机翻是否就绪（有 provider）
 *   tmHit         翻译记忆命中时的建议译文摘要（有值才启用「套用翻译记忆」）
 * @returns {Array} 菜单项数组，形如 { label, hint?, action?, disabled?, sep? }
 */
export function rowMenuItems(ctx) {
  const c = ctx || {};
  const isName = !!c.isName;
  const items = [];

  items.push({
    label: '复制原文到译文',
    action: 'copyOrigToTrans',
    disabled: isName,
  });
  items.push({
    label: '复制原文到剪贴板',
    action: 'copyOrig',
    disabled: false,   // 无条件可用；显式写出以保证 disabled 恒为布尔值
  });

  items.push({ sep: true });

  items.push({
    label: c.tmHit ? ('套用记忆：' + c.tmHit) : '套用翻译记忆',
    action: 'applyTm',
    disabled: !c.tmHit,
  });
  items.push({
    label: '机翻本行',
    hint: 'Ctrl+Enter',
    action: 'mtRow',
    disabled: isName || !c.mtReady,
  });
  items.push({
    label: '清空本行译文',
    action: 'clearRow',
    disabled: !c.hasTranslation,
  });

  items.push({ sep: true });

  items.push({
    label: '标记通过',
    action: 'proofApprove',
    disabled: !c.proofMode,
  });
  items.push({
    label: '标记有问题',
    action: 'proofIssue',
    disabled: !c.proofMode,
  });
  items.push({
    label: '添加批注',
    action: 'proofNotes',
    disabled: !c.proofMode,
  });

  items.push({ sep: true });

  items.push({
    label: '历史版本…',
    action: 'history',
    disabled: false,
  });
  items.push({
    label: '撤销',
    hint: 'Ctrl+Z',
    action: 'undo',
    disabled: !c.canUndo,
  });

  return items;
}

/**
 * 从事件目标向上找段落行，返回行号；找不到返回 -1。
 * 行 id 形如 'para-12'（renderer.js:244）。
 * 纯字符串解析，传入的是已经取好的 id，便于单测。
 */
export function parseRowId(id) {
  if (typeof id !== 'string') return -1;
  const m = /^para-(\d+)$/.exec(id);
  if (!m) return -1;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/**
 * 判定该次右键是否应由我们接管。
 * 输入是 target 链上的类名集合信息（由 DOM 层预先算好）。
 *
 * @param {object} info
 *   isFormField  target 是否 textarea / input（此时让位给原生菜单）
 *   rowIndex     所在行号（-1 表示不在任何行内）
 */
export function shouldTakeOver(info) {
  const i = info || {};
  if (i.isFormField) return false;
  return Number.isInteger(i.rowIndex) && i.rowIndex >= 0;
}

/* ══════════ DOM 层 ══════════ */

/**
 * 绑定段落行右键菜单。
 *
 * @param {object} opts
 *   listEl    段落列表容器（事件委托挂载点）
 *   getCtx    (index) => ctx        取该行上下文（供 rowMenuItems）
 *   handlers  { [action]: (index) => void }  动作实现，由 main.js 注入
 */
export function bindRowContextMenu(opts) {
  const o = opts || {};
  const listEl = o.listEl;
  if (!listEl || typeof document === 'undefined') return false;

  const getCtx = typeof o.getCtx === 'function' ? o.getCtx : () => ({});
  const handlers = o.handlers || {};

  listEl.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    const tag = String(target.tagName || '').toLowerCase();
    const isFormField = tag === 'textarea' || tag === 'input' || target.isContentEditable;

    const rowEl = target.closest('.para');
    const rowIndex = rowEl ? parseRowId(rowEl.id) : -1;

    if (!shouldTakeOver({ isFormField, rowIndex })) return;

    e.preventDefault();

    const items = rowMenuItems(getCtx(rowIndex)).map((it) => {
      if (it.sep) return it;
      const fn = handlers[it.action];
      return {
        label: it.label,
        hint: it.hint,
        disabled: it.disabled || typeof fn !== 'function',
        run: () => { if (typeof fn === 'function') fn(rowIndex); },
      };
    });

    openMenu(e.clientX, e.clientY, items);
  });

  return true;
}

export { closeMenu, isMenuOpen };
