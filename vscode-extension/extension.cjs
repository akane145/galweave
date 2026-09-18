// extension.cjs — VS Code 扩展入口（只做装配）
//
// 入口用 CommonJS、纯逻辑模块用动态 import() 载入：
// 扩展宿主对 ESM 入口的支持随 VS Code 版本而异，而「CJS 入口 + 动态 import ESM」
// 在从 1.85 到当前的所有版本上都成立，不必赌 ESM 入口。
//
// 分层：
//   src/*.js          纯逻辑（解析、规则、校验、导出收尾），node --test 可测，不依赖 vscode
//   vscode/core.cjs   状态与解析缓存、规则库、术语表、基线
//   vscode/decorations.cjs  语义着色
//   vscode/providers.cjs    hover / 折叠 / 大纲 / 诊断
//   vscode/commands.cjs     命令与 CodeAction
//   本文件                  注册与事件接线

const vscode = require('vscode');
const core = require('./vscode/core.cjs');
const cursor = require('./vscode/cursor.cjs');
const decorations = require('./vscode/decorations.cjs');
const providers = require('./vscode/providers.cjs');
const commands = require('./vscode/commands.cjs');
const dict = require('./vscode/dict.cjs');
const encoding = require('./vscode/encoding.cjs');

/** 是否是本扩展关心的文档：有文件路径的普通文本文档 */
function isScriptLike(doc) {
  if (!doc || doc.uri.scheme !== 'file') return false;
  return true;
}

let statusBar = null;
const timers = new Map();

function updateStatusBar(result, doc, encInfo) {
  if (!statusBar) return;
  if (!result || !result.parsed.summary.total) { statusBar.hide(); return; }
  const s = result.parsed.summary;
  const gloss = '';
  // 非 UTF-8 的文件在这里露一个后缀 —— 桌面版的文件栏也是这么标编码的
  const encMark = encInfo && encInfo.attention ? ` · ${encInfo.label}` : '';
  statusBar.text = `$(book) Galweave ${s.total} 段 · 未译 ${s.untranslated}${encMark}`;
  statusBar.tooltip = new vscode.MarkdownString(
    `**${doc.uri.fsPath}**\n\n`
    + `规则：${result.rule.label}${result.forced ? '（强制指定）' : '（自动选择）'}\n\n`
    + `段落 ${s.total}　人名 ${s.name}　对话 ${s.dialogue}　旁白 ${s.narration}\n\n`
    + `已翻译 ${s.done}　未翻译 ${s.untranslated}${gloss}\n\n`
    + (encInfo ? `编码：${encInfo.label}${encInfo.attention ? ' —— 执行「Galweave: 检查文件编码」看判定依据' : ''}\n\n` : '')
    + `点击查看「检查识别结果」`,
  );
  statusBar.show();
}

/** 装饰 + 状态栏 + 上下文键，一次到位 */
async function refreshEditor(editor) {
  if (!editor) { statusBar?.hide(); await cursor.update(null); return null; }
  const result = await core.getParsed(editor.document);
  decorations.apply(editor, result);
  // 编码检查：文件真实编码不是 UTF-8 且当前显示像乱码时提示一次（见 vscode/encoding.cjs）。
  // 失败不能影响着色/导航，所以单独兜住。
  const encInfo = await encoding.checkDocument(editor.document).catch((e) => {
    core.out().appendLine(`[编码检查失败] ${editor.document.uri.fsPath}: ${e.message}`);
    return null;
  });
  updateStatusBar(result, editor.document, encInfo);
  await commands.maybeAutoBaseline(editor.document, result);
  await cursor.update(editor);
  return result;
}

async function refreshActive() {
  return refreshEditor(vscode.window.activeTextEditor);
}

/** 文档变化：解析与诊断都要重算，但都不便宜，防抖 */
function scheduleRefresh(doc, delay = 300) {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key);
    if (editor) await refreshEditor(editor);
    providers.schedule(doc, 0);
  }, delay));
}

