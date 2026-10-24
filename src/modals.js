import { NORM_RULES, normalizeRuleIds, validateCustomRules, normalizeText } from './textnorm.js';

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

/**
 * Anki 制卡设置弹窗。
 *
 * 与 showConfirm 的分工：本函数带表单（地址 / 牌组 / 笔记类型 / 自动标签），
 * showConfirm 只能显示文本，故单独实现。返回**配置对象**（取消返回 null）。
 *
 * @param {{conf:object, decks:string[], models:string[], status:string}} opt
 *        decks/models 为空时仍可手填（Anki 没开也能先把设置存好）
 */
export function showAnkiSettings({ conf = {}, decks = [], models = [], status = '' } = {}){
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal anki-settings';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'anki-set-title');

      // 连不上时给出可读原因，而不是让用户对着空下拉框猜
      const connected = status === 'connected';
      const note = connected
        ? '✅ 已连上 Anki，下面的牌组与笔记类型来自你的实际库。'
        : '⚠ ' + esc(String(status || '尚未连上 Anki')) + '\n可直接填写下面的项，Anki 启动后即可用。';

      // 下拉：列表里有当前值就用列表，否则把当前值作为唯一选项（允许手填后保留）
      const options = (list, cur) => {
        const all = list.length ? (list.includes(cur) ? list : [cur, ...list]) : [cur];
        return all.map(v => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
      };

      el.innerHTML =
        '<h3 id="anki-set-title" class="modal-title">Anki 制卡设置</h3>' +
        '<p class="modal-body anki-status">' + esc(note).replace(/\n/g, '<br>') + '</p>' +
        '<label for="anki-url">AnkiConnect 地址</label>' +
        '<input type="text" id="anki-url" value="' + esc(conf.url || '') + '" placeholder="http://127.0.0.1:8331">' +
        '<label for="anki-deck">牌组</label>' +
        '<select id="anki-deck">' + options(decks, conf.deck || '') + '</select>' +
        '<label for="anki-model">笔记类型</label>' +
        '<select id="anki-model">' + options(models, conf.model || '') + '</select>' +
        '<label class="check-label"><input type="checkbox" id="anki-autotags"' + (conf.autoTagsOn ? ' checked' : '') +
        '> 自动加标签（galweave / 文件名 / 项目目录）</label>' +
        '<div class="actions"><button type="button" class="btn-cancel">取消</button>' +
        '<button type="button" class="btn-confirm">保存</button></div>';
      return el;
    });

    const urlIn = modal.querySelector('#anki-url');
    const deckIn = modal.querySelector('#anki-deck');
    const modelIn = modal.querySelector('#anki-model');
    const tagsIn = modal.querySelector('#anki-autotags');
    const cancel = modal.querySelector('.btn-cancel');
    const save = modal.querySelector('.btn-confirm');
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      unmount(mask);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(v);
    };
    save.addEventListener('click', () => finish({
      url: urlIn.value.trim(),
      deck: deckIn.value,
      model: modelIn.value,
      autoTagsOn: tagsIn.checked,
    }));
    cancel.addEventListener('click', () => finish(null));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });
    mask.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ e.preventDefault(); finish(null); } });
    requestAnimationFrame(() => urlIn.focus());
  });
}

/**
 * 由词典词条加入术语表的小框。
 *
 * 为什么**不预填释义**当译名：词典释义是"解释"（如「食物を口に入れること」），
 * 不是"译名选择"。预填会让用户顺手点保存，往术语表里塞进一句解释 —— 那比空着更糟。
 * 所以译文留空等用户填，释义只作参考显示。
 *
 * @param {{src:string, definition?:string, exists?:boolean, current?:string}} opt
 * @returns {Promise<{src:string,dst:string}|null>} 取消返回 null
 */
