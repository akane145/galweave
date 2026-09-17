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

/* ---------------- 自定义字体库(导入文件 / 指定文件夹) ---------------- */

/**
 * 读取自定义字体库 → { folder, folderName, files }(未设置返回 null)。
 * 归一化/去重由 fonts.mergeFontLibrary 负责;这里只负责取原始数据。
 * 浏览器端字体字节存在 IndexedDB(fontloader),这里只存元数据。
 */
export async function loadFontLibrary(){
  const s = await loadSettings();
  return (s.ui && s.ui.fontLibrary) || null;
}

/** 保存自定义字体库到 settings.ui.fontLibrary */
export async function saveFontLibrary(lib){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.fontLibrary = lib;
  await saveSettings(s);
}

/* ---------------- 文本区透明度 ---------------- */

/**
 * 读取文本区透明度（0–100，0 = 实色）。
 * 未设置返回 null，由 theme.normalizeTextAreaTransparency 兜底默认值。
 * 存 settings.ui.textAreaTransparency。
 */
export async function loadTextAreaTransparency(){
  const s = await loadSettings();
  const v = s.ui ? Number(s.ui.textAreaTransparency) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** 保存文本区透明度到 settings.ui.textAreaTransparency */
export async function saveTextAreaTransparency(v){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.textAreaTransparency = v;
  await saveSettings(s);
}

/* ---------------- 界面偏好(阅读密度 / 字节计数口径) ---------------- */

/**
 * 读取阅读密度(compact/cozy/loose)。未设置返回 null,由调用方决定默认档。
 * 存 settings.ui.density,校验与回退在 theme.normalizeDensity 里统一做。
 */
export async function loadDensity(){
  const s = await loadSettings();
  return (s.ui && s.ui.density) || null;
}

/** 保存阅读密度到 settings.ui.density */
export async function saveDensity(mode){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.density = mode;
  await saveSettings(s);
}

/**
 * 读取字节计数口径(utf8/sjis)。未设置返回 null(默认 utf8)。
 * 存 settings.ui.byteEncoding,校验与回退在 bytes.normalizeEncoding 里统一做。
 */
export async function loadByteEncoding(){
  const s = await loadSettings();
  return (s.ui && s.ui.byteEncoding) || null;
}

/** 保存字节计数口径到 settings.ui.byteEncoding */
export async function saveByteEncoding(enc){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.byteEncoding = enc;
  await saveSettings(s);
}

/**
 * 读取字数上限。未设置返回 null（调用方用 bytes.BYTE_LIMIT_DEFAULT）。
 * 存 settings.ui.byteLimit；0 / 非法值语义是"不设上限"，由 bytes.normalizeByteLimit 判。
 */
export async function loadByteLimit(){
  const s = await loadSettings();
  return (s.ui && Number.isFinite(Number(s.ui.byteLimit))) ? Number(s.ui.byteLimit) : null;
}

/** 保存字数上限到 settings.ui.byteLimit */
export async function saveByteLimit(limit){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.byteLimit = limit;
  await saveSettings(s);
}

/* ---------------- 词典历史 ---------------- */

/** 读取查词历史 → [{word,at,source}]（未设置返回 []） */
export async function loadDictHistory(){
  const s = await loadSettings();
  return Array.isArray(s.dictHistory) ? s.dictHistory : [];
}

/** 保存查词历史列表 */
export async function saveDictHistory(list){
  const s = await loadSettings();
  s.dictHistory = Array.isArray(list) ? list : [];
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