async function activate(context) {
  core.init(context);
  await core.loadCore();
  await core.reloadRules();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'galweave.inspectDocument';
  context.subscriptions.push(statusBar, core.out());

  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    cmd('galweave.inspectDocument', commands.cmdInspect),
    cmd('galweave.showRules', commands.cmdShowRules),
    cmd('galweave.toggleHighlight', commands.cmdToggleHighlight),
    cmd('galweave.export', commands.cmdExport),
    cmd('galweave.copyOrigToTrans', commands.cmdCopyOrigToTrans),
    cmd('galweave.insertTransLine', commands.cmdInsertTransLine),
    cmd('galweave.clearTrans', commands.cmdClearTrans),
    cmd('galweave.gotoCounterpart', commands.cmdGotoCounterpart),
    cmd('galweave.recordBaseline', commands.cmdRecordBaseline),
    cmd('galweave.clearBaseline', commands.cmdClearBaseline),
    // 逐行导航与原文锁定：Enter / Tab 换行、原文行输入拦截（keybindings 见 package.json）
    cmd('galweave.nextLine', commands.cmdNextLine),
    cmd('galweave.prevLine', commands.cmdPrevLine),
    cmd('galweave.blockEdit', commands.cmdBlockEdit),
    cmd('galweave.toggleLock', commands.cmdToggleLock),
    cmd('galweave.lookupDict', commands.cmdLookupDict),
    cmd('galweave.checkEncoding', commands.cmdCheckEncoding),
  );

  // 三个 provider 都对所有文件注册，靠 getParsed 返回 null 自动"不参与" ——
  // 用 documentSelector 限定扩展名会漏掉用户自定义的引擎文本名。
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover: (doc, pos) => provideIfScript(doc, () => providers.provideHover(doc, pos)),
    }),
    vscode.languages.registerFoldingRangeProvider({ scheme: 'file' }, {
      provideFoldingRanges: (doc) => provideIfScript(doc, () => providers.provideFoldingRanges(doc)),
    }),
    vscode.languages.registerDocumentSymbolProvider({ scheme: 'file' }, {
      provideDocumentSymbols: (doc) => provideIfScript(doc, () => providers.provideDocumentSymbols(doc)),
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions: (doc, range) => provideIfScript(doc, () => commands.provideCodeActions(doc, range)),
    }),
  );

  context.subscriptions.push(
    // 处理器直接返回 promise —— 否则异步工作成为游离 promise，既无法等待也无法捕获失败
    vscode.window.onDidChangeActiveTextEditor(() => refreshActive()),
    // 光标移动就要更新上下文键（原文锁定与 Enter/Tab 接管都靠它），必须廉价
    vscode.window.onDidChangeTextEditorSelection(() => cursor.update(vscode.window.activeTextEditor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isScriptLike(e.document)) scheduleRefresh(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimeout(timers.get(doc.uri.toString()));
      timers.delete(doc.uri.toString());
      core.invalidate(doc);
      providers.clear(doc);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      encoding.invalidate(doc.uri?.fsPath); // 存盘后字节可能变了，编码判定要重算
      providers.schedule(doc, 0);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('galweave')) return;
      await core.reloadRules();
      dict.invalidate(); // 词典路径可能变了
      for (const editor of vscode.window.visibleTextEditors) await refreshEditor(editor);
      for (const doc of vscode.workspace.textDocuments) providers.schedule(doc, 0);
    }),
  );

  context.subscriptions.push(new vscode.Disposable(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    decorations.disposeAll();
    providers.disposeAll();
    dict.disposeAll();
  }));

  await refreshActive();
  const editor = vscode.window.activeTextEditor;
  if (editor) providers.schedule(editor.document, 0);
}

/** 解析不出段落就什么都不返回，provider 等于"对该文件不生效" */
async function provideIfScript(doc, fn) {
  if (!isScriptLike(doc)) return null;
  try {
    return await fn();
  } catch (e) {
    core.out().appendLine(`[provider 失败] ${doc.uri.fsPath}: ${e.message}`);
    return null;
  }
}

function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

module.exports = { activate, deactivate };
