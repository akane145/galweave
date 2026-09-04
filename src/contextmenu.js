// contextmenu.js — 右键菜单（v3 视觉层 .menu 的 JS 实现）
//
// 视觉契约（src/style.css:3103+）：
//   .menu > .menu-item / .menu-sep
//   .menu 为 position:fixed，JS 只算 left/top（含视口防溢出）
//   .menu-item 用 button 元素，原生支持 :disabled 与键盘可达
//
// 菜单项形状：
//   { label, hint?, disabled?, run? }  普通项
//   { sep: true }                      分隔线
// 由调用方（main.js）按上下文提供，本模块只负责渲染、定位、关闭。
//
// 纯逻辑（normalizeItems / menuPosition）无 DOM 依赖，配 node --test。

/* ══════════ 纯逻辑 ══════════ */

/**
 * 规整菜单项：去空、合并连续分隔线、去掉首尾分隔线。
 * 全部分隔线（或空输入）时返回空数组 —— 空菜单不应该被打开。
 */
export function normalizeItems(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const out = [];
  for (const it of list) {
    if (it.sep) {
      // 仅当已有内容且上一项不是分隔线时才追加
      if (out.length && !out[out.length - 1].sep) out.push({ sep: true });
      continue;
    }
    if (!it.label) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out.every(x => x.sep) ? [] : out;
}

/**
 * 视口防溢出定位。
 * 右侧放不下则贴右边界；下方放不下则向上翻转（仍放不下则贴下边界）。
 */
export function menuPosition(x, y, w, h, vw, vh, pad = 8) {
  const P = Number.isFinite(pad) ? pad : 8;
  let left = Number(x) || 0;
  let top = Number(y) || 0;

  if (!Number.isFinite(left)) left = 0;
  if (!Number.isFinite(top)) top = 0;

  if (left + w > vw - P) left = Math.max(P, vw - w - P);
  if (top + h > vh - P) {
    const flipped = top - h;
    top = flipped >= P ? flipped : Math.max(P, vh - h - P);
  }
  return { left: Math.max(P, left), top: Math.max(P, top) };
}

/* ══════════ DOM 层 ══════════ */

let menuEl = null;

function ensureDom() {
  if (menuEl || typeof document === 'undefined') return menuEl;
  const el = document.createElement('div');
  el.className = 'menu';
  el.id = 'ctxMenu';
  el.setAttribute('role', 'menu');
  el.style.display = 'none';
  document.body.append(el);

  // 点击菜单内部不关闭；点击外部关闭
  document.addEventListener('mousedown', (e) => {
    if (!isMenuOpen()) return;
    if (menuEl.contains(e.target)) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMenuOpen()) { e.preventDefault(); closeMenu(); }
  });
  // 滚动/resize 后菜单位置会失真，直接关闭
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('scroll', () => closeMenu(), true);

  menuEl = el;
  return el;
}

export function openMenu(x, y, items) {
  const el = ensureDom();
  if (!el) return false;

  const list = normalizeItems(items);
  if (!list.length) return false;   // 空菜单不打开

  el.textContent = '';
  for (const it of list) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      el.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item';
    btn.setAttribute('role', 'menuitem');
    if (it.disabled) btn.disabled = true;

    const label = document.createElement('span');
    label.textContent = it.label;
    btn.append(label);

    if (it.hint) {
      const kbd = document.createElement('kbd');
      kbd.textContent = it.hint;
      btn.append(kbd);
    }

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      closeMenu();
      if (typeof it.run === 'function') it.run();
    });
    el.append(btn);
  }

  el.style.display = '';
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const pos = menuPosition(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
  el.style.left = pos.left + 'px';
  el.style.top = pos.top + 'px';
  return true;
}

export function closeMenu() {
  if (!menuEl) return;
  menuEl.style.display = 'none';
  menuEl.textContent = '';
}

export function isMenuOpen() {
  return !!menuEl && menuEl.style.display !== 'none';
}
