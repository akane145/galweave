// theme.js — 主题/外观纯逻辑(可单测,无 DOM 依赖)
// 主题模式: dark(深色) / light(浅色) / bw(黑白)。
// 字体设置: orig(原文) 与 trans(译文) 各自的 family/size/color;
// family/color 为空 = 跟随主题默认变量(style.css 的 --mono-font / --orig-text 等)。
// 颜色按主题分槽:color(深色) / colorLight(浅色) / colorBw(黑白),见 colorForMode。

export const THEME_MODES = ['dark', 'light', 'bw'];

/** 归一化模式字符串,非法值回退 dark */
export function normalizeThemeMode(mode){
  return THEME_MODES.includes(mode) ? mode : 'dark';
}

/** 循环切到下一个模式(dark→light→bw→dark) */
export function nextThemeMode(mode){
  const cur = normalizeThemeMode(mode);
  return THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
}

/** 快速切换按钮的图标(按模式) */
export function themeButtonIcon(mode){
  switch (normalizeThemeMode(mode)){
    case 'light': return '🌞';
    case 'bw': return '⬛';
    default: return '🌓';
  }
}

/* ---------------- 字体设置 ---------------- */

/**
 * 字体默认值(size 17px 与现状一致;family/color 空=跟随主题变量)。
 * 颜色按主题分槽保存:color=深色、colorLight=浅色、colorBw=黑白,
 * 切换主题时自动换用对应槽位,不再需要手动换字体颜色。
 */
export function defaultFontSettings(){
  return {
    orig: { family: '', size: 17, color: '', colorLight: '', colorBw: '' },
    trans: { family: '', size: 17, color: '', colorLight: '', colorBw: '' },
  };
}

/** 单组归一化: 只保留合法值,size 钳到 8–72 */
function normalizeFontGroup(g){
  const src = (g && typeof g === 'object') ? g : {};
  const size = Number(src.size);
  const color = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : '';
  return {
    family: (typeof src.family === 'string' && src.family.trim()) ? src.family.trim() : '',
    size: Number.isFinite(size) ? Math.min(72, Math.max(8, Math.round(size))) : 17,
    // color 为旧版单色字段:兼容保留,语义=深色主题下的颜色
    color: color(src.color),
    colorLight: color(src.colorLight),
    colorBw: color(src.colorBw),
  };
}

/**
 * 用户字体设置与默认值合并(缺省/非法字段回退默认)。
 * user: { orig?: {family,size,color,colorLight,colorBw}, trans?: {...} }
 * 旧版数据只有 color 一项,视为深色主题的颜色,浅色/黑白回退跟随主题。
 */
export function mergeFontSettings(user){
  const d = defaultFontSettings();
  const u = (user && typeof user === 'object') ? user : {};
  return {
    orig: { ...d.orig, ...normalizeFontGroup(u.orig) },
    trans: { ...d.trans, ...normalizeFontGroup(u.trans) },
  };
}

/** 取某主题模式下应生效的颜色槽位(空串=跟随主题变量) */
export function colorForMode(group, mode){
  const g = (group && typeof group === 'object') ? group : {};
  const m = normalizeThemeMode(mode);
  const v = m === 'light' ? g.colorLight : (m === 'bw' ? g.colorBw : g.color);
  return (typeof v === 'string' && v.trim()) ? v.trim() : '';
}

/* ---------------- 阅读密度（规范 §6.2） ---------------- */

/**
 * 三档密度。取值必须与 style.css 的 `:root[data-density="…"]` 对齐
 * （见 src/style.css「密度三档」段）：
 *   compact 紧凑 / cozy 标准（= 不设 data-density 的默认值）/ loose 宽松
 * 规范 §6.2 里写的是 compact/default/relaxed，实现落地时改成了 cozy/loose，
 * 此处以**代码为准**，文档同步已更正。
 */
export const DENSITY_MODES = ['compact', 'cozy', 'loose'];

/** 归一化密度：非法值回退 cozy（默认档） */
export function normalizeDensity(mode){
  return DENSITY_MODES.includes(mode) ? mode : 'cozy';
}

/** 密度中文名（设置项 UI 用） */
export function densityLabel(mode){
  switch (normalizeDensity(mode)){
    case 'compact': return '紧凑';
    case 'loose': return '宽松';
    default: return '标准';
  }
}

/**
 * 密度的 CSS 属性值：cozy 是 :root 默认值，**不下发属性**（避免多一层无意义的选择器匹配）。
 * 返回 null 表示调用方应 removeAttribute('data-density')。
 */
export function densityAttr(mode){
  const m = normalizeDensity(mode);
  return m === 'cozy' ? null : m;
}

/* ---------------- 文本区透明度 ---------------- */

/** 文本区透明度默认值：0 = 实色（与未引入该项前的渲染一致） */
export const TEXT_AREA_TRANSPARENCY_DEFAULT = 0;

/**
 * 归一化文本区透明度：0–100 的整数百分比（0 = 实色，100 = 完全透出背景）。
 * 非法/越界值回退或钳位，保证下发到 CSS 的永远是合法百分比。
 */
export function normalizeTextAreaTransparency(v){
  const n = Number(v);
  if (!Number.isFinite(n)) return TEXT_AREA_TRANSPARENCY_DEFAULT;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * 透明度(0=实色) → CSS 不透明度百分比(100%=实色)，写入 --text-area-alpha。
 * 两者互为补数：UI 用「透明度」表述更直观，CSS 用 opacity 语义。
 */
export function textAreaAlpha(transparency){
  return (100 - normalizeTextAreaTransparency(transparency)) + '%';
}
