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

/**
 * 历史版本选择器（ROADMAP P1-2）。
 * 列出一份快照清单，选中一条后点「恢复」返回该条；取消 / Esc / 点遮罩返回 null。
 *
 * 与 showConfirm 的分工：本函数只负责"选哪一条"，**恢复本身是破坏性操作**，
 * 由调用方在拿到结果后再走一次 showConfirm 写清具体后果（规范 §8.5 L3）。
 *
 * @param {Object} o
 * @param {string} [o.title]    标题
 * @param {string} [o.intro]    说明文案
 * @param {Array<{id:string,label:string,detail?:string}>} o.items
 * @returns {Promise<object|null>}
 */
export function showHistoryList({ title = '历史版本', intro = '', items = [] } = {}){
  return new Promise((resolve) => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal history-picker';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'hp-title');
      el.innerHTML =
        '<h3 class="modal-title" id="hp-title">' + esc(title) + '</h3>' +
        (intro ? '<p class="modal-body">' + esc(intro) + '</p>' : '') +
        '<div class="history-list" role="listbox" aria-label="版本列表"></div>' +
        '<div class="actions">' +
          '<button type="button" class="btn-cancel">取消</button>' +
          '<button type="button" class="btn-confirm" disabled>恢复该版本</button>' +
        '</div>';
      return el;
    });

    const listEl = modal.querySelector('.history-list');
    const ok = modal.querySelector('.btn-confirm');
    const cancel = modal.querySelector('.btn-cancel');
    let picked = null;
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unmount(mask); resolve(v); };

    const rects = Array.isArray(items) ? items : [];
    rects.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'history-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.dataset.index = String(i);

      const label = document.createElement('strong');
      label.textContent = it.label || it.id || ('版本 ' + (i + 1));
      row.appendChild(label);
      if (it.detail){
        const d = document.createElement('small');
        d.textContent = it.detail;
        row.appendChild(d);
      }
      row.addEventListener('click', () => {
        picked = it;
        for (const el of listEl.querySelectorAll('.history-item')){
          el.setAttribute('aria-selected', String(el === row));
        }
        ok.disabled = false;
      });
      // 双击直接恢复（列表类的常见操作）
      row.addEventListener('dblclick', () => { picked = it; finish(it); });
      listEl.appendChild(row);
    });

    if (!rects.length){
      const empty = document.createElement('div');
      empty.className = 'modal-body';
      empty.textContent = '这篇文档还没有历史版本。写回原文件或批量机翻时会自动留档。';
      listEl.appendChild(empty);
    }

    ok.addEventListener('click', () => { if (picked) finish(picked); });
    cancel.addEventListener('click', () => finish(null));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(null); }
    });
    // 默认焦点给取消：恢复是破坏性操作，不应一回车就执行
    requestAnimationFrame(() => cancel.focus());
  });
}

/**
 * 翻译进度统计面板（ROADMAP P2-4）。
 * 只读展示，不接收回调 —— 数据由 stats.summarize() 算好后传进来，本函数不做推算。
 *
 * @param {Object} o
 * @param {string} [o.docName]
 * @param {object} o.summary stats.summarize() 的产物
 * @returns {Promise<void>} 关闭时 resolve
 */