export function showGlossQuickAdd({ src = '', definition = '', exists = false, current = '' } = {}){
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal gloss-quick-add';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'gqa-title');
      el.innerHTML =
        '<h3 id="gqa-title" class="modal-title">加入术语表</h3>' +
        (exists
          ? '<p class="modal-body gqa-exists">术语表里已有「' + esc(src) + '」（当前译名：' + esc(current || '—') + '），保存会覆盖它。</p>'
          : '') +
        '<label for="gqa-src">原文</label>' +
        '<input type="text" id="gqa-src" value="' + esc(src) + '">' +
        '<label for="gqa-dst">译名（请填写）</label>' +
        '<input type="text" id="gqa-dst" value="" placeholder="要写进术语表的译名">' +
        (definition
          ? '<label>词典释义（仅供参考，不会写入）</label><pre class="gqa-def">' + esc(definition) + '</pre>'
          : '') +
        '<p class="modal-body" id="gqa-hint">两栏都填好才能保存。译名留空时保存按钮不可用。</p>' +
        '<div class="actions"><button type="button" class="btn-cancel">取消</button>' +
        '<button type="button" class="btn-confirm">保存</button></div>';
      return el;
    });
    const srcIn = modal.querySelector('#gqa-src');
    const dstIn = modal.querySelector('#gqa-dst');
    const cancel = modal.querySelector('.btn-cancel');
    const save = modal.querySelector('.btn-confirm');
    const validate = () => { save.disabled = !srcIn.value.trim() || !dstIn.value.trim(); };
    validate();
    srcIn.addEventListener('input', validate);
    dstIn.addEventListener('input', validate);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      unmount(mask);
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    save.addEventListener('click', () => {
      if (save.disabled) return;
      finish({ src: srcIn.value.trim(), dst: dstIn.value.trim() });
    });
    mask.addEventListener('mousedown', e => { if (e.target === mask) finish(null); });
    mask.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape'){ e.preventDefault(); finish(null); }
      if (e.key === 'Enter' && !e.isComposing && !save.disabled){ e.preventDefault(); save.click(); }
    });
    requestAnimationFrame(() => dstIn.focus());
  });
}

