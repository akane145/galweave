// renderer.js — 窗口化渲染(虚拟滚动) + 搜索高亮 + 词条高亮 + 聚焦
// 只把视口 ± BUFFER 的行挂进 DOM,#vtop/#vbot 两个占位 div 撑起完整滚动高度;
// 行高来自 virtuallist.js 高度模型: 挂载后实测缓存,未挂载行用估算值。
// 原版“每行结构 / 交互 / 快捷键行为”保持不变。

import { transValue, buildOrigHighlights } from './parsers.js';
import { getParas } from './model.js';
import { createRowHeightModel } from './virtuallist.js';
import { currentToken } from './suggest.js';

const ROW_MAX = 400;    // textarea 最大高度(px)
const BUFFER = 10;      // 视口两侧预挂载的可见行数
const PIN_LIMIT = 60;   // 焦点行距窗口超过此行数才允许卸载(避免编辑/IME 中的行被拆掉)

/* ---------------- 状态 ---------------- */

let rows = {};          // i -> { el, num, pid, origName, orig, nameInput, trans, bOpen, bClose, copy }

const list = document.getElementById('list');
const emptyEl = document.getElementById('empty');

let heights = createRowHeightModel(0); // 行高模型(实测 + 估算 + 隐藏)
let vtop = null, vbot = null;          // 滚动高度占位(挂载窗口上方/下方)
let winStart = 0, winEnd = 0;          // 当前挂载窗口 [winStart, winEnd)
let listPadTop = 0;                    // #list 上内边距(行定位数学需扣除)
let scrollRaf = false;                 // scroll 事件 rAF 节流
let notesAutoOpen = false;             // 校对模式开启时,有批注的行默认展开批注框
const userCollapsedNotes = new Set();  // 用户手动收起过的行(之后不再自动展开)

/* ---------------- 工具 ---------------- */

