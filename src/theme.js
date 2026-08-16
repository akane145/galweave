// theme.js — 主题/外观纯逻辑(可单测,无 DOM 依赖)
// 主题模式: dark(深色) / light(浅色) / bw(黑白)。
// 字体设置: orig(原文) 与 trans(译文) 各自的 family/size/color;
// family/color 为空 = 跟随主题默认变量(style.css 的 --mono-font / --orig-text 等)。

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

/** 字体默认值(size 17px 与现状一致;family/color 空=跟随主题变量) */
export function defaultFontSettings(){
  return {
    orig: { family: '', size: 17, color: '' },
    trans: { family: '', size: 17, color: '' },
  };
}

/** 单组归一化: 只保留合法值,size 钳到 8–72 */
function normalizeFontGroup(g){
  const src = (g && typeof g === 'object') ? g : {};
  const size = Number(src.size);
  return {
    family: (typeof src.family === 'string' && src.family.trim()) ? src.family.trim() : '',
    size: Number.isFinite(size) ? Math.min(72, Math.max(8, Math.round(size))) : 17,
    color: (typeof src.color === 'string' && src.color.trim()) ? src.color.trim() : '',
  };
}

/**
 * 用户字体设置与默认值合并(缺省/非法字段回退默认)。
 * user: { orig?: {family,size,color}, trans?: {family,size,color} }
 */
export function mergeFontSettings(user){
  const d = defaultFontSettings();
  const u = (user && typeof user === 'object') ? user : {};
  return {
    orig: { ...d.orig, ...normalizeFontGroup(u.orig) },
    trans: { ...d.trans, ...normalizeFontGroup(u.trans) },
  };
}
