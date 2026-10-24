import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');

function functionSource(source, name, nextMarker) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, '应能定位 ' + name);
  return source.slice(start, end);
}

test('浏览器隐藏翻译模式并回退当前模式，后续调用也不能激活隐藏模式', async () => {
  const main = await read('src/main.js');
  const makeButton = workspace => ({
    dataset: { workspace }, hidden: false, style: {}, attrs: {},
    classList: { toggle(name, enabled) { this[name] = enabled; } },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
  });
  const buttons = ['project', 'translate', 'search'].map(makeButton);
  const strip = { dataset: { panel: 'translate' } };
  const controls = new Map(['mtProvider', 'btnMTSettings', 'btnMT', 'btnMTBatch', 'mtModal'].map(id => [id, { style: {} }]));
  controls.set('commandStrip', strip);
  const document = {
    getElementById: id => controls.get(id),
    querySelector: selector => selector.includes('data-workspace="translate"') ? buttons[1] : null,
    querySelectorAll: selector => selector === '.workspace-nav-item' ? buttons : [],
  };
  const context = vm.createContext({ document, requestAnimationFrame: fn => fn(), $q: { focus() {} } });
  vm.runInContext(functionSource(main, 'syncSidebarTop', '\nfunction '), context);
  vm.runInContext(functionSource(main, 'setWorkspaceMode', '// 兼容现有快捷键调用名'), context);
  // 桌面端仍能正常进入翻译模式。
  vm.runInContext("setWorkspaceMode('translate')", context);
  assert.equal(strip.dataset.panel, 'translate');
  vm.runInContext(functionSource(main, 'hideMTUI', '/** 刷新下拉'), context);
  vm.runInContext('hideMTUI()', context);
  assert.equal(buttons[1].hidden, true);
  assert.equal(strip.dataset.panel, 'project');
  assert.equal(buttons[0].attrs['aria-current'], 'page');
  assert.equal(buttons[1].attrs['aria-current'], undefined);
  vm.runInContext("setWorkspaceMode('translate')", context);
  assert.equal(strip.dataset.panel, 'project');
  vm.runInContext("setWorkspaceMode('search')", context);
  assert.equal(strip.dataset.panel, 'search');
});

test('工作区往返切换按当前顶栏高度更新主区，搜索换行后侧栏不越过底栏', async () => {
  const main = await read('src/main.js');
  const strip = { dataset: { panel: 'project' } };
  const topbar = { get offsetHeight() { return strip.dataset.panel === 'search' ? 182 : 94; } };
  const workspace = { style: {} };
  const footer = { offsetHeight: 22 };
  const nodes = { commandStrip: strip, topbar, main: workspace };
  let searchFocused = false;
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id],
      querySelector: selector => selector === 'footer' ? footer : null,
      querySelectorAll: () => [],
    },
    requestAnimationFrame: fn => fn(),
    $q: { focus() { searchFocused = true; } },
  });
  vm.runInContext(functionSource(main, 'syncSidebarTop', '\nfunction '), context);
  vm.runInContext(functionSource(main, 'setWorkspaceMode', '// 兼容现有快捷键调用名'), context);
  vm.runInContext('syncSidebarTop()', context);
  assert.equal(workspace.style.height, 'calc(100vh - 94px - 22px)');
  vm.runInContext("setWorkspaceMode('search')", context);
  assert.equal(workspace.style.height, 'calc(100vh - 182px - 22px)');
  assert.equal(searchFocused, true);
  vm.runInContext("setWorkspaceMode('project')", context);
  assert.equal(workspace.style.height, 'calc(100vh - 94px - 22px)');
});

