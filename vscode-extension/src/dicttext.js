// dicttext.js — MDX 词条清洗与"光标处取词"（纯逻辑，无 DOM、无 vscode 依赖）
//
// 词条清洗为什么不复用 src/mdx.js 的 sanitizeMdxHtml：那个函数走 DOMParser，
// 在扩展宿主（Node）里 DOMParser 不存在，它会**原样返回输入**，等于没洗。
// 这里只要纯文本，用正则足够，也不必依赖 DOM。

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—',
  ndash: '–', middot: '·', times: '×', deg: '°', copy: '©', reg: '®',
};

/** HTML 实体 → 字符（含数字实体） */
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const hit = ENTITIES[body];
    return hit === undefined ? m : hit;
  });
}

/**
 * 词条 HTML → 可读纯文本。
 * 块级标签换成换行、行内标签直接去掉，最后压掉多余空行。
 */
export function htmlToText(html) {
  let s = String(html == null ? '' : html);
  // 整块丢弃：脚本、样式、注释
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // 块级/换行类标签 → 换行
  s = s.replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|section|table|ul|ol|dl|dt|dd)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '・');
  // 其余标签剥掉
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  // 规整空白：行尾去空格、连续空行压成一个
  s = s.split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/* ---------------- @@@LINK 重定向 ----------------
 *
 * MDX 的标准重定向机制：词条正文是 `@@@LINK=<目标>`，真正的内容挂在目标词条下。
 * 实测 14 部词典里有 11 部对「天気」返回的是重定向（`@@@LINK=てんき【天気】`，
 * 明鏡那种则指向内部编号 `@@@LINK=43031`）。不跟随的话用户看到的就是一串
 * `@@@LINK=...` 而不是释义 —— 桌面版的 Rust 侧有 lookup_follow（mdict.rs:514）
 * 专门处理这件事，这里补上等价逻辑。
 */

/** 单个重定向目标的最大长度，超过就不像是链接了 */
const MAX_LINK_LEN = 200;

/**
 * 从词条正文里取出重定向目标；不是重定向返回 null。
 * 定义必须以 `@@@LINK=` 开头（允许前置空白），且目标里不该有换行。
 */
export function followTarget(definition) {
  const s = String(definition == null ? '' : definition);
  const m = s.match(/^[\s\u0000]*@@@LINK=([^\u0000\r\n]*)/);
  if (!m) return null;
  const target = m[1].trim();
  if (!target || target.length > MAX_LINK_LEN) return null;
  return target;
}

/** 是否是纯重定向条目（除了链接行没有别的正文） */
export function isPureLink(definition) {
  const s = String(definition == null ? '' : definition);
  if (!followTarget(s)) return false;
  // 去掉链接行与空白/空字符后应当什么都不剩
  const rest = s.replace(/^[\s\u0000]*@@@LINK=[^\u0000\r\n]*/, '').replace(/[\s\u0000]/g, '');
  return rest === '';
}

/* ---------------- 光标处取词 ---------------- */

/** 日语词字符：平假名、片假名、汉字、々、ー、半角片假名 */
const JP_CHAR = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f\u3005\u30fc]/;

/** 取包含某位置的日语连续串，返回 [from, to)；位置不在日语串上则 null */
export function wordRunAt(text, char) {
  const s = String(text == null ? '' : text);
  const i = Math.max(0, Math.min(char, s.length));
  // 位置落在字符间隙：先看右侧，再看左侧，保证点在词尾也能取到
  const seed = (i < s.length && JP_CHAR.test(s[i])) ? i : (i > 0 && JP_CHAR.test(s[i - 1]) ? i - 1 : -1);
  if (seed < 0) return null;
  let from = seed, to = seed + 1;
  while (from > 0 && JP_CHAR.test(s[from - 1])) from--;
  while (to < s.length && JP_CHAR.test(s[to])) to++;
  return { from, to };
}

/**
 * 生成候选词，**长的在前**，调用方按序查词典、命中即止。
 *
 * 为什么要一串候选：日语没有空格，MDX 又只认精确词头。取到的最长连续串常常
 * 比实际词长（「ありがとうございました」），逐级缩短到 2 字再试，能在不做分词的前提下
 * 拿到可用结果。全部候选都限制在锁定位置附近，不会跑到别的词上。
 */
export function candidatesAt(text, char, opts = {}) {
  const maxLen = opts.maxLen || 12;
  const minLen = opts.minLen || 2;
  const run = wordRunAt(text, char);
  if (!run) return [];
  const s = String(text);
  const runText = s.slice(run.from, run.to);
  if (runText.length < minLen) return [runText].filter(Boolean);

  const rel = Math.max(0, Math.min(char - run.from, runText.length));
  const out = [];
  const seen = new Set();
  // 以光标为中心向两边扩，先出短的，再由下面的排序统一成"长的在前"
  for (let len = Math.min(maxLen, runText.length); len >= minLen; len--) {
    let start = Math.max(0, Math.min(rel - Math.floor(len / 2), runText.length - len));
    for (; start + len <= runText.length && start <= rel; start++) {
      if (rel < start || rel > start + len) continue;
      const cand = runText.slice(start, start + len);
      if (seen.has(cand)) continue;
      seen.add(cand);
      out.push(cand);
      if (out.length >= maxLen) break;
    }
    if (out.length >= maxLen) break;
  }
  return out.sort((a, b) => b.length - a.length);
}