function esc(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- 外部状态注入(由 main.js 提供回调,避免循环依赖) ---------------- */

let state = {
  paras: getParas,
  matches: () => [],
  matchIndex: () => -1,
  q: () => '',
  scope: () => 'all',
  terms: () => ({}),
  onTermClick: null,       // (i, text) 词条点击 → 插入译文
  onNameInput: null,       // (i, value)
  onTransInput: null,      // (i, value)
  onFocusRow: null,        // (i) 行获得焦点
  onUndoState: null,       // 撤销按钮状态
  onMTState: null,         // 机翻按钮状态
  // 校对模式回调(main.js 注入)
  proofEnabled: () => false,
  filterShowRow: () => true,
  onProofStatus: null,     // (i, 'approved' | 'issue')
  onProofAnnoAdd: null,    // (i, type, text)
  onProofAnnoResolve: null,// (i, annoId)
  onProofAnnoDelete: null, // (i, annoId)
  onProofSessionEnd: null, // (i) 译文/译名失焦 → 结算修改记录
  // 漏翻/异常行判定(main.js 注入): (i) => 'missing'|'placeholder'|'ratio'|null
  rowIssueKind: null,
  // 输入建议与划词查词(main.js 注入)
  getSuggestions: null,    // (token) => [{kind:'term'|'snippet', src, dst}]
  onSuggestionApply: null, // (i, item) 采纳建议(替换光标前词元)
  onDictLookup: null,      // (word) 划词查词 → 打开词典面板
};
export function setRendererState(partial){ Object.assign(state, partial); }

/* ---------------- 原文 HTML: 术语高亮 + 搜索高亮 合并 ---------------- */

export function renderOrigHTML(i, p, matches, terms){
  const c = p.content;
  const units = buildOrigHighlights(i, c, matches, terms);
  if (!units.length) return esc(c);
  let html = '', last = 0;
  for (const u of units){
    html += esc(c.slice(last, u.from));
    const seg = esc(c.slice(u.from, u.to));
    if (u.type === 'mark') html += '<mark>' + seg + '</mark>';
    else if (u.type === 'term') html += '<span class="term-hit" data-i="' + u.from + '" data-dst="' + esc(u.data || '') + '">' + seg + '</span>';
    else html += seg;
    last = u.to;
  }
  html += esc(c.slice(last));
  return html;
}

/* ---------------- 窗口化渲染核心 ---------------- */

/** 把 filterShowRow 同步进高度模型(隐藏行高度记 0,不挂载)。O(n),仅在载入/过滤变化时调用。 */
function syncHiddenFlags(){
  const n = state.paras().length;
  for (let i = 0; i < n; i++) heights.setHidden(i, !state.filterShowRow(i));
}

function updateSpacers(){
  if (!vtop || !vbot) return;
  vtop.style.height = heights.offsetOf(winStart) + 'px';
  vbot.style.height = Math.max(0, heights.total() - heights.offsetOf(winEnd)) + 'px';
}

/** 实测一行高度并同步占位(行内容变化后调用) */
function measureRow(i){
  const r = rows[i];
  if (!r) return;
  const h = Math.round(r.el.getBoundingClientRect().height);
  if (h > 0 && h !== heights.heightOf(i)){
    heights.setMeasured(i, h);
    updateSpacers();
  }
}

function unmountRow(i){
  const r = rows[i];
  if (r) r.el.remove();
  delete rows[i];
  if (sgRow === i) hideSuggest(); // 输入建议浮层随行卸载关闭
}

/** 计算目标挂载窗口: 视口范围 + 缓冲;焦点行在限额内钉住不卸载(防 IME/编辑中断) */
let forcePin = -1; // scrollToRow 迭代仍未命中时的强制窗口锚点(一次性)
function targetWindow(){
  const n = heights.count;
  if (!n) return { start: 0, end: 0 };
  if (forcePin >= 0){
    // 兜底: 极端估算偏差下迭代定位失败,强制以目标行为窗口起点挂载
    const start = Math.max(0, forcePin);
    const end = Math.min(n, forcePin + Math.ceil(list.clientHeight / 40) + BUFFER);
    forcePin = -1;
    return { start, end };
  }
  const t = heights.visibleRange(Math.max(0, list.scrollTop - listPadTop), list.clientHeight, BUFFER);
  const ae = document.activeElement;
  if (ae && ae !== document.body){
    let ai = -1;
    for (const k of Object.keys(rows)){
      if (rows[k].el.contains(ae)){ ai = Number(k); break; }
    }
    if (ai >= 0){
      if (ai < t.start && t.start - ai <= PIN_LIMIT) t.start = ai;
      else if (ai >= t.end && ai - t.end < PIN_LIMIT) t.end = ai + 1;
    }
  }
  return t;
}

/** 核心入口: 按当前滚动位置重算挂载窗口,卸载远处行、挂载视口侧行,实测新行并锚定滚动。
 *  force=true 时即使挂载窗口未变也重渲染窗口内已挂载行(清除/更新内联 mark/term 高亮)。 */
export function renderWindow(force){
  if (!vbot) return;
  const n = state.paras().length;
  if (n !== heights.count){
    heights.reset(n);
    syncHiddenFlags();
  }
  // 被过滤隐藏的行一律不保留在 DOM
  for (const k of Object.keys(rows)){
    if (heights.isHidden(Number(k))) unmountRow(Number(k));
  }
  const t = targetWindow();
  // 强制模式: 先重渲染窗口内已挂载行 —— mark/term 等内联 HTML 变化(清空搜索、
  // 替换后匹配重算)时,挂载窗口不变也必须重画;不卸载以保住输入框焦点
  if (force){
    for (const k of Object.keys(rows)){
      const i = Number(k);
      if (i >= t.start && i < t.end) syncRow(i);
    }
  }
  if (t.start === winStart && t.end === winEnd) return;
  // 卸载窗口外的行(实测高度保留在模型里,滚回来直接复用)
  for (const k of Object.keys(rows)){
    const i = Number(k);
    if (i < t.start || i >= t.end) unmountRow(i);
  }
  winStart = t.start; winEnd = t.end; // 先更新窗口记录,insertRowDom 以 winEnd 为扫描上界
  // 挂载窗口内缺失的行(升序 → DOM 顺序天然正确)
  const fresh = [];
  for (let i = winStart; i < winEnd; i++){
    if (heights.isHidden(i) || rows[i]) continue;
    buildRow(i);
    fresh.push(i);
  }
  // 批量实测新行(一次性布局);视口上方行高变化需补偿 scrollTop 防视口跳动
  if (fresh.length){
    const visIdx = heights.indexAt(Math.max(0, list.scrollTop - listPadTop));
    let aboveDelta = 0;
    for (const i of fresh){
      const h = rows[i].el.getBoundingClientRect().height;
      const prev = heights.heightOf(i);
      heights.setMeasured(i, h);
      if (i < visIdx) aboveDelta += h - prev;
    }
    updateSpacers();
    if (aboveDelta) list.scrollTop += aboveDelta;
  } else {
    updateSpacers();
  }
}

/** 滚动定位到某行并确保挂载。迭代定位吸收实测消除估算累积误差,最后按真实几何位置精修居中。 */
function scrollToRow(idx, center){
  const n = state.paras().length;
  if (idx < 0 || idx >= n) return;
  const centerOff = center ? Math.floor(list.clientHeight / 2) : Math.max(0, list.clientHeight - 160);
  // 迭代: 每轮按模型偏移滚动并挂载窗口,窗口实测回写模型后误差迅速收敛(通常 ≤2 轮)
  for (let pass = 0; pass < 4; pass++){
    list.scrollTop = Math.max(0, heights.offsetOf(idx) + listPadTop - centerOff);
    renderWindow();
    if (rows[idx]) break;
    if (pass === 2) forcePin = idx; // 下一轮强制以目标行为窗口起点
  }
  const r = rows[idx];
  if (!r) return; // 被过滤隐藏的行无法挂载
  const lr = list.getBoundingClientRect(), rr = r.el.getBoundingClientRect();
  const trueTop = rr.top - lr.top + list.scrollTop - listPadTop; // 行顶相对第一行顶的真实偏移
  const want = Math.max(0, trueTop + listPadTop - centerOff);
  if (Math.abs(want - list.scrollTop) > 1){
    list.scrollTop = want;
    renderWindow();
  }
}

/* ---------------- 行构建与同步 ---------------- */

/** 按下标序把行插入挂载区: 插到第一个下标更大的已挂载行之前,否则插到 #vbot 前 */
function insertRowDom(i, row){
  let ref = vbot;
  for (let k = i + 1; k < winEnd; k++){
    if (rows[k]){ ref = rows[k].el; break; }
  }
  list.insertBefore(row, ref);
}

function buildRow(i){
  const p = state.paras()[i];
  const row = document.createElement('div');
  row.className = 'para' + (p.done ? ' done' : '');
  row.id = 'para-' + i;

  // 列1: 序号 + 编号
  const num = document.createElement('div');
  num.className = 'num';
  const pid = document.createElement('span');
  pid.className = 'pid';
  num.appendChild(document.createTextNode(String(i + 1)));
  num.appendChild(pid);

  // 列2: 原文行
  const origCell = document.createElement('div');
  origCell.className = 'orig-cell';
  const origName = document.createElement('div');
  origName.className = 'orig-name';
  origName.title = '原始人名(只读)';
  const orig = document.createElement('div');
  orig.className = 'orig';
  origCell.append(origName, orig);

  const body = document.createElement('div');
  body.className = 'body';

  // 译文行
  const inputRow = document.createElement('div');
  inputRow.className = 'row-input';

  const nameInput = document.createElement('input');
  nameInput.className = 'pname-input';
  nameInput.type = 'text';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.tabIndex = -1;
  nameInput.title = '译名(可编辑;写入译文行,原文不变)';

  const bOpen = document.createElement('span');
  bOpen.className = 'bkt';
  bOpen.textContent = '「';
  const bClose = document.createElement('span');
  bClose.className = 'bkt';
  bClose.textContent = '」';

  const input = document.createElement('textarea');
  input.className = 'trans';
  input.rows = 1;
  input.wrap = 'soft';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '在此输入译文…';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制原文';

  // ---- 事件(仅创建时绑定一次) ----
  nameInput.addEventListener('input', () => {
    if (state.onNameInput) state.onNameInput(i, nameInput.value);
  });
  // 译名框与译文框一致的切行/焦点处理(否则 Tab/Enter 到 NAME 行会"卡住"无响应,
  // 且 activeIdx 不会更新)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab'){
      e.preventDefault();
      focusIdx(i + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Enter'){
      e.preventDefault();
      focusIdx(i + 1);
    }
  });
  nameInput.addEventListener('focus', () => {
    row.classList.add('active');
    activeIdx = i;
    if (state.onFocusRow) state.onFocusRow(i);
    if (selectAllOnFocus){
      selectAllOnFocus = false;
      nameInput.select();
    }
  });
  nameInput.addEventListener('blur', () => {
    row.classList.remove('active');
    if (state.onProofSessionEnd) state.onProofSessionEnd(i);
  });

  input.addEventListener('input', () => {
    if (state.onTransInput) state.onTransInput(i, input.value);
    updateSuggest(i, input); // 术语/片段输入建议
  });

  // IME 组合输入中不出建议(避免与输入法候选窗打架)
  input.addEventListener('compositionstart', () => { sgComposing = true; hideSuggest(); });
  input.addEventListener('compositionend', () => { sgComposing = false; updateSuggest(i, input); });

  input.addEventListener('keydown', (e) => {
    // 输入建议浮层打开时: Tab 采纳 / ↑↓ 选择 / Esc 关闭;Enter 保持"下一行"原语义
    if (suggestOpenFor(i)){
      if (e.key === 'Tab'){ e.preventDefault(); applySuggestAt(i, sgSel); return; }
      if (e.key === 'ArrowDown' && sgItems.length){ e.preventDefault(); sgSel = (sgSel + 1) % sgItems.length; paintSgSel(); return; }
      if (e.key === 'ArrowUp' && sgItems.length){ e.preventDefault(); sgSel = (sgSel - 1 + sgItems.length) % sgItems.length; paintSgSel(); return; }
      if (e.key === 'Escape'){ e.preventDefault(); hideSuggest(); return; }
      if (e.key === 'Enter'){ hideSuggest(); /* 继续走原切行逻辑 */ }
    }
    if (e.key === 'Tab'){
      e.preventDefault();
      focusIdx(i + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Enter'){
      e.preventDefault();
      focusIdx(i + 1);
    }
  });

  input.addEventListener('focus', () => {
    row.classList.add('active');
    activeIdx = i;
    if (state.onFocusRow) state.onFocusRow(i);
    if (selectAllOnFocus){
      selectAllOnFocus = false;
      input.select();
    }
  });
  input.addEventListener('blur', () => {
    row.classList.remove('active');
    if (sgRow === i) hideSuggest();
    // 不重置 activeIdx: 点击按钮后 textarea 失焦,但"当前行"仍应是刚才编辑的那行
    if (state.onProofSessionEnd) state.onProofSessionEnd(i);
  });

  copyBtn.addEventListener('click', () => copyText(p.content));

  // ---- 校对控件(批注数徽标 / ✓通过 / ⚠有问题 / 📝批注面板) ----
  const prBadge = document.createElement('span');
  prBadge.className = 'pr-badge';
  prBadge.title = '未解决批注数';

  const proofRow = document.createElement('div');
  proofRow.className = 'proof-row';

  const btnApprove = document.createElement('button');
  btnApprove.className = 'pr-btn pr-approve';
  btnApprove.textContent = '✓ 通过';
  btnApprove.title = '标记为已通过(再点取消)';

  const btnIssue = document.createElement('button');
  btnIssue.className = 'pr-btn pr-issue-btn';
  btnIssue.textContent = '⚠ 有问题';
  btnIssue.title = '标记为有问题(再点取消)';

  const btnNotes = document.createElement('button');
  btnNotes.className = 'pr-btn pr-notes-btn';
  btnNotes.textContent = '📝';
  btnNotes.title = '打开批注框';

  // 批注面板: 类型选择 + 输入 + 添加 + 列表
  const notes = document.createElement('div');
  notes.className = 'pr-notes hidden';
  const notesType = document.createElement('select');
  notesType.className = 'pr-notes-type';
  for (const [v, label] of Object.entries({ issue: '问题', suggestion: '建议', question: '疑问', note: '备注' })){
    const op = document.createElement('option');
    op.value = v;
    op.textContent = label;
    notesType.appendChild(op);
  }
  const notesInput = document.createElement('textarea');
  notesInput.className = 'pr-notes-input';
  notesInput.rows = 1;
  notesInput.placeholder = '输入批注，Enter 添加，Shift+Enter 换行…';
  notesInput.addEventListener('input', () => { autoResizeNotes(notesInput); measureRow(i); });
  const notesAdd = document.createElement('button');
  notesAdd.className = 'pr-btn pr-notes-add';
  notesAdd.textContent = '添加';
  const notesList = document.createElement('div');
  notesList.className = 'pr-notes-list';

  btnApprove.addEventListener('click', () => {
    if (state.onProofStatus) state.onProofStatus(i, 'approved');
    input.focus();
  });
  btnIssue.addEventListener('click', () => {
    if (state.onProofStatus) state.onProofStatus(i, 'issue');
    input.focus();
  });
  btnNotes.addEventListener('click', () => {
    notes.classList.toggle('hidden');
    btnNotes.classList.toggle('on', !notes.classList.contains('hidden'));
    if (notes.classList.contains('hidden')) userCollapsedNotes.add(i); // 手动收起 → 之后不再自动展开
    else userCollapsedNotes.delete(i);
    measureRow(i); // 面板展开/收起改变行高
    if (notes.classList.contains('hidden')) input.focus();
    else notesInput.focus();
  });
  const addNote = () => {
    const v = notesInput.value.trim();
    if (!v) return;
    if (state.onProofAnnoAdd) state.onProofAnnoAdd(i, notesType.value, v);
    notesInput.value = '';
    notesInput.focus();
  };
  notesAdd.addEventListener('click', addNote);
  notesInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); addNote(); }
  });

  proofRow.append(prBadge, btnApprove, btnIssue, btnNotes, notes);
  notes.append(notesType, notesInput, notesAdd, notesList);

  // 词条点击
  orig.addEventListener('click', (e) => {
    const hit = e.target.closest('.term-hit');
    if (hit && state.onTermClick) state.onTermClick(i, hit.getAttribute('data-dst') || '');
  });

  rows[i] = { el: row, num, pid, origName, orig, nameInput, trans: input, bOpen, bClose, copy: copyBtn, inputRow, prBadge, btnApprove, btnIssue, btnNotes, notes, notesType, notesInput, notesList, proofRow };
  // 组装 DOM: 译文输入行(译名 + [「] + 译文 + [」] + 复制) → body(原文行+译文行+校对控件) → 段落行
  inputRow.append(nameInput, input, copyBtn);
  body.append(origCell, inputRow, proofRow);
  row.append(num, body);
  insertRowDom(i, row); // 窗口化渲染: 按下标序插入挂载区
  syncRow(i);
  return rows[i];
}

