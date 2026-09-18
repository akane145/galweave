// mock-vscode.mjs — 集成测试用的 vscode mock 与假文档/假编辑器
//
// 假文档是**可变**的，mock 的 applyEdit 会真改文本 —— 这样编辑命令能端到端验证，
// 而不是只验证"调用过 applyEdit"。
//
// loadExtension(extDir, opts) 可以指向源码目录或打包产物目录，
// 于是同一套断言既能验源码也能验 dist（打包后的导入路径改写是否真的能解析）。

import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(HERE, '../..');
export const REPO_DIR = path.resolve(EXT_DIR, '..');
export const SAMPLE_DIR = path.join(REPO_DIR, 'test text');
export const DIST_DIR = path.join(EXT_DIR, 'dist');

/* ---------------- 假文档 ---------------- */

export function fakeDocument(text, fsPath = '<test>', eolValue = 1) {
  let lines = String(text).split(/\r?\n/);
  let version = 1;
  const eolChar = () => (eolValue === 2 ? '\r\n' : '\n');
  const at = (i) => lines[i] ?? '';
  return {
    uri: { scheme: 'file', fsPath, toString: () => 'file://' + fsPath.replace(/\\/g, '/') },
    get version() { return version; },
    get eol() { return eolValue; },
    get lineCount() { return lines.length; },
    // 支持 getText()（全篇）与 getText(range)（区间）—— 真实 API 两种都有，
    // 少了区间重载会让"读取选中文本"的代码拿到整篇而不是选区
    getText(range) {
      if (!range) return lines.join(eolChar());
      const toOffset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
      const joined = lines.join('\n');
      const a = toOffset(range.start ?? range);
      const b = toOffset(range.end ?? range);
      return joined.slice(Math.min(a, b), Math.max(a, b));
    },
    lineAt: (i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: at(i).length } },
      text: at(i),
    }),
    /** 把行列坐标处的区间替换成 replacement —— 供 mock 的 applyEdit 调用 */
    _apply(range, replacement) {
      const toOffset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
      const a = toOffset(range.start), b = toOffset(range.end);
      const joined = lines.join('\n');
      lines = (joined.slice(0, a) + replacement + joined.slice(b)).split('\n');
      version++;
    },
    _lines: () => lines,
  };
}

/**
 * 构造一个贴近 VS Code 真实行为的 Selection：
 * 真实对象有 anchor/active/start/end/isEmpty，少了 start/end 会让读它们的代码炸掉 —— mock 必须补齐。
 */
export function makeSelection(active, anchor) {
  const src = anchor || active;
  const a = { line: src.line, character: src.character };
  const b = { line: active.line, character: active.character };
  const aFirst = a.line < b.line || (a.line === b.line && a.character <= b.character);
  return {
    anchor: a,
    active: b,
    start: aFirst ? a : b,
    end: aFirst ? b : a,
    get isEmpty() { return a.line === b.line && a.character === b.character; },
  };
}

export function fakeEditor(doc) {
  const calls = [];
  return {
    document: doc,
    selection: makeSelection({ line: 0, character: 0 }),
    calls,
    setDecorations(type, ranges) { calls.push({ type, ranges }); },
    revealRange() {},
  };
}

/** 取某类装饰器**最后一次**设置的区间（关掉着色时会以空数组重设） */
export function rangesFor(editor, kind) {
  const call = editor.calls.findLast(c => c.type?.options?.backgroundColor?.id === `galweave.${kind}Background`);
  return call ? call.ranges : [];
}

export function mkUri(fsPath) {
  return { scheme: 'file', fsPath, toString: () => 'file://' + String(fsPath).replace(/\\/g, '/') };
}

/* ---------------- vscode mock ---------------- */

