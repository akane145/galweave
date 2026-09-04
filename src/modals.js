// modals.js — 可复用浮层：模态二次确认 + 机翻结果比对（v3 视觉层 .modal-* 实现）
//
// 复用 index.html / style.css 已有的 .modal-mask > .modal 结构（P3-1 已对齐 v3）：
//   .modal-mask           固定遮罩，.show 显隐（background:var(--ov-scrim)）
//   .modal                圆角面板，bg --bg-panel，modal-in 入场动画
// 每个浮层自建焦点 / 键盘 / 遮罩点击语义——main.js 的 initModalA11y 只观察初始 DOM
// 里的 .modal-mask，动态创建的浮层需自管理，因此这里独立处理 Escape / 点遮罩 / 默认焦点。
//
// 视觉契约见 docs/ui-visual-spec.md：
//   §8.5 L3 破坏性 —— 标题写具体后果、确认按钮 danger、默认焦点在取消、Esc=取消
//   机翻比对 —— 原文（JP）| 机翻结果（ZH）并排，采用 / 放弃

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 挂一个浮层到 body，返回 { mask, modal }。调用方负责在里面塞内容与接线。
function mountModal(build){
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = build(mask);
  mask.appendChild(modal);
  document.body.appendChild(mask);
  document.body.classList.add('modal-open');
  // 下一帧加 .show 触发入场动画（与 initModalA11y 的 MutationObserver 时序一致）
  requestAnimationFrame(() => mask.classList.add('show'));
  return { mask, modal };
}

function unmount(mask){
  mask.classList.remove('show');
  document.body.classList.remove('modal-open');
  setTimeout(() => mask.remove(), 180);
}

/**
 * 模态二次确认（v3 §8.5 L3）。
 * @param {Object} o
 * @param {string} o.title      标题——必须写出具体后果（如「将清空 chapter_01.ks 的 1,204 条译文」）
 * @param {string} [o.message]  补充说明，\n 渲染为换行
 * @param {string} [o.confirmText='确认']  确认按钮文案
 * @param {string} [o.cancelText='取消']   取消按钮文案
 * @param {boolean} [o.danger=true]  确认按钮是否用 danger 样式
 * @returns {Promise<boolean>} 确认 true / 取消或 Esc 或点遮罩 false
 */
export function showConfirm({ title, message = '', confirmText = '确认', cancelText = '取消', danger = true } = {}){
  return new Promise((resolve) => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal confirm';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'mc-title');
      el.innerHTML =
        '<h3 class="modal-title" id="mc-title">' + esc(title) + '</h3>' +
        (message ? '<p class="modal-body">' + esc(message).replace(/\n/g, '<br>') + '</p>' : '') +
        '<div class="actions">' +
          '<button type="button" class="btn-cancel">' + esc(cancelText) + '</button>' +
          '<button type="button" class="btn-confirm' + (danger ? ' danger' : '') + '">' + esc(confirmText) + '</button>' +
        '</div>';
      return el;
    });
    const cancel = modal.querySelector('.btn-cancel');
    const ok = modal.querySelector('.btn-confirm');
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unmount(mask); resolve(v); };

    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    // 点遮罩空白处 = 取消（与点击关闭按钮同义）
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(false); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
    });
    // v3 §8.5 L3：默认焦点落在取消，避免误触确认造成破坏
    requestAnimationFrame(() => cancel.focus());
  });
}

/**
 * 机翻结果比对面板：原文（JP）| 机翻结果（ZH）并排，采用 / 放弃。
 * @param {Object} o
 * @param {string} o.orig    原文（日文）
 * @param {string} o.result  机翻结果（中文，已按行类型包回括号）
 * @returns {Promise<boolean>} 采用 true / 放弃或 Esc 或点遮罩 false
 */
export function showMtCompare({ orig = '', result = '' } = {}){
  return new Promise((resolve) => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal mt-compare';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'mt-title');
      el.innerHTML =
        '<h3 class="modal-title" id="mt-title">机翻结果比对</h3>' +
        '<div class="mt-compare-cols">' +
          '<div class="mt-compare-col">' +
            '<span class="mt-compare-label">原文（日文）</span>' +
            '<div class="mt-compare-text orig">' + esc(orig) + '</div>' +
          '</div>' +
          '<div class="mt-compare-col">' +
            '<span class="mt-compare-label">机翻结果（中文）</span>' +
            '<div class="mt-compare-text trans">' + esc(result) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn-cancel">放弃</button>' +
          '<button type="button" class="btn-confirm">采用</button>' +
        '</div>';
      return el;
    });
    const cancel = modal.querySelector('.btn-cancel');
    const ok = modal.querySelector('.btn-confirm');
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unmount(mask); resolve(v); };

    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(false); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
    });
    // 采用是主操作，但破坏性偏低；默认焦点给采用，方便快速采纳
    requestAnimationFrame(() => ok.focus());
  });
}