// 渲染批注列表(行内)
function renderNotesList(i, r){
  if (!r) return;
  const p = state.paras()[i];
  const annos = (p && p.pr && p.pr.annotations) ? p.pr.annotations.slice() : [];
  r.notesList.innerHTML = '';
  if (!annos.length){
    const empty = document.createElement('div');
    empty.className = 'pr-empty';
    empty.textContent = '还没有批注。';
    r.notesList.appendChild(empty);
    return;
  }
  const TYPE_LABELS = { issue: '问题', suggestion: '建议', question: '疑问', note: '备注' };
  annos.slice().reverse().forEach(a => {
    const item = document.createElement('div');
    item.className = 'pr-anno' + (a.resolved ? ' resolved' : '');
    const tag = document.createElement('span');
    tag.className = 'pr-tag pr-tag-' + a.type;
    tag.textContent = TYPE_LABELS[a.type] || a.type;
    const text = document.createElement('span');
    text.className = 'pr-anno-text';
    text.textContent = a.text;
    const meta = document.createElement('span');
    meta.className = 'pr-anno-meta';
    meta.textContent = fmtAnnoTime(a.created);
    item.append(tag, text, meta);
    if (!a.resolved && state.onProofAnnoResolve){
      const btn = document.createElement('button');
      btn.className = 'pr-btn pr-anno-resolve';
      btn.textContent = '✓ 解决';
      btn.title = '解决该批注';
      btn.addEventListener('click', () => { if (state.onProofAnnoResolve) state.onProofAnnoResolve(i, a.id); });
      item.appendChild(btn);
    }
    if (state.onProofAnnoDelete){
      const btn = document.createElement('button');
      btn.className = 'pr-btn pr-anno-del';
      btn.textContent = '✕';
      btn.title = '删除该批注';
      btn.addEventListener('click', () => { if (state.onProofAnnoDelete) state.onProofAnnoDelete(i, a.id); });
      item.appendChild(btn);
    }
    r.notesList.appendChild(item);
  });
}

