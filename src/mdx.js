// mdx.js — MDX 词典适配层
// 桌面版: 走 Tauri 原生命令(mdx_open/lookup/prefix/close),Rust 端内存映射 + 解析,
//         彻底消除 Base64 over JSON IPC 膨胀;@@@LINK 跟随在 Rust 端完成。
// 浏览器单文件版: 保留 js-mdict@6.0.8 + node-shims 路径(与 v5.0 行为一致)。
// 运行: node --test tests/mdx.test.mjs

import * as fsx from './fs.js';

/* ================= 词条交互纯逻辑(可单测) ================= */

/** 扩展名 → MIME(词条 HTML 里 MDD 资源的图片/音频/字体/CSS/视频) */
export function mimeFromExt(name){
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    css: 'text/css',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

/** 词条内 img src → MDD 资源 key: 去前导 / 或 \ (MDD key 内部保留反斜杠) */
export function srcToResourceKey(src){
  return String(src || '').replace(/^[\\/]+/, '');
}

/** 是否为需要 MDD 解析的本地资源 src(http/data/blob 等外部资源不需要) */
export function isMddResourceSrc(src){
  return !!String(src || '') && !/^(https?:|data:|blob:|about:)/i.test(src);
}

/** href 是否为词条跳转链接 */
export function isEntryLink(href){
  return String(href || '').startsWith('entry://');
}
/** href 是否为发音链接 */
export function isSoundLink(href){
  return String(href || '').startsWith('sound://');
}
/** 从 entry:// 或 sound:// 提取目标 */
export function linkTarget(href){
  return String(href || '').replace(/^[a-z]+:\/\//, '');
}

/* ================= 词条 HTML 消毒(JS 端安全边界,两种路径共用) ================= */

// CSS 中的危险/动态子串(整行命中则丢弃该行): @import 可拉外部、expression() 与可执行 url 属注入面
const BAD_CSS = ['@import', 'expression(', 'url(javascript:', 'url(vbscript:', 'url(data:text/html'];

/** CSS 文案消毒: 逐行丢弃含 @import / expression() / 可执行 url() 的行。 */
export function sanitizeCss(css){
  return String(css || '').split(/\r?\n/).map(line =>
    BAD_CSS.some((b) => line.toLowerCase().indexOf(b) !== -1) ? '' : line
  ).join('\n');
}

/** 替换词典 CSS 中未展开的模板变量(如广辞苑的 $midashi-font-size$)。 */
export function replaceCssTokens(css, tokens){
  let out = String(css || '');
  for (const [key, value] of Object.entries(tokens || {})) out = out.split(key).join(String(value));
  return out;
}


const DICT_DARK_VALUES = new Set([
  'black', '#000', '#000000', '#111', '#111111', '#111827', '#1f2933', '#202020', '#222', '#222222', '#243447', '#292929', '#333', '#333333',
]);
const DICT_LIGHT_VALUES = new Set([
  'white', '#fff', '#ffffff', '#f5f5f1', '#f8fafc', '#f9fafb', '#fafbfd', '#faf9f5', '#fbfbf8', '#fcfdfd', '#f0f0f0', '#f4efe9', '#eee', '#eeeeee',
]);
const DICT_MUTED_VALUES = new Set(['#666', '#666666', '#777', '#888', '#999', '#9d928c', '#a0a0a0', '#b2b2b2', '#6b7280', '#667085', '#475569', '#475467']);
const DICT_ACCENT_VALUES = new Set(['red', 'crimson', '#c00', '#cc3333', '#b9584f', '#b71c1c', '#982727', '#78350f', '#7a271a', '#8b1e1e']);

/** 亮度阈值(0=黑,255 近似白): <=LIFT_MAX 的字色在深色主题提亮,>=DROP_MIN 的在浅色主题压暗 */
const DICT_LIFT_MAX = 140;
const DICT_DROP_MIN = 210;

/** CSS 命名颜色 → hex(词典 CSS 常用集合,覆盖 CSS2.1 全部 + 常见扩展) */
const CSS_NAMED_COLORS = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff',
  maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080',
  blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
  gold: '#ffd700', goldenrod: '#daa520', darkgoldenrod: '#b8860b', palegoldenrod: '#eee8aa',
  pink: '#ffc0cb', lightpink: '#ffb6c1', hotpink: '#ff69b4', deeppink: '#ff1493',
  coral: '#ff7f50', tomato: '#ff6347', orangered: '#ff4500', darkorange: '#ff8c00',
  salmon: '#fa8072', lightsalmon: '#ffa07a', darksalmon: '#e9967a', lightcoral: '#f08080',
  indianred: '#cd5c5c', firebrick: '#b22222', brown: '#a52a2a', darkred: '#8b0000',
  sienna: '#a0522d', chocolate: '#d2691e', saddlebrown: '#8b4513', peru: '#cd853f',
  rosybrown: '#bc8f8f', tan: '#d2b48c', wheat: '#f5deb3', burlywood: '#deb887',
  beige: '#f5f5dc', ivory: '#fffff0', linen: '#faf0e6', antiquewhite: '#faebd7',
  papayawhip: '#ffefd5', blanchedalmond: '#ffebcd', moccasin: '#ffe4b5', navajowhite: '#ffdead',
  peachpuff: '#ffdab9', bisque: '#ffe4c4', cornsilk: '#fff8dc', khaki: '#f0e68c', darkkhaki: '#bdb76b',
  yellowgreen: '#9acd32', olivedrab: '#6b8e23', darkolivegreen: '#556b2f', greenyellow: '#adff2f',
  chartreuse: '#7fff00', lawngreen: '#7cfc00', limegreen: '#32cd32', palegreen: '#98fb98',
  lightgreen: '#90ee90', springgreen: '#00ff7f', mediumspringgreen: '#00fa9a', forestgreen: '#228b22',
  seagreen: '#2e8b57', mediumseagreen: '#3cb371', darkseagreen: '#8fbc8f', darkgreen: '#006400',
  lightseagreen: '#20b2aa', mediumaquamarine: '#66cdaa', aquamarine: '#7fffd4', turquoise: '#40e0d0',
  mediumturquoise: '#48d1cc', darkturquoise: '#00ced1', lightcyan: '#e0ffff', powderblue: '#b0e0e6',
  lightblue: '#add8e6', skyblue: '#87ceeb', lightskyblue: '#87cefa', deepskyblue: '#00bfff',
  dodgerblue: '#1e90ff', cornflowerblue: '#6495ed', steelblue: '#4682b4', lightsteelblue: '#b0c4de',
  royalblue: '#4169e1', mediumblue: '#0000cd', darkblue: '#00008b', midnightblue: '#191970',
  slateblue: '#6a5acd', mediumslateblue: '#7b68ee', darkslateblue: '#483d8b', indigo: '#4b0082',
  blueviolet: '#8a2be2', darkviolet: '#9400d3', darkorchid: '#9932cc', mediumorchid: '#ba55d3',
  mediumpurple: '#9370db', thistle: '#d8bfd8', plum: '#dda0dd', violet: '#ee82ee', orchid: '#da70d6',
  mediumvioletred: '#c71585', palevioletred: '#db7093', lavenderblush: '#fff0f5', lavender: '#e6e6fa',
  aliceblue: '#f0f8ff', azure: '#f0ffff', mintcream: '#f5fffa', honeydew: '#f0fff0',
  ghostwhite: '#f8f8ff', whitesmoke: '#f5f5f5', floralwhite: '#fffaf0', seashell: '#fff5ee',
  oldlace: '#fdf5e6', lemonchiffon: '#fffacd', lightyellow: '#ffffe0', darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f', dimgray: '#696969', dimgrey: '#696969', slategray: '#708090',
  slategrey: '#708090', lightslategray: '#778899', lightslategrey: '#778899', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', gainsboro: '#dcdcdc',
  sandybrown: '#f4a460',
};

function colorBrightness(raw){
  const m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map(x => x + x).join('') : m[1];
  const n = Number.parseInt(hex, 16);
  return ((n >> 16) * 299 + (((n >> 8) & 255) * 587) + ((n & 255) * 114)) / 1000;
}

/** 颜色字面量 → 标准 #rrggbb(命名色/3位/6位 hex),认不出返回 null */
function resolveColorHex(raw){
  const lower = String(raw || '').trim().toLowerCase();
  if (CSS_NAMED_COLORS[lower]) return CSS_NAMED_COLORS[lower];
  const m = lower.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  return m[1].length === 3 ? '#' + m[1].split('').map(x => x + x).join('') : '#' + m[1];
}

/** 深色主题下把过暗字色调亮(混白,保留色相);浅色主题 --dict-lift-amt 为 0% 即原色 */
function liftMix(raw){
  return 'color-mix(in srgb, ' + raw + ', var(--dict-lift) var(--dict-lift-amt))';
}
/** 浅色主题下把过浅字色压暗(混深),深色主题 --dict-drop-amt 为 0% 即原色 */
function dropMix(raw){
  return 'color-mix(in srgb, ' + raw + ', var(--dict-drop) var(--dict-drop-amt))';
}

/**
 * 单个颜色字面量 → 主题变量。
 * kind: 'text'(color/fill/stroke) | 'border'(border/outline 色) | 'background'。
 * 成对规则:词典里「黑底白字」的反白块,背景与文字各自翻转到对应主题变量后仍保持对比。
 */
function mapColorLiteral(raw, kind){
  const lower = String(raw || '').trim().toLowerCase();
  const hex = resolveColorHex(lower);
  if (!hex) return null; // 非单色字面量(rgba/多段值/未知),交给 token 扫描或原样保留
  const isBackground = kind === 'background';
  if (DICT_DARK_VALUES.has(lower) || DICT_DARK_VALUES.has(hex)){
    return isBackground ? 'var(--dict-surface-strong)' : (kind === 'border' ? 'var(--dict-border)' : 'var(--dict-ink)');
  }
  if (DICT_LIGHT_VALUES.has(lower) || DICT_LIGHT_VALUES.has(hex)){
    // 白/近白字色同样映射为 ink:配合背景(亦随主题翻转)在两种主题下都保持高对比。
    // 旧实现映射到 --dict-paper(深色主题下是深色),黑底白字块会变成深字深底不可读。
    return isBackground ? 'var(--dict-surface)' : (kind === 'border' ? 'var(--dict-border)' : 'var(--dict-ink)');
  }
  if (DICT_MUTED_VALUES.has(lower) || DICT_MUTED_VALUES.has(hex)) return 'var(--dict-muted)';
  if (DICT_ACCENT_VALUES.has(lower) || DICT_ACCENT_VALUES.has(hex)) return 'var(--dict-accent)';
  const b = colorBrightness(hex);
  if (isBackground){
    if (b >= 205) return 'var(--dict-surface-soft)';
    if (b <= 45) return 'var(--dict-surface-strong)';
    return raw; // 中间调背景原样保留(色块语义),靠 ink 字色保持对比
  }
  if (kind === 'border'){
    if (b >= 205 || b <= 45) return 'var(--dict-border)';
    return raw;
  }
  if (b <= 25) return 'var(--dict-ink)';
  if (b <= DICT_LIFT_MAX) return liftMix(raw);
  if (b >= DICT_DROP_MIN) return dropMix(raw);
  return raw;
}

/** 值内的颜色 token 级替换(hex/命名色),用于 border 简写等多段值;非颜色 token 原样保留 */
function mapColorTokens(value, kind){
  return String(value || '').replace(
    /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])|(?<![-#.\w])[a-z]{3,}(?![\w-])/gi,
    (token) => mapColorLiteral(token, kind) || token
  );
}

function normalizeColorValue(value, property){
  let raw = String(value || '').trim();
  let important = '';
  const imp = raw.match(/\s*!\s*important\s*$/i);
  if (imp){ important = ' !important'; raw = raw.slice(0, imp.index).trim(); }
  const lower = raw.toLowerCase();
  const kind = property.startsWith('background') ? 'background'
    : (/^(?:border|outline)/.test(property) ? 'border' : 'text');
  if (!raw || /^(?:inherit|initial|unset|transparent|currentcolor|var\(|url\()/i.test(lower)) return raw + important;
  if (/^(?:linear|radial)-gradient\(/i.test(lower)){
    // 渐变属于块状填充:白/黑/银按背景语义翻转,其余颜色 token 同 background 规则
    const mapped = raw
      .replace(/\bwhite\b/gi, 'var(--dict-surface)')
      .replace(/\bblack\b/gi, 'var(--dict-ink)')
      .replace(/\bsilver\b/gi, 'var(--dict-border)');
    return mapColorTokens(mapped, 'background') + important;
  }
  const single = mapColorLiteral(raw, kind);
  if (single !== null) return single + important;
  return mapColorTokens(raw, kind) + important;
}

/** 将词典硬编码黑白色转换为主题变量，令同一份 CSS 随深/浅色主题切换。 */
export function normalizeDictionaryColors(css){
  let out = String(css || '')
    .replace(/var\(\s*--ink\s*\)/gi, 'var(--dict-ink)')
    .replace(/var\(\s*--muted\s*\)/gi, 'var(--dict-muted)');
  out = out.replace(/((?:^|[;{])\s*)((color|background(?:-color)?|border(?:-[a-z-]+)?(?:-color)?|outline(?:-[a-z-]+)?(?:-color)?|fill|stroke)\s*:\s*)([^;{}]+)/g,
    (m, boundary, declaration, property, value) => boundary + declaration + normalizeColorValue(value, property.toLowerCase()));
  return out;
}

function matchingBrace(text, open){
  let depth = 1, quote = '', comment = false;
  for (let i = open + 1; i < text.length; i++){
    const c = text[i], n = text[i + 1];
    if (comment){ if (c === '*' && n === '/') { comment = false; i++; } continue; }
    if (!quote && c === '/' && n === '*'){ comment = true; i++; continue; }
    if (quote){ if (c === '\\') { i++; continue; } if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'"){ quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function prefixSelectorList(prelude, scope){
  const leading = (prelude.match(/^\s*/) || [''])[0];
  const raw = prelude.slice(leading.length).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!raw || raw.startsWith('@')) return prelude;
  const selectors = raw.split(',').map(sel => {
    const s = sel.trim();
    if (!s) return s;
    if (s === '*') return scope + ' *';
    if (s.startsWith(scope)) return s;
    if (/^(?:html|body|:root)(?=\b|[:.#\[])/i.test(s)) return s.replace(/^(?:html|body|:root)/i, scope);
    return scope + ' ' + s;
  });
  return leading + selectors.join(', ');
}

/** 将词典 CSS 限定到指定词条容器，递归处理 @media/@supports。 */
export function scopeDictionaryCss(css, scope = '.dc-html'){
  const text = String(css || '');
  let out = '', cursor = 0;
  while (cursor < text.length){
    const open = text.indexOf('{', cursor);
    if (open < 0){ out += text.slice(cursor); break; }
    const close = matchingBrace(text, open);
    if (close < 0){ out += text.slice(cursor); break; }
    const prelude = text.slice(cursor, open);
    const trimmed = prelude.trim().toLowerCase();
    const body = text.slice(open + 1, close);
    if (/^@(media|supports|container|layer|document)\b/.test(trimmed)){
      out += prelude + '{' + scopeDictionaryCss(body, scope) + '}';
    } else if (/^@(font-face|keyframes|-webkit-keyframes|page|property|counter-style)\b/.test(trimmed)){
      out += prelude + '{' + body + '}';
    } else {
      out += prefixSelectorList(prelude, scope) + '{' + body + '}';
    }
    cursor = close + 1;
  }
  return out;
}

/** 词典 CSS 的统一入口: 消毒、模板变量、作用域、字号归一化。 */
export function normalizeDictionaryCss(css, options = {}){
  let out = sanitizeCss(css);
  // 部分 MDict CSS 使用非标准的 @color name = value; 预处理指令,浏览器不理解且会干扰作用域解析。
  out = out.replace(/^\s*@color\s+[^;]+;\s*$/gm, '');
  out = replaceCssTokens(out, options.tokens || {});
  out = normalizeDictionaryColors(out);
  out = scopeDictionaryCss(out, options.scope || '.dc-html');
  return unifyCssFontSize(out);
}

/** 提取 CSS 文本里的 url(…) 内联资源串列表(去引号)。纯扫描,不依赖回调式正则。 */
export function extractCssUrls(css){
  const s = String(css || '');
  const out = [];
  let i = 0;
  while ((i = s.indexOf('url(', i)) !== -1){
    let j = i + 4;
    while (j < s.length && s[j] !== ')') j++;
    let inner = s.slice(i + 4, j).trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
    out.push(inner);
    i = j + 1;
  }
  return out;
}

/**
 * 把 CSS 文本里的本地资源 url() 水化为 data URL。
 * resolve(key) → { b64, mime } 或 null(缺失则原样保留)。http(s)/data/blob 外部资源不动。
 */
export function hydrateCssUrls(css, resolve){
  const s = String(css || '');
  let out = '';
  let i = 0;
  while (true){
    const k = s.indexOf('url(', i);
    if (k === -1){ out += s.slice(i); break; }
    out += s.slice(i, k);
    let j = k + 4;
    while (j < s.length && s[j] !== ')') j++;
    const raw = s.slice(k, j + 1);
    let inner = s.slice(k + 4, j).trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
    const url = inner.trim();
    let replacement = raw;
    if (isMddResourceSrc(url)){
      const res = resolve ? resolve(srcToResourceKey(url)) : null;
      if (res && res.b64){
        replacement = 'url(data:' + (res.mime || mimeFromExt(url)) + ';base64,' + res.b64 + ')';
      }
    }
    out += replacement;
    i = j + 1;
  }
  return out;
}

/**
 * MDX 词条 HTML 消毒: 保留排版、样式、媒体标签,移除脚本/表单/事件属性与危险 CSS/链接。
 * 词典是第三方内容,Webview 内必须消毒后再渲染。Node(无 DOMParser)环境直接原样返回(供测试)。
 */
export function sanitizeMdxHtml(html){
  if (typeof DOMParser === 'undefined') return String(html);
  let doc;
  try {
    doc = new DOMParser().parseFromString('<div id="mdx-root">' + String(html) + '</div>', 'text/html');
  } catch (e){ return ''; }
  const root = doc.getElementById('mdx-root');
  if (!root) return '';
  // 移除脚本/表单/内嵌 iframe 等;保留 style/link(stylesheet)/audio/video/source 供水化
  root.querySelectorAll('script,iframe,frame,object,embed,meta,base,form,input,select,textarea,button').forEach(el => el.remove());
  // <link>: 仅保留 rel=stylesheet 且 href 安全的;其余 link(icon/preload 等)移除
  root.querySelectorAll('link').forEach(el => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    const href = el.getAttribute('href') || '';
    if (!rel.includes('stylesheet') || /^\s*(javascript|data|blob|vbscript):/i.test(href)) el.remove();
  });
  // <style>: 内容消毒(去 @import/expression/可执行 url)
  root.querySelectorAll('style').forEach(el => { el.textContent = sanitizeCss(el.textContent); });
  // 通用属性清理: on* 事件、危险协议的 href/src/data
  root.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]){
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'data' || n === 'xlink:href') && /^\s*(javascript|data|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  return root.innerHTML;
}

/* ================= 结果归一化 ================= */

/** 从词条 HTML 提取真实词头文本(如明镜的 <headword class="カナ">た・べる</headword>
 *  + <headword class="表記">【食べる】</headword> → 「た・べる【食べる】」)。
 * 只取前两个 headword(读音+表記),跳过子見出し(惯用句)。找不到返回空串。
 * 纯文本扫描,不解析 DOM。<red>/<small> 等装饰标签直接剔除不留空格。 */
export function extractHtmlHeadword(html){
  const s = String(html || '');
  const parts = [];
  let i = 0;
  while (parts.length < 2){
    const a = s.indexOf('<headword', i);
    if (a === -1) break;
    const gt = s.indexOf('>', a);
    if (gt === -1) break;
    const close = s.indexOf('</headword>', gt);
    if (close === -1) break;
    const inner = s.slice(gt + 1, close);
    // 剔除装饰标签(<red>/<small>),保留内容与 ruby 文本
    const t = inner
      .replace(/<\/?(?:red|small)>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) parts.push(t);
    i = close + 11;
  }
  return parts.join('');
}

/** 清除词头里的外字占位标记: 〓 + 4位十六进制 + 可选 ASCII 描述(如 「〓F18D bare+look」)。
 * 这类标记是词典(如 XSJRH)对"Unicode 无字形外字"的编码,若 MDD 无对应字形资源,
 * 直接显示会暴露原始编码(乱码)。移除标记本身,保留其后可读的 ASCII 描述。 */
export function cleanGaijiMarkers(text){
  return String(text || '')
    .replace(/〓[0-9A-Fa-f]{4}\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 词条 HTML 内的外字标记净化: 只清理文本节点中的 〓XXXX 标记,不动标签/属性。
 * 浏览器环境用 DOMParser;Node(无 DOMParser)原样返回(供测试)。 */
export function cleanGaijiInHtml(html){
  if (typeof DOMParser === 'undefined') return String(html || '');
  let doc;
  try {
    doc = new DOMParser().parseFromString('<div id="gaiji-root">' + String(html) + '</div>', 'text/html');
  } catch (e){ return String(html || ''); }
  const root = doc.getElementById('gaiji-root');
  if (!root) return String(html || '');
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes){
    if (n.nodeValue && n.nodeValue.includes('〓')){
      n.nodeValue = cleanGaijiMarkers(n.nodeValue);
    }
  }
  return root.innerHTML;
}

/** 词典 CSS 字号统一: 把 font-size 的固定 px 和 rem 值转成 em(基准 16px)。
 * 词典自带的固定 px 字号(如 XSJRH 的 12px/14px)与 rem 字号(如 jitendex 的 0.7rem)
 * 不跟随容器字号——px 是绝对值,rem 相对根元素——导致不同词典、不同用户字号下
 * 正文大小不一。转成 em 后全部以 .dc-html 容器字号(用户设置的"原文字号")为基准
 * 等比缩放,同时保留词头/正文/例句的层次比例。只动 font-size,不碰 padding/margin 等。 */
export function unifyCssFontSize(css){
  return String(css || '').replace(/(font-size\s*:\s*)(\d+(?:\.\d+)?)(px|rem)/g, (m, pre, val, unit) => {
    // px 是绝对值,除以 16 转 em(相对容器);rem 本相对根元素(也是 16px 基准),
    // 转成 em 后值不变,但语义变为跟随容器字号。
    const em = unit === 'rem'
      ? parseFloat(val)
      : Math.round((parseFloat(val) / 16) * 1000) / 1000;
    return pre + em + 'em';
  });
}

/** 计算词条展示词头: 内部 ID(如 @jitendex-123456 / 纯数字 38658)时优先用 HTML 内真实词头,
 * 否则回退查询词,避免把词典内部 ID 显示给用户。普通词头原样返回。
 * 无论哪种,都清除 〓XXXX 外字占位标记(乱码)。 */
export function displayHeadword(rawKey, html, queryWord){
  const k = String(rawKey || '');
  const clean = cleanGaijiMarkers(k);
  if (/^@|^\d+$/.test(clean)){
    const hw = extractHtmlHeadword(html);
    if (hw) return cleanGaijiMarkers(hw);
    return cleanGaijiMarkers(String(queryWord || ''));
  }
  return clean;
}

/** 把一个原始命中(词头+释义HTML)映射为 DictResult(供 renderer 展示) */
function toDictResult(headword, html, sourceName, sourceId){
  return {
    headword,
    reading: '',
    senses: [{ gloss: '', html: sanitizeMdxHtml(html) }],
    source: sourceName,
    sourceId: sourceId || sourceName,
  };
}

/* ================= 桌面版: Tauri 原生命令路径 ================= */

/** 取 Tauri invoke(默认动态 import;测试可注入桩)。返回 Promise<invoke> */
function getInvoke(invokeImpl){
  if (invokeImpl) return Promise.resolve(invokeImpl);
  return import('@tauri-apps/api/core').then(m => m.invoke);
}

/**
 * 创建走 Tauri 命令的 MDX Provider。
 * cfg: { id?, name, path, invokeImpl? } — path 为 .mdx 文件绝对路径;invokeImpl 测试注入。
 * 首次查询时惰性 mdx_open(解析文件头,坏文件当场报错);之后 mdx_lookup 走 Rust 端查询
 * (已含 @@@LINK 跟随与大小写兜底);未命中时 mdx_prefix 前缀补全(≤6 条,与浏览器版一致);
 * dispose 释放句柄。
 */
export function createTauriMdxProvider(cfg){
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + (cfg.path || name);
  const invokeImpl = cfg.invokeImpl;
  let handle = null;
  let openErr = null;
  let opening = null;

  async function ensure(){
    if (handle !== null) return handle;
    if (openErr) throw openErr;
    if (!opening){
      opening = (async () => {
        try {
          const invoke = await getInvoke(invokeImpl);
          const h = await invoke('mdx_open', { path: cfg.path });
          if (typeof h !== 'number' || !Number.isFinite(h)) throw new Error('mdx_open 返回非法句柄');
          handle = h;
        } catch (e){
          openErr = new Error('MDX 文件解析失败(' + name + '): ' + ((e && e.message) || e));
          throw openErr;
        } finally {
          opening = null;
        }
      })();
    }
    return opening;
  }

  async function lookupRaw(invoke, word){
    return invoke('mdx_lookup', { handle, word: String(word || '').trim() });
  }

  return {
    id, name,
    isConfigured(){ return true; }, // 路径已知即可配置;解析失败在查询时抛错
    async lookup(word){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      const hit = await lookupRaw(invoke, word);
      // 词头若是内部 ID(@jitendex-…/纯数字)则用 HTML 内真实词头或查询词显示
      if (hit) return [toDictResult(displayHeadword(hit.key_text, hit.definition, word), hit.definition || '', name, id)];
      // 未命中 → 前缀补全(与浏览器版 buildMdxResults 一致: 取前若干个近似词的词条)
      const pref = await invoke('mdx_prefix', { handle, word: String(word || ''), limit: 6 });
      const out = [];
      for (const kw of (Array.isArray(pref) ? pref : []).slice(0, 6)){
        try {
          const h = await lookupRaw(invoke, kw);
          if (h) out.push(toDictResult(h.key_text || kw, h.definition || '', name, id));
        } catch (e){ /* 单条失败跳过 */ }
      }
      return out;
    },
    async prefix(word, limit){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return invoke('mdx_prefix', { handle, word: String(word || ''), limit: limit || 6 });
    },
    /** 模糊(包含)搜索词头,返回词头数组(Rust 侧遍历词表) */
    async search(word, limit){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return invoke('mdx_search', { handle, word: String(word || ''), limit: limit || 20 });
    },
    isLoaded(){ return handle !== null; },
    dispose(){
      if (handle !== null){
        const h = handle;
        getInvoke(invokeImpl).then(invoke => invoke('mdx_close', { handle: h }).catch(() => {}));
        handle = null;
      }
    },
  };
}

/** 桌面版: MDD 资源包句柄管理(供词条内图片/音频加载)。cfg: { name, path, invokeImpl? } */
export function createTauriMdd(cfg){
  const name = cfg.name || 'MDD 资源包';
  const invokeImpl = cfg.invokeImpl;
  let handle = null;
  let openErr = null;
  let opening = null;
  async function ensure(){
    if (handle !== null) return handle;
    if (openErr) throw openErr;
    if (!opening){
      opening = (async () => {
        try {
          const invoke = await getInvoke(invokeImpl);
          handle = await invoke('mdd_open', { path: cfg.path });
        } catch (e){
          openErr = e;
          throw e;
        } finally { opening = null; }
      })();
    }
    return opening;
  }
  return {
    name,
    /** 取资源原始字节(ArrayBuffer;供 Audio/Blob 用) */
    async resource(key){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      const b64 = await invoke('mdd_resource', { handle, key });
      return b64 ? fsx.base64ToArrayBuffer(b64) : null;
    },
    /** 取资源 base64(直接拼 data URL,避免往返转换) */
    async resourceB64(key){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return await invoke('mdd_resource', { handle, key });
    },
    dispose(){
      if (handle !== null){
        const h = handle;
        getInvoke(invokeImpl).then(invoke => invoke('mdd_close', { handle: h }).catch(() => {}));
        handle = null;
      }
    },
  };
}

/* ================= 浏览器版: js-mdict + node-shims 路径(保持 v5.0 行为) ================= */

/** 清除 MDX 记录块尾部的填充字符(\r\n 与 NUL) */
function cleanDefinition(def){
  return String(def == null ? '' : def).replace(/\x00/g, '').replace(/\s+$/g, '');
}

/** 跟随 MDict 的 @@@LINK 跨词条引用(变体词 → 主词条),防循环,最多 3 跳 */
function resolveLink(inst, definition, sourceName, depth, sourceId){
  const m = /^@@@LINK=(.+)$/.exec(String(definition || '').trim());
  if (!m) return null;
  if (depth <= 0) return null;
  const target = m[1].trim();
  try {
    const hit = inst.lookup(target);
    if (!hit || !hit.definition) return null;
    const def2 = cleanDefinition(hit.definition);
    if (/^@@@LINK=/.test(def2)) return resolveLink(inst, def2, sourceName, depth - 1, sourceId);
    return {
      headword: hit.keyText || target,
      reading: '',
      senses: [{ gloss: '', html: sanitizeMdxHtml(def2) }],
      source: sourceName,
      sourceId: sourceId || sourceName,
    };
  } catch (e){ return null; }
}

/** 把一个 MDX 实例(或测试桩)的查询映射为 DictResult[](纯逻辑,可单测) */
export async function buildMdxResults(inst, word, sourceName, sourceId){
  const norm = String(word || '').trim();
  if (!norm || !inst) return [];
  const out = [];
  // 精确命中(词典键不区分大小写时 js-mdict 内部已归一;再兜底小写一次)
  let hit = null;
  try { hit = inst.lookup(norm); } catch (e){ /* 查询失败按未命中处理 */ }
  if (!hit || hit.definition == null || hit.definition === ''){
    try { hit = inst.lookup(norm.toLowerCase()); } catch (e){ hit = null; }
  }
  if (hit && hit.definition){
    const def = cleanDefinition(hit.definition);
    if (/^@@@LINK=/.test(def)){
      // @@@LINK 变体词 → 跟随到主词条;解析失败(目标缺失/循环)视为未命中
      const linked = resolveLink(inst, def, sourceName, 3, sourceId);
      if (linked){
        // 目标词头是内部 ID(如 @jitendex-123456 / 38658)时用 HTML 内真实词头(明镜等),
        // 否则回退查询词;普通词头显示「查询词 → 主词头」。
        const raw = linked.headword;
        const isInternal = /^@|^\d+$/.test(raw);
        linked.headword = displayHeadword(raw, (linked.senses[0] && linked.senses[0].html) || '', hit.keyText || norm);
        if (!isInternal) linked.headword = (hit.keyText || norm) + ' → ' + linked.headword;
        out.push(linked);
      }
    } else if (def){
      out.push({
        headword: hit.keyText || norm,
        reading: '',
        senses: [{ gloss: '', html: sanitizeMdxHtml(def) }],
        source: sourceName,
        sourceId: sourceId || sourceName,
      });
    }
    if (out.length) return out;
  }
  // 无精确命中 → 前缀补全(取前若干个近似词的词条)
  let pref = [];
  try { pref = inst.prefix(norm.toLowerCase()) || []; } catch (e){ pref = []; }
  for (const item of pref.slice(0, 6)){
    try {
      const d = inst.fetch(item);
      if (d && d.definition){
        const def = cleanDefinition(d.definition);
        if (/^@@@LINK=/.test(def)){
          const linked = resolveLink(inst, def, sourceName, 3, sourceId);
          if (linked){
            const raw = linked.headword;
            const isInternal = /^@|^\d+$/.test(raw);
            linked.headword = displayHeadword(raw, (linked.senses[0] && linked.senses[0].html) || '', d.keyText || item.keyText || norm);
            if (!isInternal) linked.headword = (d.keyText || item.keyText || norm) + ' → ' + linked.headword;
            out.push(linked);
          }
        } else if (def){
          out.push({
            headword: d.keyText || item.keyText || norm,
            reading: '',
            senses: [{ gloss: '', html: sanitizeMdxHtml(def) }],
            source: sourceName,
            sourceId: sourceId || sourceName,
          });
        }
      }
    } catch (e){ /* 单条失败跳过 */ }
  }
  return out;
}

/** 异步实例化: 补 Buffer polyfill → 注册内存文件 → 构造 MDX(解析文件头,坏文件当场报错) */
async function instantiateMdx(fakePath, buffer){
  // js-mdict 内部直接使用 Node 的 Buffer 全局,浏览器环境先补 polyfill
  if (typeof globalThis.Buffer === 'undefined'){
    const { Buffer } = await import('buffer');
    globalThis.Buffer = Buffer;
  }
  const { registerBuffer } = await import('./node-shims/fs.js');
  registerBuffer(fakePath, buffer);
  const mod = await import('js-mdict');
  return new mod.MDX(fakePath);
}

/**
 * 创建 MDX 词典 Provider(异步: 构造时即解析文件头,坏文件当场报错)。
 * cfg: { id?, name, buffer: ArrayBuffer }
 */
export async function createMdxProvider(cfg){
  if (!(cfg.buffer instanceof ArrayBuffer)) throw new Error('MDX 词典需要 ArrayBuffer 内容');
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + name;
  const fakePath = 'mdx-virtual://' + id;
  let inst;
  try {
    inst = await instantiateMdx(fakePath, cfg.buffer);
  } catch (e){
    const { unregisterBuffer } = await import('./node-shims/fs.js');
    unregisterBuffer(fakePath);
    throw new Error('MDX 文件解析失败(' + name + '): ' + (e && e.message ? e.message : e));
  }
  return {
    id, name,
    isConfigured(){ return !!inst; },
    async lookup(word){
      if (!inst) return [];
      return buildMdxResults(inst, word, name, id);
    },
    dispose(){
      import('./node-shims/fs.js').then(({ unregisterBuffer }) => unregisterBuffer(fakePath));
    },
  };
}

/**
 * 创建懒加载 MDX Provider(浏览器版 fetch 路径): 首次查询时才经 loadBuffer 读文件,
 * 之后缓存实例;loadBuffer 失败每次查询都会重试(文件可能临时不可用)。
 * cfg: { id?, name, loadBuffer: () => Promise<ArrayBuffer> }
 */
export function createPathMdxProvider(cfg){
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + name;
  const fakePath = 'mdx-virtual://' + id;
  let inst = null;
  let loading = null; // 并发去重: 同一时刻只有一次加载
  async function ensure(){
    if (inst) return inst;
    if (!loading){
      loading = (async () => {
        try {
          const buffer = await cfg.loadBuffer();
          if (!(buffer instanceof ArrayBuffer)) throw new Error('loadBuffer 未返回 ArrayBuffer');
          try {
            inst = await instantiateMdx(fakePath, buffer);
          } catch (e){
            const { unregisterBuffer } = await import('./node-shims/fs.js');
            unregisterBuffer(fakePath);
            throw new Error('MDX 文件解析失败(' + name + '): ' + (e && e.message ? e.message : e));
          }
        } finally {
          loading = null;
        }
      })();
    }
    return loading;
  }
  return {
    id, name,
    isConfigured(){ return true; }, // 路径已知即视为可配置;加载失败在查询结果里报错
    async lookup(word){
      await ensure();
      if (!inst) return [];
      return buildMdxResults(inst, word, name, id);
    },
    isLoaded(){ return !!inst; },
    dispose(){
      import('./node-shims/fs.js').then(({ unregisterBuffer }) => unregisterBuffer(fakePath));
      inst = null;
    },
  };
}
