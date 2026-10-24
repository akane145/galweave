import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

// 三主题 WCAG 对比度自动验证（docs/ui-design-spec-v4.md §6.1/§6.2）。
// 口径：解析 style.css 三个主题变量块，按 WCAG 2.x 相对亮度公式计算配对比值。
// 改任何主题色必须过本测试 —— 没有它，§4 的色值只是口头承诺。

const THEMES = {
  '夜读(暗)': [],
  '昼笺(light)': ['data-theme="light"'],
  '墨影(bw)': ['data-theme="bw"'],
};

// 每主题必达配对：[前景, 背景, 最低比值, 说明]
// st-*-fg 的背景是 soft pill：--st-*-bg 半透明色叠在 --bg-panel 上的合成色。
function pairsFor(get) {
  const blendOverPanel = rgba => blend(rgba, get('--bg-panel'));
  return [
    ['--ink-hi', '--bg-base', 7, '标题墨水(AAA)'],
    ['--ink', '--bg-base', 7, '正文墨水(AAA)'],
    ['--ink-mid', '--bg-base', 4.5, '次级墨水(AA)'],
    ['--ink-dim', '--bg-base', 4.5, '弱说明墨水(AA)'],
    ['--fg-on-primary', '--accent-fill', 4.5, '主 CTA 文字'],
    ['--fg-on-primary-hover', '--accent-fill-hover', 4.5, '主 CTA hover 文字'],
    ['--fg-on-danger', '--st-issue', 4.5, '危险实心填充文字'],
    ['--fg-on-warning', '--st-pending', 4.5, '警示实心填充文字'],
    ['--fg-on-approved', '--st-approved', 4.5, '成功实心填充文字'],
    ['--fg-on-speaker', '--ink-speaker', 4.5, '琥珀墨底(mark/徽章)文字'],
    ['--ink-hi', '--bg-panel', 7, '面板正文墨水(弹窗标题/侧栏标题)'],
    ['--st-todo-fg', blendOverPanel(get('--st-todo-bg')), 4.5, 'todo pill 文字/soft底'],
    ['--st-pending-fg', blendOverPanel(get('--st-pending-bg')), 4.5, 'pending pill 文字/soft底'],
    ['--st-issue-fg', blendOverPanel(get('--st-issue-bg')), 4.5, 'issue pill 文字/soft底'],
    ['--st-approved-fg', blendOverPanel(get('--st-approved-bg')), 4.5, 'approved pill 文字/soft底'],
    ['--focus-ring', '--bg-panel', 3, '焦点环对相邻表面(WCAG 1.4.11)'],
  ];
}

/* ---------- 解析 ---------- */

function parseThemeBlocks(css) {
  const blocks = {};
  const re = /:root(\[[^\]]*\])?\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1] || ':root';
    if (!(sel in blocks)) blocks[sel] = {};
    for (const line of m[2].split(';')) {
      const decl = line.match(/(--[a-z0-9-]+)\s*:\s*([^;]+)/);
      if (decl) blocks[sel][decl[1]] = decl[2].trim();
    }
  }
  return blocks;
}

function themeVars(blocks, modifiers) {
  const key = modifiers.length ? `[${modifiers.join('][')}]` : ':root';
  const base = blocks[':root'] || {};
  const over = modifiers.length ? (blocks[key] || {}) : {};
  return name => {
    if (name in over) return over[name];
    if (name in base) return base[name];
    return null;
  };
}

/* ---------- 颜色计算 ---------- */

function resolveVar(value, get, depth = 0) {
  if (depth > 8 || typeof value !== 'string') return value;
  const v = value.trim();
  if (v.startsWith('--')) {
    const r = get(v);
    return r === null || r === undefined ? v : resolveVar(r, get, depth + 1);
  }
  const m = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return v;
  const resolved = get(m[1]);
  if (resolved === null || resolved === undefined) return m[2] ? m[2].trim() : v;
  return resolveVar(resolved, get, depth + 1);
}

function parseColor(raw) {
  const v = raw.trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map(c => parseInt(c + c, 16)).concat(1);
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}

