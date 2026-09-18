// vscode/cursor.cjs — 上下文键与行状态提示
//
// 两个职责：
//   1. 把"当前文件是不是脚本""光标所处的锁定状态""锁定开关"写成 VS Code 上下文键，
//      供 package.json 的 keybindings `when` 使用。Enter/Tab 的接管与编辑拦截全靠这些键。
//   2. 状态栏显示光标所在行的性质 —— VS Code 没有行级只读，改不动这件事只能靠"看得见"来传达。
//
// 锁定按**编辑操作**分别判定（输入 / 退格 / 删除），而不是"位置在不在可编辑区内"一刀切：
// 光标停在译文正文起点时退格会吃掉前缀、停在终点时删除会吃掉收尾的「」，这两种都得拦。
// 判定逻辑在 src/nav.js 的 blockStateAt / blockStateForSelection（纯逻辑，有单测）。
//
// 上下文键必须在每次选区变化时更新，所以这里只做廉价计算：解析结果有版本缓存，
// 判定只需读几行文本。

const vscode = require('vscode');
const core = require('./core.cjs');

const KEY = {
  isScript: 'galweave.isScript',
  onOrig: 'galweave.onOrigLine',
  onTrans: 'galweave.onTransLine',
  editBlocked: 'galweave.editBlocked',
  blockBackspace: 'galweave.blockBackspace',
  blockDelete: 'galweave.blockDelete',
  locked: 'galweave.locked',
};

let lineBar = null;
let sessionUnlocked = false;

function ensureBar() {
  if (!lineBar) {
    lineBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  }
  return lineBar;
}

/** 锁定是否生效：设置开着 且 本次会话没临时解锁 */
function isLocked() {
  return core.cfg().get('lockOriginal', true) && !sessionUnlocked;
}

/** 临时解锁/锁定（仅本次会话）。返回切换后是否处于锁定态。 */
function toggleLock() {
  sessionUnlocked = !sessionUnlocked;
  return isLocked();
}

async function setKey(key, value) {
  try {
    await vscode.commands.executeCommand('setContext', key, value);
  } catch (e) { /* 上下文键失败不该影响功能 */ }
}

const NONE = { editBlocked: false, blockBackspace: false, blockDelete: false };
const ALL = { editBlocked: true, blockBackspace: true, blockDelete: true };

async function clearAll() {
  await setKey(KEY.isScript, false);
  await setKey(KEY.onOrig, false);
  await setKey(KEY.onTrans, false);
  await setKey(KEY.editBlocked, false);
  await setKey(KEY.blockBackspace, false);
  await setKey(KEY.blockDelete, false);
  await setKey(KEY.locked, isLocked());
}

/**
 * 按当前编辑器重算上下文键与行状态提示。
 * 传入 null（没有活动编辑器）时全部置假并隐藏提示。
 */
async function update(editor) {
  const bar = ensureBar();

  if (!editor) {
    await clearAll();
    bar.hide();
    return null;
  }

  const doc = editor.document;
  const result = await core.getParsed(doc);
  if (!result) {
    await clearAll();
    bar.hide();
    return null;
  }

  const { nav } = await core.loadCore();
  const { parsed } = result;
  const sel = editor.selection;
  const line = sel.active.line;
  const role = parsed.lines[line]?.role;
  const lineTextOf = (i) => doc.lineAt(i).text;

  const locked = isLocked();
  let state = NONE;
  if (!sel.isEmpty) {
    state = nav.blockStateForSelection(parsed, {
      startLine: sel.start.line, startChar: sel.start.character,
      endLine: sel.end.line, endChar: sel.end.character,
    }, lineTextOf);
  } else if (role === 'orig' || role === 'trans') {
    state = nav.blockStateAt(parsed, line, sel.active.character, doc.lineAt(line).text);
  }
  // 解锁期间不拦任何东西，但上下文键仍反映"这里本来是被锁的"，供状态栏区分显示
  const effective = locked ? state : NONE;

  await setKey(KEY.isScript, true);
  await setKey(KEY.onOrig, role === 'orig');
  await setKey(KEY.onTrans, role === 'trans');
  await setKey(KEY.editBlocked, effective.editBlocked);
  await setKey(KEY.blockBackspace, effective.blockBackspace);
  await setKey(KEY.blockDelete, effective.blockDelete);
  await setKey(KEY.locked, locked);

  const lockMark = locked ? '$(lock)' : '$(unlock)';
  const zone = sel.isEmpty
    ? nav.lockedZoneAt(parsed, line, sel.active.character, doc.lineAt(line).text)
    : (state.editBlocked ? 'selection' : null);

  if (role === 'orig') {
    bar.text = `${lockMark} 原文行${locked ? ' · 已锁定' : ' · 未锁定'}`;
    bar.tooltip = locked
      ? '原文行整行受保护：键盘输入、粘贴、剪切、删除都会被拦下。\n\n'
        + '命令面板执行「Galweave: 开关原文锁定」可临时解锁。\n'
        + '原文被改动（拖拽等拦不住的路径）会出现在问题面板里。'
      : '原文行当前可编辑（本次会话已解锁）。命令面板可重新锁定。';
    bar.command = 'galweave.toggleLock';
    bar.show();
  } else if (role === 'trans') {
    const suffix = zone === 'trans-prefix' ? ' · 前缀已锁'
      : zone === 'trans-suffix' ? ' · 收尾括号已锁'
        : (zone === 'selection' ? ' · 选区含锁定区' : '');
    bar.text = `${lockMark} 译文行${suffix}`;
    bar.tooltip = locked
      ? '译文行只有**正文**可编辑：前缀（编号/说话人标记）与收尾的「」都锁着。\n\n'
        + 'Enter / Tab 到下一段，Shift+Tab 到上一段。'
      : '译文行当前全部可编辑（本次会话已解锁）。';
    bar.command = 'galweave.toggleLock';
    bar.show();
  } else {
    bar.hide();
  }

  return { role, locked, ...state };
}

function disposeAll() {
  lineBar?.dispose();
  lineBar = null;
}

module.exports = {
  KEY, update, isLocked, toggleLock, disposeAll,
  _setSessionUnlocked: (v) => { sessionUnlocked = !!v; },
};