function fmtAnnoTime(ts){
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 由 matches 数组构建 O(1) 查找的索引(每调一次 apply 整批行,而非逐行 O(n·m)) */
function indexMatches(matches){
  const any = new Set();
  const nameRows = new Set();
  for (const m of matches){
    any.add(m.i);
    if (m.col === 'name') nameRows.add(m.i);
  }
  return { any, nameRows };
}

/** 行内应用搜索匹配类(挂载时与 applyRowMatchClasses 共用) */
function applyMatchClassesToRow(i, r, idx, currentMatchI){
  const has = idx.any.has(i);
  r.el.classList.toggle('has-match', has);
  r.el.classList.toggle('match-current', currentMatchI === i);
  r.nameInput.classList.toggle('name-match', idx.nameRows.has(i));
}

// 把 paras[i] 的数据同步到已渲染的 DOM
export function syncRow(i){
  const r = rows[i];
  const p = state.paras()[i];
  if (!r || !p) return;
  r.el.className = 'para' + (p.done ? ' done' : '');
  r.pid.textContent = p.id || '';
  r.origName.textContent = p.name || '—';
  r.origName.className = 'orig-name' + (p.name ? '' : ' empty');
  r.orig.innerHTML = renderOrigHTML(i, p, state.matches(), state.terms());
  r.nameInput.placeholder = p.name || '—';
  r.nameInput.value = p.nameTr;
  if (p.isName){
    // NAME 条目: 右侧译文框保留显示,作为左侧译名框的"跟随显示"(只读,防误输不生效);
    // 左侧译名框修改后经 nameInputHandler → refreshRow → syncRow 自动同步到这里。
    r.trans.readOnly = true;
    r.trans.value = p.nameTr;
    r.trans.placeholder = p.name || '—';
  } else {
    r.trans.readOnly = false;
    r.trans.value = transValue(p);
    r.trans.placeholder = '在此输入译文…';
  }
  if (p.brackets){
    // 「」锁定在译名与译文输入框之间: nameInput, 「, trans, 」, copy
    r.inputRow.insertBefore(r.bOpen, r.trans);
    r.inputRow.insertBefore(r.bClose, r.copy);
  } else {
    if (r.bOpen.parentNode) r.bOpen.parentNode.removeChild(r.bOpen);
    if (r.bClose.parentNode) r.bClose.parentNode.removeChild(r.bClose);
  }
  // 搜索匹配类(窗口化渲染: 新挂载的行也要带高亮)
  const _ms = state.matches();
  const _mi = state.matchIndex();
  applyMatchClassesToRow(i, r, indexMatches(_ms), Number.isFinite(_mi) && _mi >= 0 && _mi < _ms.length ? _ms[_mi].i : -1);
  // 校对状态
  const prOn = state.proofEnabled();
  const st = (p.pr && p.pr.status) || 'pending';
  r.el.classList.toggle('pr-pending', st === 'pending');
  r.el.classList.toggle('pr-approved', st === 'approved');
  r.el.classList.toggle('pr-issue', st === 'issue');
  r.el.classList.toggle('pr-on', prOn);
  // 漏翻/异常(校对 / 漏翻清单): 译文空或照抄原文 → 红条,长度异常 → 黄条(仅校对模式开启时显示,避免干扰)
  const ik = state.rowIssueKind ? state.rowIssueKind(i) : null;
  r.el.classList.toggle('pr-missing', prOn && (ik === 'missing' || ik === 'placeholder'));
  r.el.classList.toggle('pr-suspicious', prOn && ik === 'ratio');
  const uc = (p.pr && p.pr.annotations) ? p.pr.annotations.filter(a => !a.resolved).length : 0;
  r.prBadge.textContent = uc ? String(uc) : '';
  r.prBadge.classList.toggle('show', uc > 0);
  r.btnNotes.textContent = '📝' + (uc ? ' ' + uc : '');
  r.btnApprove.classList.toggle('on', st === 'approved');
  r.btnIssue.classList.toggle('on', st === 'issue');
  renderNotesList(i, r);
  // 校对模式开启且有批注 → 默认展开批注框(用户手动收起过的行除外)
  const hasNotes = !!(p.pr && p.pr.annotations && p.pr.annotations.length);
  const shouldOpen = notesAutoOpen && hasNotes && !userCollapsedNotes.has(i);
  r.notes.classList.toggle('hidden', !shouldOpen);
  r.btnNotes.classList.toggle('on', shouldOpen);
  r.el.style.display = state.filterShowRow(i) ? '' : 'none';
  autoResize(r.trans);
  measureRow(i); // 行高可能已变(译文增高/批注增减),同步高度模型与占位
}

/** 校对模式开关联动: 开启时让有批注的行默认展开批注框(关闭时不再自动展开) */
export function setNotesAutoOpen(on){
  notesAutoOpen = !!on;
  if (!on) userCollapsedNotes.clear(); // 关闭校对模式: 重置手动收起记忆,下次开启重新自动展开
}

/* ---------------- 全量重渲染 / 数据重置 ---------------- */

// 人名栏统一宽度: 取全文件最长名字(原文名 + 译名)的估算显示宽度,所有行一致;
// 范围 96~320px(名字都很短时保持 96,超长名字封顶 320 避免挤爆布局)。
function measureTextWidth(s){
  let w = 0;
  for (const ch of s){
    // CJK/全角按 1 字宽,其余按 0.6;15px 字号 + 内边距
    w += /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff]/.test(ch) ? 1 : 0.6;
  }
  return w * 15 + 18;
}
function computeNameColWidth(){
  let maxW = 0;
  for (const p of state.paras()){
    if (p.name) maxW = Math.max(maxW, measureTextWidth(p.name));
    if (p.nameTr) maxW = Math.max(maxW, measureTextWidth(p.nameTr));
  }
  return Math.max(96, Math.min(320, Math.ceil(maxW)));
}
// 缓存:仅在 paras 列表变化或名字字段结构变更时重算;搜索命中刷新不应触发 O(n) 重测
let _nameColWidthCached = null;
function applyNameColWidth(){
  if (_nameColWidthCached === null) _nameColWidthCached = computeNameColWidth() + 'px';
  list.style.setProperty('--name-col-w', _nameColWidthCached);
}
// 显式失效(打开新文件、批量改动导致名字列宽可能变化时调用)
function invalidateNameColWidth(){ _nameColWidthCached = null; }