test('顶底栏尺寸变化自动重算主区高度，覆盖字体加载与响应式换行', async () => {
  const main = await read('src/main.js');
  const topbar = { offsetHeight: 94 };
  const footer = { offsetHeight: 22 };
  const workspace = { style: {} };
  let notifyResize;
  const observed = [];
  const document = {
    getElementById: id => ({ topbar, main: workspace })[id],
    querySelector: selector => selector === 'footer' ? footer : null,
  };
  const context = vm.createContext({
    document,
    ResizeObserver: class {
      constructor(callback) { notifyResize = callback; }
      observe(element) { observed.push(element); }
    },
  });
  vm.runInContext(functionSource(main, 'syncSidebarTop', '\nfunction '), context);
  vm.runInContext(functionSource(main, 'initWorkspaceHeightSync', '\nfunction '), context);
  vm.runInContext('initWorkspaceHeightSync()', context);
  assert.equal(workspace.style.height, 'calc(100vh - 94px - 22px)');
  assert.ok(observed.includes(topbar), '顶栏尺寸应被观察');
  assert.ok(observed.includes(footer), '底栏尺寸应被观察');
  topbar.offsetHeight = 182;
  notifyResize();
  assert.equal(workspace.style.height, 'calc(100vh - 182px - 22px)');
  footer.offsetHeight = 44;
  notifyResize();
  assert.equal(workspace.style.height, 'calc(100vh - 182px - 44px)');
  topbar.offsetHeight = 94;
  notifyResize();
  assert.equal(workspace.style.height, 'calc(100vh - 94px - 44px)');
  // 不支持观察器时仍能初始化；现有 window resize 事件继续提供后备同步。
  const fallback = vm.createContext({ document });
  vm.runInContext(functionSource(main, 'syncSidebarTop', '\nfunction '), fallback);
  vm.runInContext(functionSource(main, 'initWorkspaceHeightSync', '\nfunction '), fallback);
  vm.runInContext('initWorkspaceHeightSync()', fallback);
  assert.equal(workspace.style.height, 'calc(100vh - 94px - 44px)');
});

