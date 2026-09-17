// fonts.js — 自定义字体纯逻辑(无 DOM 依赖,配 tests/fonts.test.mjs)
// 职责: 字体文件识别 / 文件名 → 字体族+字重+字形 解析 / 字体库持久化数据归一化 /
//       CSS font-family 值拼装 / 按族分组。
// 真正把字节喂给 FontFace 并注册到 document.fonts 的运行时在 fontloader.js。

export const FONT_EXTS = ['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2'];

/** <input type=file accept> 与 Tauri 文件对话框的扩展名白名单(不含点) */
export const FONT_ACCEPT = FONT_EXTS.join(',');

/** 字体族名长度上限(normalizeFamily 截断) */
export const MAX_FAMILY_LEN = 120;

/** 字体库条目上限,防止把整个系统字体目录拖进来时无限膨胀 */
export const MAX_LIBRARY = 400;

/** 扫描字体文件夹时收录的文件数上限 */
export const MAX_FOLDER_FONTS = 400;

/** 单条关键字 → 字重数值(font-weight) */
export const WEIGHT_TOKENS = {
  thin: 100, hairline: 100,
  extralight: 200, ultralight: 200,
  light: 300,
  regular: 400, normal: 400, book: 400, roman: 400,
  medium: 500,
  semibold: 600, demibold: 600, demi: 600, semi: 600,
  bold: 700,
  extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

/** 字形关键字(全部按斜体处理) */
export const STYLE_TOKENS = ['italic', 'oblique', 'it'];

/** 从文件名/路径取扩展名(小写,不含点);无扩展名返回 '' */
export function fontExt(name){
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return '';
  return s.slice(i + 1).toLowerCase();
}

/** 是否受支持的字体文件(按扩展名判,不读内容) */
export function isFontFile(name){
  return FONT_EXTS.includes(fontExt(name));
}

/** 路径末段(取文件名) */
export function fileNameOf(p){
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 归一化字体族名: 去掉引号/反斜杠/分号/花括号/逗号与控制字符(它们会破坏 CSS 值),
 * 压平空白、去首尾、截断到 MAX_FAMILY_LEN。非法输入返回 ''。
 */
export function normalizeFamily(v){
  if (typeof v !== 'string') return '';
  const s = v
    .replace(/["'\\;{},]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_FAMILY_LEN ? s.slice(0, MAX_FAMILY_LEN).trim() : s;
}

function isStyleToken(low){ return STYLE_TOKENS.includes(low); }

/** 字重关键字 → 数值;不认识返回 null */
function weightOf(low){
  return Object.prototype.hasOwnProperty.call(WEIGHT_TOKENS, low) ? WEIGHT_TOKENS[low] : null;
}

function isAsciiToken(s){
  if (!s) return false;
  for (let i = 0; i < s.length; i++){
    const c = s.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const upper = c >= 65 && c <= 90;
    const lower = c >= 97 && c <= 122;
    if (!digit && !upper && !lower) return false;
  }
  return true;
}

/**
 * 解析单个尾段关键字 → { weight, style } 或 null(不是关键字)。
 * 支持复合写法: SemiBold / ExtraLight / BoldItalic / BoldIt / BoldOblique。
 */
function expandToken(raw){
  const t = String(raw || '').trim();
  if (!t) return null;
  const low = t.toLowerCase();
  const w = weightOf(low);
  if (w !== null) return { weight: w, style: null };
  if (isStyleToken(low)) return { weight: null, style: 'italic' };
  // 复合词: 尾部是字形关键字,前面可能还带一个字重(没有则只算字形)
  for (const st of STYLE_TOKENS){
    if (low === st || low.length <= st.length || !low.endsWith(st)) continue;
    const head = low.slice(0, low.length - st.length);
    const headWeight = weightOf(head);
    if (headWeight !== null) return { weight: headWeight, style: 'italic' };
  }
  return null;
}

/** 在最后一个分隔符(空格/-/_)处切出尾段;尾段必须是纯 ASCII 字母数字,否则视为无尾段 */
function splitTail(s){
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i--){
    const c = s.charAt(i);
    if (c === ' ' || c === '-' || c === '_'){ cut = i; break; }
  }
  if (cut <= 0) return null;
  const tail = s.slice(cut + 1);
  if (!isAsciiToken(tail)) return null;
  return { head: s.slice(0, cut).trim(), tail };
}

/**
 * 从文件名主干里剥掉尾部的字重/字形段。
 * 逐段从尾部尝试,遇到非关键字立刻停。
 * 例: "SourceHanSerifSC-Bold" → { family:'SourceHanSerifSC', weight:700, style:null }
 *     "Sarasa Mono SC Regular" → { family:'Sarasa Mono SC', weight:400 }
 *     "Noto Sans JP" → { family:'Noto Sans JP', weight:null }(JP 不是关键字)
 */
function splitWeightSuffix(stem){
  let s = stem;
  let weight = null;
  let style = null;
  for (let i = 0; i < 4; i++){
    const parts = splitTail(s);
    if (!parts) break;
    const parsed = expandToken(parts.tail);
    if (!parsed) break;
    if (parsed.weight !== null) weight = parsed.weight;
    if (parsed.style) style = parsed.style;
    s = parts.head;
  }
  return { family: s.trim(), weight, style };
}

/**
 * 文件名 → { family, weight, style, ext }。
 * 文件名里没有字重信息时 weight 默认 400、style 默认 normal。
 * 字体族名只做字符串推导(不解析字体内部 name 表),保证与用户看到的文件名一致。
 */
export function parseFontName(fileName){
  const base = fileNameOf(fileName);
  const ext = fontExt(base);
  const stem = (ext ? base.slice(0, base.length - ext.length - 1) : base) || base;
  const { family, weight, style } = splitWeightSuffix(stem);
  return {
    family: normalizeFamily(family) || normalizeFamily(stem) || 'Custom Font',
    weight: weight === null ? 400 : weight,
    style: style || 'normal',
    ext,
  };
}

/**
 * 条目去重键。桌面端用绝对路径;浏览器文件夹用相对路径;浏览器导入文件用
 * 文件名+大小+修改时间(File 对象没有持久路径)。
 */
export function entryKey(e){
  const o = (e && typeof e === 'object') ? e : {};
  if (o.path) return 'p:' + String(o.path).toLowerCase();
  if (Array.isArray(o.relPath) && o.relPath.length) return 'h:' + o.relPath.join('/').toLowerCase();
  return 'f:' + [o.name, o.size, o.mtime]
    .map(v => (v === undefined || v === null) ? '' : String(v))
    .join('|')
    .toLowerCase();
}

/** 单条字体记录归一化;无法识别(缺文件名且缺族名)返回 null */
export function normalizeEntry(raw){
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const parsed = name ? parseFontName(name) : null;
  const family = normalizeFamily(raw.family) || (parsed ? parsed.family : '');
  if (!family) return null;
  const weight = Number(raw.weight);
  const size = Number(raw.size);
  const mtime = Number(raw.mtime);
  const entry = {
    id: '',
    family,
    weight: Number.isFinite(weight) ? Math.min(900, Math.max(100, Math.round(weight))) : (parsed ? parsed.weight : 400),
    style: raw.style === 'italic' ? 'italic' : 'normal',
    ext: fontExt(name) || FONT_EXTS[0],
    name: name || family,
    src: raw.src === 'folder' ? 'folder' : 'file',
  };
  if (Number.isFinite(size) && size >= 0) entry.size = size;
  if (Number.isFinite(mtime) && mtime > 0) entry.mtime = mtime;
  if (typeof raw.path === 'string' && raw.path) entry.path = raw.path;
  if (Array.isArray(raw.relPath) && raw.relPath.length){
    entry.relPath = raw.relPath.filter(p => typeof p === 'string' && p);
    if (!entry.relPath.length) delete entry.relPath;
  }
  entry.id = (typeof raw.id === 'string' && raw.id) ? raw.id : entryKey(entry);
  return entry;
}

/**
 * 归一化持久化的字体库对象 → { folder, folderName, files }。
 * folder: 桌面端绝对路径;folderName: 浏览器端文件夹显示名。
 * 条目按 id 去重(后写覆盖先写),总数截到 MAX_LIBRARY。
 */
export function mergeFontLibrary(raw){
  const src = (raw && typeof raw === 'object') ? raw : {};
  const list = Array.isArray(src.files) ? src.files : [];
  const seen = new Map();
  for (const item of list){
    const e = normalizeEntry(item);
    if (e) seen.set(e.id, e);
  }
  return {
    folder: typeof src.folder === 'string' ? src.folder : '',
    folderName: typeof src.folderName === 'string' ? src.folderName : '',
    files: [...seen.values()].slice(0, MAX_LIBRARY),
  };
}

/** 合并新条目进库(按 id 覆盖),返回新库对象 */
export function addEntries(lib, entries){
  const base = mergeFontLibrary(lib);
  const seen = new Map(base.files.map(f => [f.id, f]));
  for (const item of (Array.isArray(entries) ? entries : [])){
    const e = normalizeEntry(item);
    if (e) seen.set(e.id, e);
  }
  return { ...base, files: [...seen.values()].slice(0, MAX_LIBRARY) };
}

/** 移除某个来源的条目: src='folder' 清掉整个文件夹的收录 */
export function removeBySource(lib, src){
  const base = mergeFontLibrary(lib);
  return { ...base, files: base.files.filter(f => f.src !== src) };
}

/** 移除一个字体族(该族所有字重/字形条目) */
export function removeFamily(lib, family){
  const base = mergeFontLibrary(lib);
  const key = normalizeFamily(family).toLowerCase();
  return { ...base, files: base.files.filter(f => f.family.toLowerCase() !== key) };
}

/** 字体库是否已收录某族(大小写不敏感) */
export function isImportedFamily(lib, family){
  const key = normalizeFamily(family).toLowerCase();
  if (!key) return false;
  return mergeFontLibrary(lib).files.some(f => f.family.toLowerCase() === key);
}

/** 字重中文名(列表展示用) */
export function weightLabel(w){
  const n = Number(w);
  if (!Number.isFinite(n)) return '常规';
  if (n <= 150) return '极细';
  if (n <= 250) return '特细';
  if (n <= 350) return '细体';
  if (n <= 450) return '常规';
  if (n <= 550) return '中等';
  if (n <= 650) return '半粗';
  if (n <= 750) return '粗体';
  if (n <= 850) return '特粗';
  return '黑体';
}

/** 单条目展示名: 字重(+斜体) */
export function faceLabel(face){
  const f = (face && typeof face === 'object') ? face : {};
  return weightLabel(f.weight) + (f.style === 'italic' ? ' 斜体' : '');
}

/** 字节数 → 人类可读;非法输入返回 '' */
export function formatBytes(n){
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return v + ' B';
  const kb = v / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
  const mb = kb / 1024;
  return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
}

/**
 * 按族分组,组内按字重→字形排序。
 * → [{ family, faces:[entry...], totalSize, weightText }]
 */
export function groupFonts(files){
  const list = (Array.isArray(files) ? files : []).map(normalizeEntry).filter(Boolean);
  const map = new Map();
  for (const f of list){
    const key = f.family.toLowerCase();
    if (!map.has(key)) map.set(key, { family: f.family, faces: [] });
    map.get(key).faces.push(f);
  }
  const groups = [...map.values()];
  for (const g of groups){
    g.faces.sort((a, b) => (a.weight - b.weight) || a.style.localeCompare(b.style) || a.name.localeCompare(b.name));
    const total = g.faces.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
    g.totalSize = total;
    const labels = g.faces.map(faceLabel);
    g.weightText = labels.filter((v, i) => labels.indexOf(v) === i).join(' / ');
  }
  groups.sort((a, b) => a.family.localeCompare(b.family, undefined, { numeric: true, sensitivity: 'base' }));
  return groups;
}

/**
 * 拼 CSS font-family 值: 族名始终加引号(引号形式对任意族名都合法),
 * 后接主题回退栈,避免自定义字体缺字时整段掉到 UI 默认字体。
 * family 为空返回 ''(调用方据此不写该属性,让 CSS 里的 var() 回退生效)。
 */
export function cssFamilyValue(family, fallback){
  const f = normalizeFamily(family);
  if (!f) return '';
  const quoted = '"' + f.replace(/\\/g, '') + '"';
  return fallback ? quoted + ', ' + fallback : quoted;
}