export function showAnnotationEditor(text){
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal annotation-editor';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'annotation-edit-title');
      el.innerHTML = '<h3 id="annotation-edit-title" class="modal-title">编辑批注</h3>' +
        '<label for="annotation-edit-text">批注内容</label>' +
        '<textarea id="annotation-edit-text" rows="6" aria-describedby="annotation-edit-hint"></textarea>' +
        '<p id="annotation-edit-hint" class="modal-body">Ctrl+Enter 保存，Esc 取消。批注不能为空。</p>' +
        '<div class="actions"><button type="button" class="btn-cancel">取消</button>' +
        '<button type="button" class="btn-confirm">保存</button></div>';
      return el;
    });
    const input = modal.querySelector('textarea');
    const cancel = modal.querySelector('.btn-cancel');
    const save = modal.querySelector('.btn-confirm');
    input.value = text;
    const validate = () => { save.disabled = !input.value.trim(); };
    validate();
    input.addEventListener('input', validate);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      unmount(mask);
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    save.addEventListener('click', () => { if (input.value.trim()) finish(input.value.trim()); });
    mask.addEventListener('mousedown', e => { if (e.target === mask) finish(null); });
    mask.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape'){ e.preventDefault(); finish(null); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing){ e.preventDefault(); save.click(); }
    });
    requestAnimationFrame(() => input.focus());
  });
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 挂一个浮层到 body，返回 { mask, modal }。调用方负责在里面塞内容与接线。
function modalFocusables(modal){
  return Array.from(modal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter(el => el.offsetParent !== null);
}

function mountModal(build){
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = build(mask);
  mask.appendChild(modal);
  document.body.appendChild(mask);
  document.body.classList.add('modal-open');
  mask.setAttribute('aria-hidden', 'true');
  mask.addEventListener('keydown', (e) => {
    if (!mask.classList.contains('show') || e.key !== 'Tab') return;
    const items = modalFocusables(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first){
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last){
      e.preventDefault();
      first.focus();
    }
  });
  // 下一帧加 .show 触发入场动画，并将焦点放入动态模态。
  requestAnimationFrame(() => {
    mask.classList.add('show');
    mask.setAttribute('aria-hidden', 'false');
    const first = modalFocusables(modal)[0];
    if (first && !modal.contains(document.activeElement)) first.focus();
  });
  return { mask, modal };
}

function unmount(mask){
  mask.classList.remove('show');
  mask.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  setTimeout(() => mask.remove(), 180);
}

/**
 * 多选项模态（保存冲突、重试策略等"三选一且没有明显是非"的场景）。
 *
 * 与 showConfirm 的分工：showConfirm 是"做/不做"，本函数是"怎么做"。
 * 默认焦点固定在**第一个选项**上——调用方把最安全的那个放第一位
 * （见 fileguard.conflictChoices：另存为永远第一）。
 *
 * @param {Object} o
 * @param {string} o.title
 * @param {string} [o.message]  \n 渲染为换行
 * @param {Array<{id:string, label:string, hint?:string, danger?:boolean}>} o.choices
 * @returns {Promise<string>} 选中的 id；Esc / 点遮罩 / 取消 返回 ''（当作取消）
 */
export function showChoice({ title, message = '', choices = [], cancelText = '取消' } = {}){
  return new Promise((resolve) => {
    const list = Array.isArray(choices) ? choices.filter(c => c && c.id) : [];
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal choice';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'choice-title');
      const body = list.map(c =>
        '<button type="button" class="choice-item' + (c.danger ? ' danger' : '') + '" data-choice="' + esc(c.id) + '">' +
          '<span class="choice-label">' + esc(c.label) + '</span>' +
          (c.hint ? '<span class="choice-hint">' + esc(c.hint) + '</span>' : '') +
        '</button>'
      ).join('');
      el.innerHTML =
        '<h3 class="modal-title" id="choice-title">' + esc(title) + '</h3>' +
        (message ? '<p class="modal-body">' + esc(message).replace(/\n/g, '<br>') + '</p>' : '') +
        '<div class="choice-list">' + body + '</div>' +
        '<div class="actions"><button type="button" class="btn-cancel">' + esc(cancelText) + '</button></div>';
      return el;
    });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unmount(mask); resolve(v); };

    modal.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => finish(btn.dataset.choice));
    });
    modal.querySelector('.btn-cancel').addEventListener('click', () => finish(''));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(''); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(''); }
    });
    // 默认焦点在第一项（调用方保证那是安全项）
    requestAnimationFrame(() => {
      const first = modal.querySelector('[data-choice]');
      if (first) first.focus();
    });
  });
}

/**
 * 批量机翻任务面板：进度 + 停止 + 失败清单 + 仅重试失败行。
 *
 * 做成**常驻浮层而非 toast**：批量机翻可能跑几分钟，用户需要随时看到
 * "跑到哪了、错了几条、还剩多少"，并能立刻停下来。toast 两秒就消失了。
 *
 * 本函数只负责显示与回调，状态归 main.js 的 mt-task 任务对象 —— 因此
 * 每次刷新都从 `state` 重画，不存在两处各记一份进度而说法不一的问题。
 *
 * @param {Object} o
 * @param {string} o.title
 * @param {() => object} o.getState 取当前任务快照的渲染数据
 * @param {() => void} o.onStop    用户点「停止」
 * @param {() => void} o.onRetry   用户点「重试失败的行」
 * @param {() => void} [o.onClose] 用户关闭面板
 * @returns {{refresh:()=>void, close:()=>void}}
 */