export function fullRender(){
  const n = state.paras().length;
  // 清空旧节点,重建: 占位 vtop/vbot + 空提示
  list.innerHTML = '';
  rows = {};
  winStart = winEnd = 0;
  activeIdx = -1;
  heights.reset(n);
  invalidateNameColWidth(); // 新文件:名字列宽重测
  syncHiddenFlags();
  listPadTop = parseFloat(getComputedStyle(list).paddingTop) || 0;
  vtop = document.createElement('div');
  vtop.id = 'vtop';
  vbot = document.createElement('div');
  vbot.id = 'vbot';
  list.append(vtop, vbot, emptyEl);
  if (emptyEl) emptyEl.style.display = n ? 'none' : '';
  list.scrollTop = 0;
  applyNameColWidth(); // 按当前文件最长人名统一人名栏宽度
  // 初始窗口挂载,并用实测均值校准未挂载行的估算高度
  renderWindow();
  if (heights.measuredCount() > 0){
    const avg = Math.round(heights.avgMeasured());
    if (avg > 0 && avg !== heights.estimate){
      heights.setEstimate(avg);
      renderWindow(); // 估算变化 → 总高/范围重算
    }
  }
  updateProgress();
  updateUndoButtons();
  syncMTButtons();
}

/** 兼容旧调用:重算挂载窗口(跳转后由 main.js 调用;实参被忽略,窗口由滚动位置决定) */
export function remeasureAll(){
  // 容器宽度变化(侧栏开合/窗口缩放)导致换行改变: 放弃全部实测重测已挂载行
  listPadTop = parseFloat(getComputedStyle(list).paddingTop) || 0;
  heights.clearMeasured();
  for (const k of Object.keys(rows)) syncRow(Number(k)); // syncRow 内部会写回实测
  const avg = Math.round(heights.avgMeasured());
  if (avg > 0) heights.setEstimate(avg);
  renderWindow();
  updateSpacers();
}