test('精简编码文案仍向辅助技术提供 BOM、写出差异和风险提示', async () => {
  const main = await read('src/main.js');
  const fname = { textContent: 'test.ks', dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const note = {};
  const context = vm.createContext({
    document: { getElementById: id => id === 'fname' ? fname : note },
    model: { getParas: () => [{ translation: '中文' }], getSourceEncoding: () => 'utf-8-bom' },
    currentWriteEncoding: () => 'shift-jis',
    enc: {
      encodingLabel: value => value === 'utf-8-bom' ? 'UTF-8（带 BOM）' : 'Shift-JIS',
      normalizeEncoding: value => value, looksChinese: () => true,
      encodingWarning: () => 'Shift-JIS 无法表示简体中文',
    },
  });
  vm.runInContext(functionSource(main, 'updateEncodingIndicator', '/**\n * 手动选择'), context);
  vm.runInContext('updateEncodingIndicator()', context);
  assert.equal(fname.textContent, 'test.ks · UTF-8（带 BOM） → Shift-JIS');
  for (const detail of ['UTF-8（带 BOM）', '写出编码：Shift-JIS', '无法表示简体中文']) {
    assert.ok(fname.title.includes(detail), detail);
    assert.ok(fname['aria-label'].includes(detail), detail);
  }
  vm.runInContext('updateEncodingIndicator()', context);
  assert.equal(fname.textContent, 'test.ks · UTF-8（带 BOM） → Shift-JIS', '重复刷新不应重复追加编码');
  assert.equal(note.hidden, false);
});

test('连续校对使用默认折叠的原生 disclosure，队列操作 hook 保留', async () => {
  const html = await read('index.html');
  const disclosure = html.match(/<details class="review-disclosure">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(disclosure, '默认没有 open 属性');
  assert.match(disclosure, /<summary>连续校对<\/summary>/);
  for (const id of ['reviewQueueKind', 'reviewQueueCategory', 'reviewQueueCount', 'btnReviewPrev', 'btnReviewNext', 'btnReviewApprove']) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
});

test('侧栏头部图标动作有名称，状态栏常驻五个快捷键', async () => {
  const html = await read('index.html');
  const actions = html.match(/<div class="side-head-actions">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(actions);
  for (const id of ['btnReturnToEditor', 'btnSidebarClose']) {
    assert.match(actions, new RegExp(`id="${id}"[^>]+aria-label="[^\"]+"[^>]+title="[^\"]+"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  const footer = html.match(/<footer id="statusbar">([\s\S]*?)<\/footer>/)[1];
  assert.deepEqual([...footer.matchAll(/<kbd>(.*?)<\/kbd>/g)].map(match => match[1]), ['Tab', 'Enter', 'F2', 'Ctrl+S', 'Ctrl+F']);
});

test('主工作区提供跳过链接与 main landmark', async () => {
  const html = await read('index.html');
  assert.match(html, /<a[^>]+class="skip-link"[^>]+href="#main"/);
  assert.match(html, /<main[^>]+id="main"/);
});

test('搜索与导航输入拥有显式可访问标签', async () => {
  const html = await read('index.html');
  for (const id of ['q', 'r', 'scope', 'jumpInput']) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`), `missing label for ${id}`);
  }
});

test('图标按钮使用语义化 aria-label', async () => {
  const html = await read('index.html');
  assert.match(html, /id="btnUndo"[^>]+aria-label="撤销"/);
  assert.match(html, /id="btnRedo"[^>]+aria-label="重做"/);
  assert.match(html, /id="btnNameAdd"[^>]+aria-label="添加人物"/);
  assert.match(html, /id="btnTermAdd"[^>]+aria-label="添加术语"/);
});

test('保存/撤销/重做位于跨工具页常驻的编辑组，且 ID 唯一', async () => {
  const html = await read('index.html');
  // 编辑组是 commandStrip 的直接子节点，不挂在某个模式专属命令条内
  assert.match(html, /<div id="editCommand" class="command-bar edit-command"[^>]*aria-label="常用编辑命令"/);
  const groupStart = html.indexOf('id="editCommand"');
  const groupEnd = html.indexOf('id="controls"');
  assert.ok(groupStart !== -1 && groupEnd > groupStart, 'editCommand 应在 #controls 之前');
  const group = html.slice(groupStart, groupEnd);
  for (const id of ['btnSaveFile', 'btnUndo', 'btnRedo']) {
    assert.match(group, new RegExp(`id="${id}"`), `${id} 应在常驻编辑组内`);
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} 不能出现两次`);
  }
});

test('底栏快捷键提示可被输入建议状态改写（稳定 hook）', async () => {
  const html = await read('index.html');
  assert.match(html, /<kbd>Tab<\/kbd><span id="statusTabHint">下一行<\/span>/);
  const renderer = await read('src/renderer.js');
  assert.match(renderer, /onSuggestChange/);
  assert.match(renderer, /notifySuggest\(true\)/);
  assert.match(renderer, /notifySuggest\(false\)/);
  const main = await read('src/main.js');
  assert.match(main, /function updateStatusTabHint\(open\)/);
  assert.match(main, /onSuggestChange: updateStatusTabHint/);
});

test('全部替换走逐行预览，且不调用会改 shadow 的 Worker 全量替换', async () => {
  const main = await read('src/main.js');
  assert.match(main, /showReplacePreview/);
  assert.match(main, /buildReplacePlan/);
  assert.match(main, /planReplaceCommit/);
  const replaceAllBody = main.slice(main.indexOf('async function replaceAll()'), main.indexOf('function jumpToLine()'));
  assert.ok(replaceAllBody.length > 0, '应能定位 replaceAll');
  assert.doesNotMatch(replaceAllBody, /wkr\.searchReplaceAll/, '全量替换不能走会改 Worker shadow 的接口');
  assert.match(replaceAllBody, /commitReplaceEntries/, '写入走生产纯函数（字段边界只有一处）');
  assert.match(replaceAllBody, /pushUndo\(commit\.entries\.map/, '所选行必须压入一次批量撤销');
  assert.match(replaceAllBody, /docKeyAtPreview !== model\.getStateKey\(\)/, '应用前需核对文档身份');
});

test('模态期间全局命令被隔离（R2）', async () => {
  const main = await read('src/main.js');
  assert.match(main, /isGlobalCommandKey/);
  assert.match(main, /isEditableElement/);
  // 隔离分支必须在全局命令处理之前出现
  const guardIdx = main.indexOf('isGlobalCommandKey(e)');
  const ctrlSIdx = main.indexOf("key === 's'");
  assert.ok(guardIdx > -1 && ctrlSIdx > guardIdx, '模态隔离分支要先于 Ctrl+S 处理');
  const guard = main.slice(Math.max(0, guardIdx - 700), guardIdx + 60);
  assert.match(guard, /\.modal-mask\.show/, '隔离依据是"有显示中的模态"');
});

test('命令面板不在模态之上打开（R2 同类通道）', async () => {
  const palette = await read('src/palette.js');
  const openBody = palette.slice(palette.indexOf('export function openPalette'), palette.indexOf('export function closePalette'));
  assert.match(openBody, /\.modal-mask\.show/, '打开命令面板前要检查模态');
  assert.match(openBody, /return false/, '有模态时拒绝打开');
});

test('替换预览展示只读原句与脚本编号', async () => {
  const modals = await read('src/modals.js');
  const preview = modals.slice(modals.indexOf('export function showReplacePreview'), modals.indexOf('export function showPunctuationRules'));
  assert.match(preview, /r\.orig/, '预览行接收原句');
  assert.match(preview, /rp-orig/, '原句有独立样式钩子');
  assert.match(preview, /'原句'/, '标签文案明确');
  assert.match(preview, /r\.ref/, '预览行接收脚本编号');
  assert.match(preview, /oTxt\.textContent = String\(r\.orig\)|textContent = String\(r\.orig\)/, '原句用文本节点落地');
});

test('异步结果区域向辅助技术宣布状态', async () => {
  const html = await read('index.html');
  assert.match(html, /id="dictResults"[^>]+aria-live="polite"/);
  assert.match(html, /class="test-out" id="mtTestOut" role="status" aria-live="polite"/);
  assert.match(html, /class="test-out" id="dhTestOut" role="status" aria-live="polite"/);
});

test('动态机翻表单生成显式 label-for 关联', async () => {
  const form = await read('src/ui/mt-form.js');
  assert.match(form, /const controlId = \(html\.match/);
  assert.match(form, /forAttr = controlId \? ' for="' \+ controlId \+ '"'/);
  assert.match(form, /<label for="' \+ p\.id \+ '"/);
});

test('交互基线包含 40px 热区、可验证焦点环和语义前景色', async () => {
  const css = await read('src/style.css');
  assert.match(css, /--hit-min:40px/);
  assert.match(css, /--fg-on-primary/);
  assert.match(css, /outline:2px solid var\(--focus-ring\)/);
  assert.match(css, /#sidebar #btnSidebarClose\{ min-width:var\(--hit-min\); \}/);
  assert.match(css, /\.empty-action\{ min-height:var\(--hit-min\); \}/);
});

test('长任务统一经过忙碌态守卫', async () => {
  const main = await read('src/main.js');
  assert.match(main, /function withBusyState\(/);
  assert.match(main, /withBusyState\(document\.getElementById\('btnMT'\)/);
  assert.match(main, /withBusyState\(document\.getElementById\('btnMTBatch'\)/);
  assert.match(main, /withBusyState\(document\.getElementById\('btnDictLookup'\)/);
});

test('检查队列的问题类别下拉有标签，并随标签页保存与恢复', async () => {
  const html = await read('index.html');
  assert.match(html, /<select id="reviewQueueCategory"[^>]+aria-label="问题类别"/);
  const main = await read('src/main.js');
  assert.match(main, /reviewCategory: document\.getElementById\('reviewQueueCategory'\)/);
  assert.match(main, /afterDocActivated\(snap\.editor, snap\.reviewKind, snap\.reviewCategory\)/);
  assert.match(main, /setReviewCategory\(reviewCategory\)/);
});

test('动态模态统一设置 aria-hidden 并循环 Tab 焦点', async () => {
  const modals = await read('src/modals.js');
  assert.match(modals, /mask\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(modals, /Tab/);
  assert.match(modals, /modalFocusables\(modal\)/);
});