export function showMtTaskPanel({ title = '批量机翻', getState, onStop, onRetry, onClose } = {}){
  const { mask, modal } = mountModal(() => {
    const el = document.createElement('div');
    el.className = 'modal mt-task';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mtt-title');
    el.innerHTML =
      '<h3 class="modal-title" id="mtt-title">' + esc(title) + '</h3>' +
      '<div class="mtt-progress" id="mtt-progress" role="status" aria-live="polite"></div>' +
      '<div class="mtt-bar" aria-hidden="true"><div class="mtt-bar-fill" id="mtt-bar-fill"></div></div>' +
      '<div class="mtt-fail-head" id="mtt-fail-head" hidden>失败的行（只重试这些）</div>' +
      '<div class="mtt-fail-list" id="mtt-fail-list"></div>' +
      '<div class="actions">' +
        '<button type="button" class="btn-close">关闭</button>' +
        '<button type="button" class="btn-retry" id="mtt-retry" hidden>重试失败的行</button>' +
        '<button type="button" class="btn-stop danger" id="mtt-stop">停止</button>' +
      '</div>';
    return el;
  });

  const progressEl = modal.querySelector('#mtt-progress');
  const barEl = modal.querySelector('#mtt-bar-fill');
  const failHead = modal.querySelector('#mtt-fail-head');
  const failList = modal.querySelector('#mtt-fail-list');
  const stopBtn = modal.querySelector('#mtt-stop');
  const retryBtn = modal.querySelector('#mtt-retry');
  const closeBtn = modal.querySelector('.btn-close');
  let closed = false;

  /** 从任务快照重画（每次全量重画，避免增量更新出两套说法） */
  function refresh(){
    if (closed) return;
    const st = (typeof getState === 'function' ? getState() : null) || {};
    const s = st.summary || { total: 0, done: 0, failed: 0, stopped: 0, edited: 0, pending: 0 };
    progressEl.textContent = st.progressLabel || '';
    const processed = (s.done || 0) + (s.edited || 0) + (s.failed || 0) + (s.stopped || 0);
    barEl.style.width = s.total ? Math.round((processed / s.total) * 100) + '%' : '0%';

    const failures = Array.isArray(st.failures) ? st.failures : [];
    failList.textContent = '';
    failHead.hidden = failures.length === 0;
    for (const f of failures){
      const row = document.createElement('div');
      row.className = 'mtt-fail';
      const no = document.createElement('span');
      no.className = 'mtt-fail-line';
      no.textContent = '第 ' + (f.i + 1) + ' 行';
      const why = document.createElement('span');
      why.className = 'mtt-fail-why';
      why.textContent = f.err || '未知原因';
      row.append(no, why);
      row.addEventListener('click', () => { if (typeof st.onJump === 'function') st.onJump(f.i); });
      failList.appendChild(row);
    }

    // 已经停止 → 隐藏停止按钮（再点没有意义）；有失败行 → 给重试入口
    stopBtn.hidden = !!st.finished || !!st.stopped;
    retryBtn.hidden = failures.length === 0;
    retryBtn.textContent = '重试失败的行（' + failures.length + '）';
  }

  stopBtn.addEventListener('click', () => { if (onStop) onStop(); });
  retryBtn.addEventListener('click', () => { if (onRetry) onRetry(); });
  const doClose = () => {
    if (closed) return;
    closed = true;
    unmount(mask);
    if (onClose) onClose();
  };
  closeBtn.addEventListener('click', doClose);
  // Esc 关闭面板但**不停任务** —— 批量机翻在后台继续跑是合理预期，
  // 想停就点停止按钮（有明确语义的动作不该藏在 Esc 里）。
  mask.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ e.preventDefault(); doClose(); } });

  refresh();
  return { refresh, close: doClose };
}