export function showStatsPanel({ docName = '', summary = {} } = {}){
  const s = summary || {};
  const num = (n) => (Number(n) || 0).toLocaleString();

  return new Promise((resolve) => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal stats-panel';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'st-title');

      const head = document.createElement('h3');
      head.className = 'modal-title';
      head.id = 'st-title';
      head.textContent = '翻译统计' + (docName ? ' · ' + docName : '');
      el.appendChild(head);

      // —— 四个主指标 ——
      const grid = document.createElement('div');
      grid.className = 'stats-grid';
      const kpi = (label, value, hint) => {
        const box = document.createElement('div');
        box.className = 'stats-kpi';
        const l = document.createElement('span'); l.className = 'k'; l.textContent = label;
        const v = document.createElement('strong'); v.className = 'v'; v.textContent = value;
        box.append(l, v);
        if (hint){ const h = document.createElement('small'); h.textContent = hint; box.appendChild(h); }
        return box;
      };
      grid.append(
        kpi('已完成', s.percent + '%', num(s.done) + ' / ' + num(s.total) + ' 行'),
        kpi('剩余', num(s.remaining) + ' 行'),
        kpi('日速度', s.hasSpeed ? (s.speedPerDay + ' 行/天') : '—',
          s.hasSpeed ? ('近 ' + s.sampleDays + ' 天样本') : '至少需要两天的记录'),
        kpi('预计完成', s.remaining === 0 ? '已完成' : (s.etaUnknown ? '—' : (s.etaDays + ' 天')),
          s.etaDate && s.remaining > 0 && !s.etaUnknown ? s.etaDate : ''),
      );
      el.appendChild(grid);

      // —— 来源构成 ——
      const bySrc = s.bySrc || { mt: 0, tm: 0, human: 0 };
      const totalSrc = bySrc.mt + bySrc.tm + bySrc.human;
      if (totalSrc > 0){
        const sec = document.createElement('div');
        sec.className = 'stats-section';
        const t = document.createElement('h4');
        t.textContent = '译文来源（已译 ' + num(totalSrc) + ' 行）';
        sec.appendChild(t);

        const bar = document.createElement('div');
        bar.className = 'stats-src-bar';
        const put = (key, n) => {
          if (n <= 0) return;
          const seg = document.createElement('i');
          seg.className = 'src-' + key;
          seg.style.flexGrow = String(n);
          seg.title = key + ' ' + n + ' 行';
          bar.appendChild(seg);
        };
        put('mt', bySrc.mt);
        put('tm', bySrc.tm);
        put('human', bySrc.human);
        sec.appendChild(bar);

        const legend = document.createElement('div');
        legend.className = 'stats-legend';
        const add = (key, label, n) => {
          const item = document.createElement('span');
          item.className = 'lg lg-' + key;
          item.textContent = label + ' ' + num(n) + ' 行（'
            + Math.round(n / totalSrc * 1000) / 10 + '%）';
          legend.appendChild(item);
        };
        add('mt', '机翻', bySrc.mt);
        add('tm', '记忆复用', bySrc.tm);
        add('human', '人工', bySrc.human);
        sec.appendChild(legend);
        el.appendChild(sec);
      }

      // —— 最近进度（柱=当日新增）——
      const chart = Array.isArray(s.chart) ? s.chart : [];
      if (chart.length > 0){
        const sec = document.createElement('div');
        sec.className = 'stats-section';
        const t = document.createElement('h4');
        t.textContent = '最近 ' + chart.length + ' 天（柱高 = 当日新增行数）';
        sec.appendChild(t);

        const max = Math.max(1, ...chart.map(c => c.delta));
        const wrap = document.createElement('div');
        wrap.className = 'stats-chart';
        for (const c of chart){
          const col = document.createElement('div');
          col.className = 'stats-col';
          col.title = c.date + '：累计 ' + c.done + ' 行' + (c.delta ? '（+' + c.delta + '）' : '（无变化）');
          const barEl = document.createElement('i');
          // 高度用百分比：0 新增也留 2px，否则空日看不出来
          barEl.style.height = (c.delta ? Math.max(4, Math.round(c.delta / max * 100)) : 2) + '%';
          barEl.className = c.delta ? '' : 'empty';
          const lab = document.createElement('b');
          lab.textContent = c.label;
          col.append(barEl, lab);
          wrap.appendChild(col);
        }
        sec.appendChild(wrap);
        el.appendChild(sec);
      }

      if (s.etaUnknown){
        const note = document.createElement('p');
        note.className = 'modal-body';
        note.textContent = 'ETA 需要至少两天的记录才能估算。速度按最近记录之间的累计差值折算成「行/天」，'
          + '并按日历天摊平 —— 中断几天不会把复工那天算成暴涨。只统计当前文档。';
        el.appendChild(note);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn-confirm';
      close.textContent = '关闭';
      actions.appendChild(close);
      el.appendChild(actions);
      return el;
    });

    let settled = false;
    const finish = () => { if (settled) return; settled = true; unmount(mask); resolve(); };
    modal.querySelector('.btn-confirm').addEventListener('click', finish);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(); }
    });
    requestAnimationFrame(() => modal.querySelector('.btn-confirm').focus());
  });
}

/**
 * 退出确认（三选）：存在未保存文本时关闭窗口弹出。
 * @param {Object} o
 * @param {string} [o.title]   标题
 * @param {string} [o.message] 补充说明，\n 渲染为换行
 * @returns {Promise<'save'|'discard'|'stay'>} 保存并退出 / 直接退出 / 取消(Esc/遮罩)
 */
export function showExitConfirm({ title = '有未保存的译文', message = '关闭前要把所有已打开文本写回原文件吗？' } = {}){
  return new Promise((resolve) => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal confirm';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'ex-title');
      el.innerHTML =
        '<h3 class="modal-title" id="ex-title">' + esc(title) + '</h3>' +
        '<p class="modal-body">' + esc(message).replace(/\n/g, '<br>') + '</p>' +
        '<div class="actions">' +
          '<button type="button" class="btn-cancel">取消</button>' +
          '<button type="button" class="btn-confirm danger exit-discard">直接退出</button>' +
          '<button type="button" class="btn-confirm exit-save">保存并退出</button>' +
        '</div>';
      return el;
    });
    const stay = modal.querySelector('.btn-cancel');
    const discard = modal.querySelector('.exit-discard');
    const save = modal.querySelector('.exit-save');
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unmount(mask); resolve(v); };

    stay.addEventListener('click', () => finish('stay'));
    discard.addEventListener('click', () => finish('discard'));
    save.addEventListener('click', () => finish('save'));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish('stay'); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish('stay'); }
    });
    // 默认焦点在「取消」：关闭窗口是破坏性场景，误触回车不应丢内容
    requestAnimationFrame(() => stay.focus());
  });
}