export function makeMock(opts = {}) {
  const state = {
    settings: {
      autoHighlight: true,
      rules: [],
      rulesFile: '',
      'highlight.maxParagraphs': 3000,
      'diagnostics.enable': true,
      'diagnostics.consistency': true,
      'diagnostics.untranslated': false,
      exportEncoding: 'utf8',
      ...opts.settings,
    },
    commands: new Map(),
    output: null,
    statusItems: [],
    decoTypes: [],
    messages: [],
    warnings: [],
    errors: [],
    logs: [],
    providers: {},
    diagnostics: new Map(),
    workspaceState: new Map(),
    activeTextEditor: null,
    onActiveEditorChange: null,
    onDidChangeTextDocument: null,
    onDidCloseTextDocument: null,
    onDidSaveTextDocument: null,
    onDidChangeConfiguration: null,
    contextKeys: new Map(),
    statusMessages: [],
    onSelectionChange: null,
    quickPick: opts.quickPick || null,
    saveDialog: opts.saveDialog || null,
    written: [],
    configUpdates: [],
    warningButtons: [],
    warnPick: opts.warnPick || null,
    shownDocs: [],
    contentProviders: new Map(),
  };

  class Disposable {
    constructor(fn) { this._fn = fn; this.disposed = false; }
    dispose() { this.disposed = true; if (this._fn) this._fn(); }
  }

  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Selection {
    constructor(anchor, active) { this.anchor = anchor; this.active = active; }
  }
  class Range {
    constructor(a, b, c, d) {
      if (a instanceof Position) { this.start = a; this.end = b; }
      else { this.start = new Position(a, b); this.end = new Position(c, d); }
    }
  }

  class EventEmitter {
    constructor() { this._subs = []; this.event = (cb) => { this._subs.push(cb); return new Disposable(); }; }
    fire(v) { for (const cb of this._subs) cb(v); }
    dispose() { this._subs.length = 0; }
  }

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    EventEmitter,
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    EndOfLine: { LF: 1, CRLF: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7,
      Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
      Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22,
      Event: 23, Operator: 24, TypeParameter: 25,
    },
    CodeActionKind: { QuickFix: { value: 'quickfix' } },
    Disposable, Position, Range, Selection,
    Uri: {
      file: (p) => mkUri(p),
      joinPath: (uri, ...parts) => mkUri([String(uri.fsPath).replace(/[\\/]+$/, ''), ...parts].join('/')),
      parse: (str) => {
        const i = String(str).indexOf(':');
        return mkUri(String(str).slice(i + 1).replace(/^[/\\]+/, ''));
      },
    },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      constructor(v = '') { this.value = v; }
      appendMarkdown(s) { this.value += s; }
    },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    FoldingRange: class { constructor(start, end, kind) { this.start = start; this.end = end; this.kind = kind; } },
    DocumentSymbol: class {
      constructor(name, detail, kind, range, selectionRange) {
        Object.assign(this, { name, detail, kind, range, selectionRange });
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
    },
    CodeAction: class {
      constructor(title, kind) { this.title = title; this.kind = kind; }
    },
    WorkspaceEdit: class {
      constructor() { this.ops = []; }
      replace(uri, range, text) { this.ops.push({ kind: 'replace', uri, range, text }); }
      insert(uri, position, text) { this.ops.push({ kind: 'insert', uri, position, text }); }
    },
    window: {
      get activeTextEditor() { return state.activeTextEditor; },
      get visibleTextEditors() { return state.activeTextEditor ? [state.activeTextEditor] : []; },
      createOutputChannel() {
        const ch = {
          lines: state.logs,
          appendLine(s) { state.logs.push(s); },
          clear() { state.logs.length = 0; },
          show() {},
          dispose() {},
        };
        state.output = ch;
        return ch;
      },
      createStatusBarItem() {
        const item = {
          text: '', tooltip: '', command: '', visible: false,
          show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {},
        };
        state.statusItems.push(item);
        return item;
      },
      createTextEditorDecorationType(o) {
        const t = { options: o, dispose() {} };
        state.decoTypes.push(t);
        return t;
      },
      showInformationMessage(m) { state.messages.push(m); return Promise.resolve(undefined); },
      showWarningMessage(m, ...buttons) {
        state.warnings.push(m);
        state.warningButtons.push(buttons);
        return Promise.resolve(state.warnPick || undefined);
      },
      showErrorMessage(m) { state.errors.push(m); return Promise.resolve(undefined); },
      showQuickPick(items) { return Promise.resolve(state.quickPick ? items.find(i => i.id === state.quickPick) : undefined); },
      showSaveDialog() { return Promise.resolve(state.saveDialog || undefined); },
      showTextDocument(doc) { state.shownDocs.push(doc); return Promise.resolve({ document: doc }); },
      setStatusBarMessage(text) { state.statusMessages.push(text); return new Disposable(); },
      onDidChangeActiveTextEditor(cb) { state.onActiveEditorChange = cb; return new Disposable(); },
      onDidChangeTextEditorSelection(cb) { state.onSelectionChange = cb; return new Disposable(); },
    },
    commands: {
      registerCommand(id, fn) { state.commands.set(id, fn); return new Disposable(); },
      executeCommand(id, key, value) {
        if (id === 'setContext') { state.contextKeys.set(key, value); return Promise.resolve(); }
        return Promise.resolve(undefined);
      },
    },
    languages: {
      registerHoverProvider(sel, p) { state.providers.hover = p; return new Disposable(); },
      registerFoldingRangeProvider(sel, p) { state.providers.folding = p; return new Disposable(); },
      registerDocumentSymbolProvider(sel, p) { state.providers.symbols = p; return new Disposable(); },
      registerCodeActionsProvider(sel, p) { state.providers.codeActions = p; return new Disposable(); },
      createDiagnosticCollection() {
        return {
          set(uri, items) { state.diagnostics.set(uri.toString(), items); },
          delete(uri) { state.diagnostics.delete(uri.toString()); },
          dispose() {},
        };
      },
    },
    workspace: {
      workspaceFolders: opts.noWorkspace ? undefined : [{ uri: mkUri(EXT_DIR) }],
      textDocuments: [],
      getWorkspaceFolder() { return null; },
      getConfiguration(section) {
        return {
          get: (key, def) => (key in state.settings ? state.settings[key] : def),
          update: (key, value, target) => {
            state.configUpdates.push({ section: section || '', key, value, target });
            return Promise.resolve();
          },
        };
      },
      registerTextDocumentContentProvider(scheme, p) {
        state.contentProviders.set(scheme, p);
        return new Disposable();
      },
      openTextDocument(uri) { return Promise.resolve({ uri, getText: () => '' }); },
      findFiles() { return Promise.resolve(opts.foundFiles || []); },
      fs: {
        async readFile(uri) { return Buffer.from(fs.readFileSync(uri.fsPath)); },
        async writeFile(uri, data) {
          // 既留文本也留原始字节：导出会按源文件编码写字节，测试要比对字节
          const buf = Buffer.from(data);
          state.written.push({ path: uri.fsPath, text: buf.toString('utf8'), bytes: buf });
        },
        async readDirectory(uri) {
          return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? 2 : 1]);
        },
      },
      applyEdit(edit) {
        for (const op of edit.ops) {
          const doc = state.activeTextEditor?.document;
          if (!doc || doc.uri.toString() !== op.uri.toString()) continue;
          if (op.kind === 'replace') doc._apply(op.range, op.text);
          else doc._apply({ start: op.position, end: op.position }, op.text);
        }
        return Promise.resolve(true);
      },
      onDidChangeTextDocument(cb) { state.onDidChangeTextDocument = cb; return new Disposable(); },
      onDidCloseTextDocument(cb) { state.onDidCloseTextDocument = cb; return new Disposable(); },
      onDidSaveTextDocument(cb) { state.onDidSaveTextDocument = cb; return new Disposable(); },
      onDidChangeConfiguration(cb) { state.onDidChangeConfiguration = cb; return new Disposable(); },
    },
  };
  return { vscode, state };
}

