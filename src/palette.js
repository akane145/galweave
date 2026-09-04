// palette.js — 命令面板（v3 视觉层 .palette-* 的 JS 实现）
//
// 视觉契约（src/style.css:3136+）：
//   .palette-mask > .palette > .palette-input + .palette-list > .palette-item
//   .palette-item[aria-selected="true"]  选中高亮
//   .palette-item .palette-hint          靠右显示快捷键
//   ⚠️ .palette-mask 默认 display:flex，hidden 属性会被类选择器盖掉，
//      显隐必须用内联 style（与 docs/p23-check.html 一致）
//
// 命令执行策略：触发现有按钮的 click，不重写任何业务逻辑。
// 命令表里指向的按钮若不存在（版本差异）会被自动跳过，不会报错。
//
// 纯逻辑（normalize / fuzzyScore / rankCommands / clampIndex）无 DOM 依赖，配 node --test。

/* ══════════ 纯逻辑 ══════════ */

/** 归一化：转小写、去空白。中英文混排时空白无意义 */
export function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 子序列模糊匹配打分。
 * @returns {number} >=0 匹配（分数越高越靠前），-1 不匹配
 * 加权：连续匹配 ×(1+streak*2)，词首/分隔符后 +3，越靠前分越高
 */
export function fuzzyScore(query, text) {
  const q = normalize(query);
  const t = normalize(text);
  if (!q) return 0;
  if (!t) return -1;

  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1 + streak * 2;
      // 词首（串首或跟在分隔符后）额外加权
      if (i === 0 || /[\s/・、，。（(]/.test(t[i - 1])) score += 3;
      streak++;
      qi++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

/**
 * 过滤并按分数排序。空查询返回全部且保持原始顺序。
 * 同分时按声明顺序（_i）稳定排序。
 */
export function rankCommands(query, commands) {
  const list = Array.isArray(commands) ? commands : [];
  const q = normalize(query);
  if (!q) return list.map((c, i) => ({ ...c, _i: i, score: 0 }));

  const out = [];
  list.forEach((c, i) => {
    const s = fuzzyScore(q, c.title);
    if (s >= 0) out.push({ ...c, _i: i, score: s });
  });
  out.sort((a, b) => b.score - a.score || a._i - b._i);
  return out;
}

/** 键盘导航下标，越界循环。len<=0 或非法输入一律 0 */
export function clampIndex(index, len) {
  const n = Math.floor(Number(len));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const i = Math.floor(Number(index));
  if (!Number.isFinite(i)) return 0;
  return ((i % n) + n) % n;
}

/* ══════════ 命令表 ══════════ */

/** @type {{group:string, id:string, title:string, hint?:string}[]} */
export const COMMANDS = [
  { group: '文件', id: 'btnRailImport', title: '导入文本' },
  { group: '文件', id: 'btnSave', title: '下载译文副本' },
  { group: '文件', id: 'btnSaveFile', title: '写回原文件' },
  { group: '文件', id: 'btnClearProgress', title: '清除当前文件进度' },

  { group: '编辑', id: 'btnUndo', title: '撤销', hint: 'Ctrl+Z' },
  { group: '编辑', id: 'btnRedo', title: '重做', hint: 'Ctrl+Y' },
  { group: '编辑', id: 'btnMT', title: '翻译当前行' },
  { group: '编辑', id: 'btnMTBatch', title: '批量翻译未翻译' },

  { group: '导航', id: 'btnNextTodo', title: '跳到下一个未翻译', hint: 'F2' },
  { group: '导航', id: 'btnNextIssue', title: '跳到下一处有问题' },
  { group: '导航', id: 'btnPrev', title: '上一个匹配', hint: 'Shift+F3' },
  { group: '导航', id: 'btnNext', title: '下一个匹配', hint: 'F3' },
  { group: '导航', id: 'btnJump', title: '跳转到指定行' },

  { group: '校对', id: 'btnProof', title: '开启 / 关闭校对模式' },
  { group: '校对', id: 'btnMissing', title: '漏翻 / 异常清单' },
  { group: '校对', id: 'btnProofKeys', title: '自定义校对快捷键' },

  { group: '术语表', id: 'btnGlossImport', title: '导入术语表' },
  { group: '术语表', id: 'btnGlossExport', title: '导出术语表 JSON' },
  { group: '术语表', id: 'btnGlossExportCsv', title: '导出术语表 CSV' },
  { group: '术语表', id: 'btnGlossApply', title: '应用术语表到译文' },

  { group: '词典', id: 'btnDictAddJson', title: '添加 JSON 词典' },
  { group: '词典', id: 'btnDictAddMdx', title: '加载 MDX 词典' },
  { group: '词典', id: 'btnDictAddHttp', title: '配置 HTTP 词典' },

  { group: '视图与设置', id: 'btnSidebar', title: '打开 / 收起上下文' },
  { group: '视图与设置', id: 'btnParseSet', title: '解析规则' },
  { group: '视图与设置', id: 'btnThemeModal', title: '主题与字体' },
  { group: '视图与设置', id: 'btnMTSettings', title: '机翻配置' },
];

/* ══════════ DOM 层 ══════════ */

let maskEl = null;
let inputEl = null;
let listEl = null;
let visible = [];
let sel = 0;

function ensureDom() {
  if (maskEl || typeof document === 'undefined') return maskEl;
  const mask = document.createElement('div');
  mask.className = 'palette-mask';
  mask.id = 'cmdPalette';
  mask.style.display = 'none';

  const box = document.createElement('div');
  box.className = 'palette';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '命令面板');

  const input = document.createElement('input');
  input.className = 'palette-input';
  input.type = 'text';
  input.placeholder = '输入命令…';
  input.setAttribute('aria-label', '命令输入');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'palette-list';
  list.setAttribute('role', 'listbox');

  box.append(input, list);
  mask.append(box);
  document.body.append(mask);

  maskEl = mask; inputEl = input; listEl = list;

  // 点遮罩关闭（点在面板内不关）
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) closePalette(); });
  input.addEventListener('input', () => { render(); });
  input.addEventListener('keydown', onKeydown);

  return mask;
}