/* ---------------- 自动增高 textarea ---------------- */

export function autoResize(ta){
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, ROW_MAX) + 'px';
}

// 批注输入框自动增高(上限小一些,批注无需整行那么大)
const NOTES_MAX = 96;
function autoResizeNotes(ta){
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, NOTES_MAX) + 'px';
}

/* ---------------- 聚焦 / 跳转 ---------------- */

let selectAllOnFocus = false;
let activeIdx = -1; // 最后聚焦的行(点击按钮等会触发 textarea blur,.active 类会消失,故用状态追踪)

export function focusIdx(idx){
  const n = state.paras().length;
  if (idx < 0 || idx >= n) return;
  if (!rows[idx]) scrollToRow(idx, true); // 未挂载(视口外): 先滚动挂载
  const r = rows[idx];
  if (!r) return;
  // 切行统一聚焦译文框: NAME 行的译文框是只读的,无法误编辑,整行高亮+可继续 Tab/Enter 切行;
  // 名字通过「仅名字」批量替换统一改,替换后右侧只读译文框自动跟随显示。
  selectAllOnFocus = true;
  r.trans.focus();
  if (selectAllOnFocus){ selectAllOnFocus = false; r.trans.select(); }
  scrollToRow(idx, true); // 与旧版一致: 当前行始终滚动到视口中部
}