/**
 * 把 mock 注入 require('vscode') 并激活指定目录下的扩展。
 * @param {string} extDir 扩展目录（源码目录或 dist 目录）
 */
export async function loadExtension(extDir, opts = {}) {
  const { vscode, state } = makeMock(opts);
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const require = Module.createRequire(import.meta.url);
    // 清缓存，保证每个用例都是干净的模块状态。
    // 必须**列全** vscode/ 下的文件：漏一个（比如 cursor.cjs）它会留在缓存里继续持有
    // 上一个 mock 的 vscode 实例，于是 setContext / 状态栏都写到上一个测试身上。
    const toClear = ['extension.cjs'];
    const vsDir = path.join(extDir, 'vscode');
    if (fs.existsSync(vsDir)) toClear.push(...fs.readdirSync(vsDir).map(f => 'vscode/' + f));
    for (const rel of toClear) {
      delete require.cache[path.join(extDir, rel.replace(/\//g, path.sep))];
    }
    const ext = require(path.join(extDir, 'extension.cjs'));
    const context = {
      subscriptions: [],
      extensionUri: mkUri(extDir),
      workspaceState: {
        get: (k, def) => (state.workspaceState.has(k) ? state.workspaceState.get(k) : def),
        update: (k, v) => { state.workspaceState.set(k, v); return Promise.resolve(); },
      },
    };
    await ext.activate(context);
    return { ext, state, context, vscode };
  } finally {
    Module._load = origLoad;
  }
}

/** 取某目录下已加载的 providers 模块（与扩展共享 require 缓存） */
export function requireProviders(extDir) {
  return Module.createRequire(import.meta.url)(path.join(extDir, 'vscode', 'providers.cjs'));
}

/** 把光标移到某行并触发一次刷新 */
export async function focusLine(state, editor, line) {
  editor.selection = makeSelection({ line, character: 0 });
  state.activeTextEditor = editor;
  await state.onActiveEditorChange();
}

/** 只移动光标（不重解析）并触发一次上下文键更新 —— 模拟真实的选区变化 */
export async function moveCursor(state, editor, line, character = 0) {
  editor.selection = makeSelection({ line, character });
  state.activeTextEditor = editor;
  if (state.onSelectionChange) await state.onSelectionChange();
}

/** 设置选区（非空）并触发上下文键更新 */
export async function selectRange(state, editor, start, end) {
  editor.selection = makeSelection(end, start);
  state.activeTextEditor = editor;
  if (state.onSelectionChange) await state.onSelectionChange();
}
