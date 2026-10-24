import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const renderer = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

test('侧栏「建议」面板把当前行 TM/机翻汇总到一处并可一键采用', () => {
  assert.match(html, /id="side-tab-suggestions"[^>]*data-tab="suggestions"/);
  assert.match(html, /class="side-panel hidden" id="panel-suggestions"/);
  assert.match(html, /id="inspectorSuggestions"[^>]*aria-live="polite"/);
  assert.match(main, /function renderInspectorSuggestions\(/);
  // 切到建议 tab 与聚焦行变化时都要刷新
  assert.match(main, /if \(name === 'suggestions'\) renderInspectorSuggestions\(\)/);
  assert.match(main, /if \(sceneReference\) sceneReference\.textContent[\s\S]{0,120}renderInspectorSuggestions\(i\)/);
});

test('建议面板只转发到既有写入路径，不另写一套译文拼接', () => {
  assert.match(main, /function writeRowTranslation\(i, text, source\)/);
  // TM 与机翻两个入口都复用统一写入
  assert.match(main, /function applyTmToRow\([\s\S]*?writeRowTranslation\(i, hit\.dst, 'tm'\)/);
  assert.match(main, /function revertRowToMt\([\s\S]*?writeRowTranslation\(i, text, 'mt'\)/);
  // 面板内部只能调用转发函数，不得直接赋值 translation
  const panel = main.slice(main.indexOf('function renderInspectorSuggestions'), main.indexOf('// 清单标签'));
  assert.doesNotMatch(panel, /\.translation\s*=/);
});

test('NAME 行译名框键盘可达（tab 序 + 聚焦目标）', () => {
  assert.match(renderer, /r\.nameInput\.tabIndex = p\.isName \? 0 : -1/);
  assert.match(renderer, /const target = p\.isName \? r\.nameInput : r\.trans/);
  assert.match(renderer, /target\.focus\(\)/);
});

test('侧栏 tab 支持方向键漫游（roving tabindex）', () => {
  assert.match(main, /sideTabs[\s\S]*?ArrowRight/);
  assert.match(main, /sideTabs[\s\S]*?ArrowLeft/);
  assert.match(main, /b\.tabIndex = b\.classList\.contains\('active'\) \? 0 : -1/);
  assert.match(main, /b\.tabIndex = active \? 0 : -1/);
});

test('Web Font 加载完成后重测行高，避免虚拟列表累计偏移', () => {
  assert.match(main, /document\.fonts\.ready\.then\(\(\) => rdr\.remeasureAll\(\)\)/);
});

test('建议卡片样式与 reduced-motion 覆盖', () => {
  assert.match(style, /\.inspector-suggestion\s*\{[^}]*display\s*:\s*grid/s);
  assert.match(style, /\.inspector-suggestion-kind\s*\{/);
  assert.match(style, /@media\s*\(prefers-reduced-motion:reduce\)\{\s*[\s\S]*?\.inspector-suggestion/);
});

test('相似命中展示记忆原文与可展开的原句对照', () => {
  // 相似卡片带 srcdiff 的差异区间；精确命中/机翻基线不重复展示相同原句
  assert.match(main, /function appendSourceCompare\(/);
  assert.match(main, /srcdiff\.diffSourcePair\(current, src\)/);
  assert.match(main, /\{ current: p\.content, src: x\.entry\.src \}/);
  // 差异区间用文本节点 + mark 落地（不用 innerHTML 拼用户文本）
  const fn = main.slice(main.indexOf('function appendSourceCompare('), main.indexOf('function renderInspectorSuggestions('));
  assert.match(fn, /mark\.textContent = mid/);
  assert.match(fn, /createTextNode/);
  assert.doesNotMatch(fn, /\.innerHTML\s*=/);
  // 差异是辅助呈现：不改相似度阈值与结果数量
  assert.match(main, /tm\.findSimilar\(tmData, p\.content, \{ limit: 3, name: p\.name \}\)/);
  // 折叠入口可键盘操作
  assert.match(style, /\.inspector-src-compare > summary:focus-visible/);
});

test('相似建议的对照不能把来源字段当成原句', () => {
  // entry.origin 是"译文是谁写的"，entry.src 才是原文；两者不能互串
  assert.match(main, /x\.entry\.src/);
  assert.doesNotMatch(main, /entrySourceLabel\([^)]*\)\s*\}?,?\s*src:\s*x\.entry\.origin/);
});