export function scrollRowIntoView(idx){
  const n = state.paras().length;
  if (idx < 0 || idx >= n) return;
  const r = rows[idx];
  if (r){
    const lr = list.getBoundingClientRect(), rr = r.el.getBoundingClientRect();
    if (rr.top >= lr.top && rr.bottom <= lr.bottom) return; // 已完整可见
  }
  scrollToRow(idx, true);
}

/* ---------------- 顶部进度 / 撤销按钮 ---------------- */

export function updateProgress(){
  const paras = state.paras();
  const done = paras.filter(p => p.done).length;
  document.getElementById('progress').textContent =
    paras.length ? ('已翻译 ' + done + ' / ' + paras.length) : '';
}

export function updateUndoButtons(){
  if (state.onUndoState) state.onUndoState();
}

export function syncMTButtons(){
  if (state.onMTState) state.onMTState();
}

/* ---------------- 复制 ---------------- */

export function copyText(t){
  if (navigator.clipboard && window.isSecureContext){ navigator.clipboard.writeText(t).catch(()=>{}); return; }
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e){}
  document.body.removeChild(ta);
}

/* ---------------- 行 DOM 状态刷新(搜索跳转等用) ---------------- */

export function applyRowMatchClasses(matches, matchIndex){
  const idx = indexMatches(matches);
  const currentI = Number.isFinite(matchIndex) && matchIndex >= 0 && matchIndex < matches.length ? matches[matchIndex].i : -1;
  for (const k of Object.keys(rows)){
    applyMatchClassesToRow(Number(k), rows[k], idx, currentI);
  }
}

export function updateMatchInfo(matches, matchIndex, q){
  const el = document.getElementById('mcount');
  if (!el) return;
  if (!matches.length){
    el.textContent = q === '' ? '' : '0 处匹配';
  } else {
    el.textContent = (matchIndex + 1) + ' / ' + matches.length + ' 处';
  }
}

/* ---------------- 供外部用的行访问辅助 ---------------- */

/** 刷新单行 DOM(数据已变时调用;行未挂载则忽略,滚回视口时按最新数据构建) */
export function refreshRow(i){
  syncRow(i);
}

/** 获取已渲染行的元素引用(未挂载返回 undefined) */
export function getRow(i){ return rows[i]; }

/** 单行高度重测(textareas 输入后调用) */
export function remeasureRow(i){
  measureRow(i);
}

/** 当前活动(最后聚焦)行下标;无则 -1 */
export function getActiveIdx(){
  if (activeIdx >= 0 && activeIdx < state.paras().length) return activeIdx;
  return -1;
}

/** 数据/词典/术语表/过滤变化后,更新全部已挂载行并重算窗口 */
export function refreshAllRows(){
  invalidateNameColWidth(); // 批量改动可能改变名字列宽,重测一次(O(n) 仅在结构性变更时承担)
  applyNameColWidth();
  syncHiddenFlags();   // 校对过滤可能变化: 隐藏行卸载、新可见行挂载
  renderWindow();
  for (const k of Object.keys(rows)) syncRow(Number(k));
  updateSpacers();
}

/* ---------------- 滚动 / 尺寸监听 ---------------- */

list.addEventListener('scroll', () => {
  hideFab();        // 划词按钮与建议浮层锚定在可视位置,滚动即失效关闭
  hideSuggest();
  if (scrollRaf) return;
  scrollRaf = true;
  requestAnimationFrame(() => { scrollRaf = false; renderWindow(); });
}, { passive: true });

// 宽度变化(侧栏开合/窗口缩放)导致换行改变 → 全部实测作废重测
let lastListWidth = -1;
if (typeof ResizeObserver !== 'undefined'){
  new ResizeObserver((entries) => {
    const w = Math.round(entries[entries.length - 1].contentRect.width);
    const first = lastListWidth === -1;
    if (w === lastListWidth) return;
    lastListWidth = w;
    if (first || !vbot) return; // 首次观察回调,无需重排
    remeasureAll();
  }).observe(list);
}

/* ---------------- 输入建议浮层(术语/片段) ---------------- */

let sgPop = null;          // 浮层 DOM(#suggestPop)
let sgItems = [];          // 当前建议列表 [{kind, src, dst}]
let sgSel = 0;             // 键盘选中下标
let sgRow = -1;            // 建议所属行
let sgComposing = false;   // IME 组合输入中

function suggestOpenFor(i){
  return !!(sgPop && sgPop.style.display !== 'none' && sgRow === i && sgItems.length);
}

function ensureSgPop(){
  if (sgPop) return;
  sgPop = document.createElement('div');
  sgPop.id = 'suggestPop';
  sgPop.addEventListener('mousedown', (e) => e.preventDefault()); // 点击条目不抢 textarea 焦点
  document.body.appendChild(sgPop);
}