function blend(rgbaRaw, baseRaw) {
  const fg = parseColor(rgbaRaw);
  const bg = parseColor(baseRaw);
  if (!fg || !bg) return null;
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const lin = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function toColor(raw, get) {
  if (Array.isArray(raw)) return raw;           // 已合成的 soft pill 底色
  return parseColor(resolveVar(raw, get));
}

function contrast(fgRaw, bgRaw, get) {
  const fg = toColor(fgRaw, get);
  const bg = toColor(bgRaw, get);
  if (!fg || !bg) return null;
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/* ---------- 测试 ---------- */

test('style.css 存在三个主题 token 块', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const blocks = parseThemeBlocks(css);
  assert.ok(blocks[':root'], '缺少 :root 基础块');
  assert.ok(blocks['[data-theme="light"]'], '缺少昼笺块');
  assert.ok(blocks['[data-theme="bw"]'], '缺少墨影块');
});

for (const [name, modifiers] of Object.entries(THEMES)) {
  test(`${name} 主题：§6.1 对比度配对全部达标`, async () => {
    const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
    const blocks = parseThemeBlocks(css);
    const get = themeVars(blocks, modifiers);
    for (const [fg, bg, min, label] of pairsFor(get)) {
      const fgVal = resolveVar(get(fg) ?? fg, get);
      const ratio = contrast(fgVal, bg, get);
      assert.notEqual(ratio, null, `${label}: ${fg}(${fgVal}) 或 ${bg} 无法解析为颜色`);
      assert.ok(
        ratio >= min,
        `${label}: ${fg} 对 ${bg} = ${ratio.toFixed(2)}:1，低于 ${min}:1`
      );
    }
  });
}

// 组件配色也必须验证：token 本身达标不代表按钮真的用了正确的配对。
function componentRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.trim().split(/\s*,\s*/),
    declarations: Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)]
      .map(([, key, value]) => [key, value.trim()])),
  }));
}

test('彩色按钮实际配对在三个主题中达标，且禁止亮色语义底直接配白字', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const blocks = parseThemeBlocks(css);
  const rules = componentRules(css);
  for (const rule of rules) {
    const { color, background } = rule.declarations;
    if (/^(?:#fff(?:fff)?|white)$/i.test(color || '') &&
        /^var\(--(?:accent|st-[\w-]+|ink-speaker)\)$/.test(background || '')) {
      assert.fail(`${rule.selectors.join(', ')} 直接把白字压在语义亮底上`);
    }
  }
  const components = [
    ['.btn-primary', '--fg-on-primary', '--accent-fill'],
    ['.btn-primary:hover', '--fg-on-primary-hover', '--accent-fill-hover'],
    ['#setModal .settings-primary', '--fg-on-primary', '--accent-fill'],
    ['.modal .actions button.btn-confirm', '--fg-on-primary', '--accent-fill'],
    ['.modal.mt-task .actions button.btn-retry', '--fg-on-primary', '--accent-fill'],
    ['.pr-btn.on', '--fg-on-approved', '--st-approved'],
    ['.pr-btn.pr-issue-btn.on', '--fg-on-speaker', '--ink-speaker'],
    ['button.danger:hover', '--fg-on-danger', '--st-issue'],
  ];
  for (const [selector, fg, bg] of components) {
    const declarations = Object.assign({}, ...rules.filter(rule => rule.selectors.includes(selector))
      .map(rule => rule.declarations));
    assert.equal(declarations.color, `var(${fg})`, `${selector} 应使用对应前景色`);
    assert.equal(declarations.background, `var(${bg})`, `${selector} 应使用对应填充色`);
    for (const [name, modifiers] of Object.entries(THEMES)) {
      const ratio = contrast(declarations.color, declarations.background, themeVars(blocks, modifiers));
      assert.ok(ratio !== null && ratio >= 4.5, `${name} ${selector}: ${ratio?.toFixed(2)}:1`);
    }
  }
});