/**
 * 「全部替换」逐行预览：列出真正会改变的行，逐行勾选，只应用所选。
 *
 * 为什么不能沿用原生 confirm：批量替换一旦执行就没有中间地带 —— 用户看到
 * 数量却看不到内容，只能全信或全弃。预览把"哪几行、改成什么"摊开，
 * 并允许把个别例外行排除在外。
 *
 * 每行给出**只读原句与脚本编号**：同一个词在不同句子里可能该有不同的译法，
 * 只看"改前/改后"无法判断这一行该不该跟着改。原句只读展示，不参与写入。
 *
 * 与 showConfirm 的分工：本函数**不做任何写入**，只把用户选中的行号交回调用方；
 * 身份核对、撤销、脏标记与同步全部由 main.js 负责（那里才有文档上下文）。
 *
 * @param {Object} o
 * @param {string} o.title
 * @param {string} [o.message]  摘要说明，\n 渲染为换行
 * @param {Array<{i:number, label:string, ref?:string, orig?:string, before:string, after:string, count:number}>} o.rows
 *        仅包含**真正改变**的行；ref 是脚本编号，orig 是只读原句，before/after 是该字段的完整文本
 * @param {string} [o.fieldLabel='译文'] 字段名（译文 / 名字）
 * @returns {Promise<number[]|null>} 选中的行号数组；取消 / Esc / 点击遮罩返回 null
 */