function hideSuggest(){
  if (sgPop) sgPop.style.display = 'none';
  sgItems = [];
  sgSel = 0;
  sgRow = -1;
}

function paintSgSel(){
  if (!sgPop) return;
  sgPop.querySelectorAll('.sg-item').forEach((el, k) => el.classList.toggle('sel', k === sgSel));
}

function renderSuggest(i, ta){
  ensureSgPop();
  sgPop.innerHTML = '';
  sgItems.forEach((it, k) => {
    const item = document.createElement('div');
    item.className = 'sg-item' + (k === 0 ? ' sel' : '');
    const kind = document.createElement('span');
    kind.className = 'sg-kind';
    kind.textContent = it.kind === 'snippet' ? '片段' : '术语';
    const body = document.createElement('span');
    body.className = 'sg-body';
    const b = document.createElement('b');
    b.textContent = it.src;
    body.append(b, document.createTextNode(' → ' + it.dst));
    item.append(kind, body);
    item.addEventListener('mousedown', (e) => { e.preventDefault(); applySuggestAt(i, k); });
    item.addEventListener('mousemove', () => { if (sgSel !== k){ sgSel = k; paintSgSel(); } });
    sgPop.appendChild(item);
  });
  const foot = document.createElement('div');
  foot.className = 'sg-foot';
  foot.textContent = 'Tab 采纳 · ↑↓ 选择 · Esc 关闭';
  sgPop.appendChild(foot);
  const rect = ta.getBoundingClientRect();
  sgPop.style.display = 'block';
  const w = sgPop.offsetWidth, h = sgPop.offsetHeight;
  let x = Math.max(4, Math.min(rect.left, window.innerWidth - w - 8));
  let y = rect.bottom + 2;
  if (y + h > window.innerHeight - 4) y = Math.max(4, rect.top - h - 2);
  sgPop.style.left = x + 'px';
  sgPop.style.top = y + 'px';
  sgRow = i;
}

/** 输入/组合结束后重算建议: 取光标前词元匹配术语表与片段表 */
function updateSuggest(i, ta){
  if (!state.getSuggestions || sgComposing || document.activeElement !== ta){
    hideSuggest();
    return;
  }
  const caret = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const token = currentToken(ta.value, caret);
  const items = token ? state.getSuggestions(token) : [];
  if (!items.length){ hideSuggest(); return; }
  sgItems = items;
  sgSel = 0;
  renderSuggest(i, ta);
}

function applySuggestAt(i, k){
  const item = sgItems && sgItems[k];
  hideSuggest();
  if (item && state.onSuggestionApply) state.onSuggestionApply(i, item);
}

/* ---------------- 划词查词浮层 ---------------- */

let dictFab = null;

function ensureFab(){
  if (dictFab) return;
  dictFab = document.createElement('button');
  dictFab.id = 'dictFab';
  dictFab.type = 'button';
  dictFab.textContent = '📖 查词';
  dictFab.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢选区所在元素焦点
  dictFab.addEventListener('click', () => {
    const w = dictFab.__word;
    hideFab();
    if (w && state.onDictLookup) state.onDictLookup(w);
  });
  document.body.appendChild(dictFab);
}

function hideFab(){
  if (dictFab){ dictFab.style.display = 'none'; dictFab.__word = ''; }
}

function showFab(x, y, word){
  ensureFab();
  dictFab.__word = word;
  dictFab.style.display = 'block';
  const w = dictFab.offsetWidth, h = dictFab.offsetHeight;
  dictFab.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
  dictFab.style.top = Math.max(4, Math.min(y + 6, window.innerHeight - h - 8)) + 'px';
}

/** 选中文本是否可查: 1~40 字符、无换行 */
function validWord(s){
  s = String(s || '').replace(/^\s+|\s+$/g, '');
  if (!s || s.length > 40 || /[\r\n]/.test(s)) return '';
  return s;
}

// 松开鼠标后检查选区: 译文/译名框内选区,或原文区文本选区
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  setTimeout(() => {
    if (!state.onDictLookup) return;
    const ae = document.activeElement;
    if (ae && (ae.classList.contains('trans') || ae.classList.contains('pname-input')) &&
        ae.selectionStart !== ae.selectionEnd){
      const word = validWord(ae.value.slice(ae.selectionStart, ae.selectionEnd));
      if (word){
        const r = ae.getBoundingClientRect();
        showFab(r.right, r.bottom, word);
        return;
      }
    }
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount){
      const node = sel.anchorNode;
      const inList = node && list.contains(node.nodeType === 1 ? node : node.parentNode);
      if (inList){
        const word = validWord(sel.toString());
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (word && rect && (rect.width || rect.height)){
          showFab(rect.right, rect.bottom, word);
          return;
        }
      }
    }
    hideFab();
  }, 0);
});

// 点击浮层以外区域 → 收起
document.addEventListener('mousedown', (e) => {
  if (dictFab && dictFab.style.display !== 'none' && !dictFab.contains(e.target)) hideFab();
}, true);