test('行号四态只由 data-state 绘制，普通已译行不能被画成定稿', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const rules = componentRules(css);
  const shapes = rules.filter(rule => rule.selectors.some(selector => selector.includes('.num::after')));
  assert.ok(shapes.length > 0);
  assert.ok(shapes.every(rule => !rule.selectors.some(selector => /\.done|\.pr-on|\.pr-pending/.test(selector))));
  assert.ok(shapes.every(rule => !rule.declarations.content || rule.declarations.content === '""'));
  for (const state of ['pending', 'issue', 'approved']) {
    assert.ok(shapes.some(rule => rule.selectors.includes(`.para[data-state="${state}"] .num::after`)), state);
  }
});

test('toast 单一定义位于底部，行内校对按钮拥有自身 40px 热区', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const rules = componentRules(css);
  const toast = rules.filter(rule => rule.selectors.includes('#toast'));
  assert.equal(toast.length, 1);
  assert.match(toast[0].declarations.bottom, /var\(--statusbar-h\)/);
  const blocks = parseThemeBlocks(css);
  for (const modifiers of Object.values(THEMES)) {
    const get = themeVars(blocks, modifiers);
    for (const [, name] of toast[0].declarations.bottom.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      assert.match(resolveVar(get(name), get) || '', /^\d+(?:\.\d+)?px$/, `${name} 必须能解析为长度，避免 bottom 整条声明失效`);
    }
    assert.equal(resolveVar(get('--statusbar-h'), get), '32px');
  }
  assert.equal(toast[0].declarations.top, undefined);
  const proof = rules.filter(rule => rule.selectors.includes('.pr-btn'));
  assert.ok(proof.some(rule => rule.declarations['min-height'] === 'var(--hit-min)'));
});

test('CSS 三档实际行距与虚拟列表模型一致：6 / 12 / 20', async () => {
  const [css, renderer] = await Promise.all([
    readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer.js', import.meta.url), 'utf8'),
  ]);
  const blocks = parseThemeBlocks(css);
  const model = renderer.match(/ROW_GAP_BY_DENSITY\s*=\s*\{\s*compact:\s*(\d+),\s*cozy:\s*(\d+),\s*loose:\s*(\d+)\s*\}/);
  assert.ok(model, '必须能读取虚拟列表三档行距');
  for (const [density, expected, value] of [
    ['compact', 6, model[1]], ['cozy', 12, model[2]], ['loose', 20, model[3]],
  ]) {
    const get = themeVars(blocks, density === 'cozy' ? [] : [`data-density="${density}"`]);
    assert.equal(resolveVar(get('--row-gap'), get), `${expected}px`, `${density} CSS 行距`);
    assert.equal(Number(value), expected, `${density} 虚拟列表行距`);
  }
});


test('侧栏与命令区标题使用 UI 字体且没有装饰字距', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const rules = componentRules(css);
  for (const selector of ['.rail-topline', '.rail-section-head', '.rail-overline', '.tool-label', '#commandStrip .tool-label', '.context-focus span']) {
    const declarations = Object.assign({}, ...rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.declarations));
    assert.ok((declarations['font-family'] || declarations.font).includes('var(--font-ui)'), selector);
    assert.equal(declarations['letter-spacing'], '0', selector);
  }
  const speaker = Object.assign({}, ...rules.filter(rule => rule.selectors.includes('.context-focus strong')).map(rule => rule.declarations));
  assert.equal(speaker['font-family'], 'var(--font-ui)');
});

test('术语操作可换行，带文字的角色添加按钮按内容宽度布局', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const rules = componentRules(css);
  const declarationsFor = selector => Object.assign({}, ...rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.declarations));
  assert.equal(declarationsFor('.gloss-toolbar')['flex-wrap'], 'wrap');
  assert.equal(declarationsFor('.gloss-toolbar button').flex, '1 0 auto');
  const persona = declarationsFor('.gloss-add-row #btnPersonaAdd');
  assert.equal(persona.width, 'auto');
  assert.equal(persona['min-width'], 'var(--hit-min)');
  assert.equal(persona.padding, '0 var(--sp-2)');
  assert.equal(declarationsFor('.gloss-add-row #personaAddName')['min-width'], '0');
});