export function showReplacePreview({ title, message = '', rows = [], fieldLabel = '译文' } = {}){
  const previousFocus = document.activeElement;
  return new Promise((resolve) => {
    const list = Array.isArray(rows) ? rows : [];
    const picked = new Set(list.map(r => r.i)); // 默认全选"真正改变"的行
    const { mask, modal } = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal replace-preview';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'rp-title');

      const titleEl = document.createElement('h3');
      titleEl.className = 'modal-title';
      titleEl.id = 'rp-title';
      titleEl.textContent = title;
      el.appendChild(titleEl);

      if (message){
        const msg = document.createElement('p');
        msg.className = 'modal-body';
        msg.textContent = message;
        el.appendChild(msg);
      }

      const tools = document.createElement('div');
      tools.className = 'rp-tools';
      const selAll = document.createElement('button');
      selAll.type = 'button';
      selAll.className = 'rp-select-all';
      selAll.textContent = '全选';
      const selNone = document.createElement('button');
      selNone.type = 'button';
      selNone.className = 'rp-select-none';
      selNone.textContent = '全不选';
      const count = document.createElement('span');
      count.className = 'rp-count';
      count.setAttribute('role', 'status');
      count.setAttribute('aria-live', 'polite');
      tools.append(selAll, selNone, count);
      el.appendChild(tools);

      const box = document.createElement('div');
      box.className = 'rp-list';
      // 行内容全部用 DOM 文本节点生成：译文里可能含 < > & 或控制符
      list.forEach((r) => {
        const item = document.createElement('label');
        item.className = 'rp-item';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = true;
        check.dataset.i = String(r.i);
        check.addEventListener('change', () => {
          if (check.checked) picked.add(r.i);
          else picked.delete(r.i);
          paint();
        });
        const body = document.createElement('div');
        body.className = 'rp-body';
        const head = document.createElement('div');
        head.className = 'rp-head';
        const no = document.createElement('b');
        no.textContent = r.label || ('第 ' + (r.i + 1) + ' 行');
        head.appendChild(no);
        if (r.ref){
          const ref = document.createElement('span');
          ref.className = 'rp-ref';
          ref.textContent = r.ref; // 脚本编号（如 0000 / NAME|11），只读
          ref.title = '脚本编号';
          head.appendChild(ref);
        }
        const times = document.createElement('span');
        times.className = 'rp-times';
        times.textContent = r.count > 1 ? ('替换 ' + r.count + ' 处') : '替换 1 处';
        head.appendChild(times);
        body.appendChild(head);
        // 只读原句：判断这一行该不该跟着改的依据；不参与写入
        if (r.orig !== undefined && r.orig !== null && String(r.orig) !== ''){
          const orig = document.createElement('div');
          orig.className = 'rp-line rp-orig';
          const oTag = document.createElement('span');
          oTag.className = 'rp-tag';
          oTag.textContent = '原句';
          const oTxt = document.createElement('span');
          oTxt.className = 'rp-text';
          oTxt.textContent = String(r.orig);
          orig.append(oTag, oTxt);
          body.appendChild(orig);
        }
        const before = document.createElement('div');
        before.className = 'rp-line rp-before';
        const bTag = document.createElement('span');
        bTag.className = 'rp-tag';
        bTag.textContent = '改前';
        const bTxt = document.createElement('span');
        bTxt.className = 'rp-text';
        bTxt.textContent = r.before;
        before.append(bTag, bTxt);
        const after = document.createElement('div');
        after.className = 'rp-line rp-after';
        const aTag = document.createElement('span');
        aTag.className = 'rp-tag';
        aTag.textContent = '改后';
        const aTxt = document.createElement('span');
        aTxt.className = 'rp-text';
        aTxt.textContent = r.after;
        after.append(aTag, aTxt);
        body.append(before, after);
        item.append(check, body);
        box.appendChild(item);
      });
      el.appendChild(box);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-cancel';
      cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn-confirm';
      ok.textContent = '应用所选';
      actions.append(cancel, ok);
      el.appendChild(actions);

      const paint = () => {
        let rowCount = 0, hitCount = 0;
        for (const r of list){
          if (!picked.has(r.i)) continue;
          rowCount++;
          hitCount += r.count || 1;
        }
        count.textContent = '选中 ' + rowCount + ' 行 · 替换 ' + hitCount + ' 处';
        ok.disabled = rowCount === 0;
        ok.title = rowCount === 0 ? '至少勾选一行才能应用' : ('只替换勾选的 ' + rowCount + ' 行' + fieldLabel);
      };
      selAll.addEventListener('click', () => {
        for (const r of list) picked.add(r.i);
        box.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; });
        paint();
      });
      selNone.addEventListener('click', () => {
        picked.clear();
        box.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = false; });
        paint();
      });

      el.__paint = paint; // 交由下方 wiring 首帧调用
      return el;
    });

    const ok = modal.querySelector('.btn-confirm');
    const cancel = modal.querySelector('.btn-cancel');
    if (modal.__paint) modal.__paint();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      unmount(mask);
      // 关闭后把焦点还回编辑位置：取消/全不选不写入，键盘流不该被弹窗打断
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      resolve(v);
    };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => {
      if (ok.disabled) return;
      finish(list.filter(r => picked.has(r.i)).map(r => r.i));
    });
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); finish(null); }
    });
    // 默认焦点落在取消：批量写入不可逆到这一步为止，误触回车不应直接应用
    requestAnimationFrame(() => cancel.focus());
  });
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
export function showPunctuationRules(config = {}){
  return new Promise(resolve => {
    const {mask,modal} = mountModal(() => {
      const el = document.createElement('div');
      el.className = 'modal punctuation-rules';
      el.setAttribute('role','dialog');
      el.setAttribute('aria-modal','true');
      el.setAttribute('aria-labelledby','punct-rules-title');
      el.innerHTML = '<h3 id="punct-rules-title">标点规则</h3>'
        + '<p>只处理译文。先执行勾选的内置规则，再从上到下执行自定义规则；每条执行一次，按普通文字匹配，替换为空表示删除。</p>'
        + '<div class="punct-builtins"></div><div class="punct-custom"></div>'
        + '<div class="actions"><button type="button" class="punct-add">添加规则</button><button type="button" class="punct-examples">加入示例规则</button></div>'
        + '<label for="punct-test">试用文字</label><textarea id="punct-test" rows="2">「结束。」……。……——</textarea>'
        + '<div class="punct-result" aria-live="polite"></div><p class="punct-error" role="alert"></p>'
        + '<div class="actions"><button type="button" class="btn-cancel">取消</button><button type="button" class="btn-confirm">保存规则</button></div>';
      return el;
    });
    const enabled = new Set(normalizeRuleIds(config.ids));
    const builtins = modal.querySelector('.punct-builtins');
    for (const rule of NORM_RULES){
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.value = rule.id; check.checked = enabled.has(rule.id);
      label.append(check,document.createTextNode(rule.label)); builtins.append(label);
    }
    const list = modal.querySelector('.punct-custom');
    const error = modal.querySelector('.punct-error');
    const read = () => ({ids:[...builtins.querySelectorAll('input:checked')].map(el=>el.value),customRules:validateCustomRules(
      [...list.children].map(el=>({enabled:el.querySelector('[data-enabled]').checked,from:el.querySelector('[data-from]').value,to:el.querySelector('[data-to]').value})))});
    const preview = () => {
      try { const cfg = read(); modal.querySelector('.punct-result').textContent = '结果：' + normalizeText(modal.querySelector('#punct-test').value,cfg.ids,cfg.customRules); error.textContent = ''; }
      catch(e){ error.textContent = e.message; modal.querySelector('.punct-result').textContent = ''; }
    };
    const renumber = () => [...list.children].forEach((el,i) => {
      el.querySelector('[data-enabled]').setAttribute('aria-label','启用规则 ' + (i+1));
      el.querySelector('[data-from]').setAttribute('aria-label','规则 ' + (i+1) + ' 匹配文字');
      el.querySelector('[data-to]').setAttribute('aria-label','规则 ' + (i+1) + ' 替换结果');
    });
    const add = rule => {
      const el = document.createElement('div'); el.className = 'punct-rule';
      el.innerHTML = '<input type="checkbox" data-enabled><input type="text" data-from placeholder="匹配文字" maxlength="200"><span aria-hidden="true">→</span>'
        + '<input type="text" data-to placeholder="替换结果（可留空）" maxlength="200"><button type="button" data-up aria-label="上移规则">↑</button><button type="button" data-down aria-label="下移规则">↓</button><button type="button" data-remove>删除</button>';
      el.querySelector('[data-enabled]').checked = rule.enabled !== false;
      el.querySelector('[data-from]').value = rule.from;
      el.querySelector('[data-to]').value = rule.to;
      el.querySelector('[data-up]').onclick = () => { if(el.previousElementSibling) list.insertBefore(el,el.previousElementSibling); renumber(); preview(); };
      el.querySelector('[data-down]').onclick = () => { if(el.nextElementSibling) list.insertBefore(el.nextElementSibling,el); renumber(); preview(); };
      el.querySelector('[data-remove]').onclick = () => { el.remove(); renumber(); preview(); modal.querySelector('.punct-add').focus(); };
      list.append(el); renumber(); return el;
    };
    for(const rule of config.customRules || []) add(rule);
    modal.querySelector('.punct-add').onclick = () => { add({from:'',to:''}).querySelector('[data-from]').focus(); preview(); };
    modal.querySelector('.punct-examples').onclick = () => {
      for(const rule of [{from:'。」',to:'」'},{from:'……。',to:'……'},{from:'……——',to:'……'}]){
        if (![...list.querySelectorAll('[data-from]')].some(el=>el.value === rule.from)) add(rule);
      }
      preview();
    };
    modal.addEventListener('input',preview);
    modal.addEventListener('change',preview);
    let settled = false;
    const finish = value => { if(settled) return; settled=true; unmount(mask); resolve(value); };
    modal.querySelector('.btn-cancel').onclick = () => finish(null);
    modal.querySelector('.btn-confirm').onclick = () => { try { finish(read()); } catch(e){ error.textContent=e.message; } };
    mask.addEventListener('keydown',e=>{ if(e.key === 'Escape'){ e.preventDefault(); finish(null); } });
    mask.addEventListener('mousedown',e=>{ if(e.target === mask) finish(null); });
    preview();
  });
}

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
 * 历史版本选择器。
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
 * 翻译进度统计面板。
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
