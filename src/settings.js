// settings.js — 应用设置(解析规则 / 机翻配置)
// 存储: 桌面端写入软件目录(与 exe 同目录)的 settings.json;浏览器降级用 localStorage。
// 结构: { parse: { open, close, regex }, mt: { provider, ... } }

import { isTauri } from './fs.js';

const LS_KEY = 'galtrans_settings_v1';
const FILE = 'settings.json';

let cache = null;

async function readFile(){
  if (isTauri()){
    const { readAppFile } = await import('./fs.js');
    const raw = await readAppFile(FILE);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
}

async function writeFile(obj){
  if (isTauri()){
    const { writeAppFile } = await import('./fs.js');
    await writeAppFile(FILE, JSON.stringify(obj, null, 2));
    return;
  }
  localStorage.setItem(LS_KEY, JSON.stringify(obj));
}

/** 加载设置(内存缓存) */
export async function loadSettings(){
  if (cache) return cache;
  const s = (await readFile()) || {};
  if (!s.parse) s.parse = { open: '☆', close: '★', regex: '' };
  if (!s.mt) s.mt = {};
  cache = s;
  return cache;
}

/** 保存设置(更新缓存) */
export async function saveSettings(s){
  cache = s;
  await writeFile(s);
}

export function clearSettingsCache(){ cache = null; }

/** 解析规则默认值 */
export function defaultParse(){ return { open: '☆', close: '★', regex: '' }; }

/* ---------------- 背景图设置 ---------------- */

/**
 * 保存背景图(base64 data URL)与显示设置。
 * fit: cover=铺满裁剪(默认) / contain=完整显示 / stretch=拉伸铺满 / tile=平铺 / auto=原始大小居中
 */
export async function saveBackground(dataUrl, opacity, fit){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.background = dataUrl || null;
  s.ui.backgroundOpacity = opacity !== undefined ? opacity : 0.82;
  s.ui.backgroundFit = fit || 'cover';
  await saveSettings(s);
  return s.ui;
}

/** 读取背景图设置 → { dataUrl, opacity, fit } */
export async function loadBackground(){
  const s = await loadSettings();
  const ui = s.ui || {};
  return {
    dataUrl: ui.background || null,
    opacity: ui.backgroundOpacity !== undefined ? ui.backgroundOpacity : 0.82,
    fit: ui.backgroundFit || 'cover'
  };
}

/** 清除背景图(保留用户选的 fit 值,重设时沿用) */
export async function clearBackground(){
  const s = await loadSettings();
  if (s.ui) { s.ui.background = null; s.ui.backgroundOpacity = 0.82; }
  await saveSettings(s);
}

/* ---------------- 主题模式 ---------------- */

/** 读取主题模式(dark/light/bw),未设置返回 null(调用方决定默认/迁移) */
export async function loadThemeMode(){
  const s = await loadSettings();
  return (s.ui && s.ui.mode) || null;
}

/** 保存主题模式到 settings.ui.mode */
export async function saveThemeMode(mode){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.mode = mode;
  await saveSettings(s);
}

/* ---------------- 字体设置(原文/译文) ---------------- */

/** 读取字体设置 → { orig:{family,size,color}, trans:{family,size,color} }(未设置返回 null) */
export async function loadFontSettings(){
  const s = await loadSettings();
  return (s.ui && s.ui.font) || null;
}

/** 保存字体设置到 settings.ui.font(仅存用户设置项) */
export async function saveFontSettings(font){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.font = font;
  await saveSettings(s);
}

/* ---------------- 词典收藏 ---------------- */

/** 读取词典收藏 → [{word,reading,source,at}](未设置返回 []) */
export async function loadFavorites(){
  const s = await loadSettings();
  return Array.isArray(s.dictFavorites) ? s.dictFavorites : [];
}

/** 保存词典收藏列表 */
export async function saveFavorites(list){
  const s = await loadSettings();
  s.dictFavorites = Array.isArray(list) ? list : [];
  await saveSettings(s);
}

