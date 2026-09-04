// toast.js — 轻量提示条（v3 视觉层 #toast 的 JS 实现）
// 视觉契约（src/style.css）：
//   #toast        固定顶栏下方，默认 opacity:0 + pointer-events:none
//   #toast.show   触发显示（旧层 opacity transition，新层 toast-in 动画）
//   #toast.error  警示色（var(--st-issue)），默认是成功色（var(--st-approved)）
//   CSS 侧 white-space:nowrap + text-overflow:ellipsis 兜底长文本
// 纯逻辑（normalizeMessage / nextRepeat / composeText）无 DOM 依赖，配 node --test。

const MAX_LEN = 60;      // 超过则截断，配合 CSS ellipse 兜底
const DEFAULT_MS = 2000; // 普通提示停留时长
const ERROR_MS = 3200;   // 错误提示停留更久，留出阅读时间

/**
 * 纯：归一化提示文本——压平所有空白为单空格、去首尾、超长截断。
 * CSS 是 nowrap，换行会被渲染成空格，所以在 JS 侧显式压平更可控。
 */
export function normalizeMessage(msg, max = MAX_LEN) {
  const s = String(msg ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!Number.isFinite(max) || max <= 1) return s;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 纯：连续重复消息的合并计数。
 * 批量操作（如替换 50 处）会连发同消息，用 ×N 计数避免刷屏。
 * 消息变化则计数重置为 1。
 */
export function nextRepeat(prev, count, msg) {
  if (prev === msg) {
    const n = Number(count);
    return Number.isFinite(n) && n > 0 ? n + 1 : 2;
  }
  return 1;
}

/** 纯：组装显示文本，重复次数大于 1 时补 ×N 后缀 */
export function composeText(msg, count) {
  const n = Number(count);
  return Number.isFinite(n) && n > 1 ? `${msg} ×${n}` : msg;
}

/* ---------------- DOM 层 ---------------- */

let timer = 0;
let lastText = '';
let repeats = 1;

function node() {
  return typeof document !== 'undefined' ? document.getElementById('toast') : null;
}

function hide(el) {
  el.classList.remove('show');
  lastText = '';
  repeats = 1;
}

/**
 * 显示一条提示。
 * @param {string} msg 提示内容
 * @param {{error?: boolean, duration?: number}} [opts]
 *        error=true 用警示色并延长停留；duration 可覆盖停留时长(ms)
 * @returns {boolean} 是否实际显示（无 #toast 节点或空消息时返回 false）
 */
export function toast(msg, opts = {}) {
  const text = normalizeMessage(msg);
  const el = node();
  if (!text || !el) return false;

  const isErr = opts.error === true;
  const duration = Number.isFinite(opts.duration) ? opts.duration : (isErr ? ERROR_MS : DEFAULT_MS);

  repeats = nextRepeat(lastText, repeats, text);
  lastText = text;

  el.textContent = composeText(text, repeats);
  el.classList.toggle('error', isErr);
  // 先移除再强制回流，保证连续同消息时动画能重放
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = 0;
    hide(el);
  }, duration);

  return true;
}

/** 便捷：错误提示 */
export function toastError(msg, opts = {}) {
  return toast(msg, { ...opts, error: true });
}

/** 立即收起（例如打开模态前清场） */
export function dismissToast() {
  const el = node();
  if (!el) return;
  if (timer) { clearTimeout(timer); timer = 0; }
  hide(el);
}

/** 测试用：重置内部状态 */
export function resetToastState() {
  if (timer) { clearTimeout(timer); timer = 0; }
  lastText = '';
  repeats = 1;
}