function run(cmd) {
  if (!cmd) return false;
  const btn = document.getElementById(cmd.id);
  if (!btn) return false;
  btn.click();
  return true;
}

function paint() {
  if (!listEl) return;
  listEl.textContent = '';
  visible.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === sel ? 'true' : 'false');

    const label = document.createElement('span');
    label.textContent = c.title;

    const hint = document.createElement('span');
    hint.className = 'palette-hint';
    hint.textContent = c.hint || '';

    row.append(label, hint);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();          // 避免输入框失焦
      sel = i;
      if (run(c)) closePalette();
    });
    listEl.append(row);
  });
  const cur = listEl.children[sel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function render() {
  if (!inputEl) return;
  visible = rankCommands(inputEl.value, COMMANDS);
  sel = clampIndex(sel, visible.length);
  paint();
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); sel = clampIndex(sel + 1, visible.length); paint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = clampIndex(sel - 1, visible.length); paint(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = visible[sel];
    if (run(cmd)) closePalette();
    else if (inputEl) { inputEl.value = ''; render(); }   // 按钮不存在：清查询而不是静默失败
  } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
}

export function openPalette() {
  const mask = ensureDom();
  if (!mask) return false;
  mask.style.display = '';
  if (inputEl) { inputEl.value = ''; }
  sel = 0;
  render();
  if (inputEl) inputEl.focus();
  return true;
}

export function closePalette() {
  if (!maskEl) return;
  maskEl.style.display = 'none';
  if (inputEl) inputEl.value = '';
}

export function togglePalette() {
  if (maskEl && maskEl.style.display !== 'none') closePalette();
  else openPalette();
}

export function isPaletteOpen() {
  return !!maskEl && maskEl.style.display !== 'none';
}

/** 绑定全局快捷键 Ctrl+Shift+P（Ctrl+P 留给打印/其他，Shift 区分） */
export function initPalette() {
  if (typeof document === 'undefined') return;
  ensureDom();
  document.addEventListener('keydown', (e) => {
    const isToggle = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p');
    if (!isToggle) return;
    e.preventDefault();
    togglePalette();
  });
}
