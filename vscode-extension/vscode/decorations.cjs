// vscode/decorations.cjs — 语义着色
//
// 三类段落各挂一个装饰器（整行背景 + 左侧标尺标记），外加未翻译行的行尾提示。
// 颜色走 contributes.colors 注册的 ID，跟随主题明暗自动切换，也允许用户覆盖。

const vscode = require('vscode');
const core = require('./core.cjs');

const KINDS = ['name', 'dialogue', 'narration'];
const types = new Map();
let untranslated = null;

function ensureTypes() {
  if (untranslated) return;
  for (const kind of KINDS) {
    types.set(kind, vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(`galweave.${kind}Background`),
      overviewRulerColor: new vscode.ThemeColor(`galweave.${kind}Background`),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }));
  }
  untranslated = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  未翻译',
      color: new vscode.ThemeColor('galweave.untranslatedForeground'),
      fontStyle: 'italic',
    },
  });
}

function isOn() {
  if (sessionOff) return false;
  return core.cfg().get('autoHighlight', true);
}

let sessionOff = false;
function toggleSession() {
  sessionOff = !sessionOff;
  return !sessionOff;
}

function clear(editor) {
  if (!untranslated) return;
  for (const kind of KINDS) editor.setDecorations(types.get(kind), []);
  editor.setDecorations(untranslated, []);
}

/** 按解析结果给编辑器上色。传入 result 为 null 时只清空。 */
function apply(editor, result) {
  if (!editor) return null;
  if (!result) { clear(editor); return null; }

  if (!isOn()) { clear(editor); return result; }

  ensureTypes();
  const doc = editor.document;
  const cap = core.cfg().get('highlight.maxParagraphs', 3000);
  const byKind = { name: [], dialogue: [], narration: [] };
  const miss = [];

  for (const p of result.parsed.paras.slice(0, cap)) {
    const line = doc.lineAt(p.lineIndices.orig);
    byKind[p.kind].push(line.range);
    if (!p.done) miss.push(line.range);
  }

  for (const kind of KINDS) editor.setDecorations(types.get(kind), byKind[kind]);
  editor.setDecorations(untranslated, miss);
  return result;
}

function disposeAll() {
  for (const t of types.values()) t.dispose();
  types.clear();
  untranslated?.dispose();
  untranslated = null;
}

module.exports = { apply, clear, toggleSession, disposeAll, isOn, KINDS };
