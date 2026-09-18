// settings.js — 应用设置(解析规则 / 机翻配置)
// 存储: 桌面端写入软件目录(与 exe 同目录)的 settings.json;浏览器降级用 localStorage。
// 结构: { parse: { open, close, regex }, mt: { provider, ... } }
//
// ⚠️ 本文件只放**小体积**设置。浏览器端 localStorage 有 ~5MB 硬配额，写满即失败，
//    且失败会连带影响同一 blob 里的所有设置（主题、字体、上限一起丢）。
//    大块数据（背景图等）一律走 IndexedDB，见下方「背景图设置」。

import { isTauri, kvGet, kvPut, kvDel } from './fs.js';

const LS_KEY = 'galtrans_settings_v1';
const FILE = 'settings.json';

let cache = null;

/** localStorage 配额超限判定（各浏览器 code/name 不一致，全部兜一遍） */
export function isQuotaError(e){
  if (!e) return false;
  return e.name === 'QuotaExceededError'
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || e.code === 22 || e.code === 1014;
}

/** 配额超限时给用户看的说法：说清原因与可操作的出路，而不是裸的 DOMException */
export const QUOTA_HINT = '设置保存失败：浏览器本地存储已满（约 5MB）。'
  + '请在浏览器设置里清理本站数据，或改用桌面版（设置写入文件，没有此上限）。';

async function readFile(){
  if (isTauri()){
    const { readAppFile } = await import('./fs.js');
    const raw = await readAppFile(FILE);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
}

/**
 * 写设置文件，**从不抛异常**，返回 { ok, error? }。
 *
 * 设置保存散落在十余处调用点（主题/字体/上限/收藏/机翻配置…），任何一处抛出去
 * 都会打断用户当前正在做的事，而多数调用点并不关心中间失败。故改为返回状态：
 * 不关心的调用点照旧忽略返回值，关心的（如背景图保存）可以据此提示用户。
 */
async function writeFile(obj){
  if (isTauri()){
    try {
      const { writeAppFile } = await import('./fs.js');
      await writeAppFile(FILE, JSON.stringify(obj, null, 2));
      return { ok: true };
    } catch (e){ return { ok: false, error: e }; }
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
    return { ok: true };
  } catch (e){
    return { ok: false, error: isQuotaError(e) ? new Error(QUOTA_HINT) : e };
  }
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

/** 保存设置(更新缓存)。返回 { ok, error? }；写失败不抛异常，见 writeFile 说明。 */
export async function saveSettings(s){
  cache = s;
  return await writeFile(s);
}

export function clearSettingsCache(){ cache = null; }

/** 解析规则默认值 */
export function defaultParse(){ return { open: '☆', close: '★', regex: '' }; }

/* ---------------- 背景图设置 ---------------- */
//
// 背景图是 base64 data URL，动辄数 MB。放在 settings 里会顶爆浏览器 localStorage 的
// 配额，把主题、字体等一并拖没；桌面端则会把 settings.json 撑成几十万行、不再可读。
// 因此**图片本体存 IndexedDB**（`ui:background` 键），settings 里只留不占空间的显示参数。
//
// 桌面版同样走 IndexedDB（WebView2 支持；fs.js 的进度存储已有"文件优先、IndexedDB 兜底"
// 的同款先例）。kvGet/kvPut/kvDel 内部自吞异常，不可用时静默降级，不会打断启动流程。

const BG_KEY = 'ui:background';

/**
 * 保存背景图(base64 data URL)与显示设置。dataUrl 传空 = 移除背景。
 * @returns {{ok:boolean, error?:Error}} 设置部分的写盘状态（图片写 IndexedDB，失败静默）
 */
export async function saveBackground(dataUrl, opacity, fit){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  if (dataUrl){
    await kvPut(BG_KEY, { dataUrl });
    s.ui.hasBackground = true;
  } else {
    await kvDel(BG_KEY);
    s.ui.hasBackground = false;
  }
  delete s.ui.background; // 旧字段一律清掉，避免两份副本各占一份空间
  s.ui.backgroundOpacity = opacity !== undefined ? opacity : 0.82;
  s.ui.backgroundFit = fit || 'cover';
  return await saveSettings(s);
}

/** 读取背景图设置 → { dataUrl, opacity, fit } */
export async function loadBackground(){
  const s = await loadSettings();
  const ui = s.ui || {};
  const rec = await kvGet(BG_KEY);
  let dataUrl = (rec && typeof rec.dataUrl === 'string') ? rec.dataUrl : null;

  // 迁移：旧版把整张图存在 settings.ui.background 里 → 搬到 IndexedDB 并从设置里抹掉。
  // 仅在 IndexedDB 尚无图时搬，避免把新图覆盖回旧图。
  if (!dataUrl && typeof ui.background === 'string' && ui.background){
    dataUrl = ui.background;
    await kvPut(BG_KEY, { dataUrl });
    delete ui.background;
    ui.hasBackground = true;
    await saveSettings(s);
  }

  return {
    dataUrl,
    opacity: ui.backgroundOpacity !== undefined ? ui.backgroundOpacity : 0.82,
    fit: ui.backgroundFit || 'cover'
  };
}

/** 清除背景图(保留用户选的 fit 值,重设时沿用) */
export async function clearBackground(){
  const s = await loadSettings();
  await kvDel(BG_KEY);
  if (s.ui) { delete s.ui.background; s.ui.hasBackground = false; s.ui.backgroundOpacity = 0.82; }
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
 * 读取显示宽度上限（单位：全角字位）。未设置返回 null（调用方用 width.WIDTH_LIMIT_DEFAULT）。
 * 存 settings.ui.widthLimit；0 / 非法值语义是"不设上限"，由 width.normalizeWidthLimit 判。
 * 与 byteLimit 完全同构——两者是"字数校验"的两把不同尺子，用法必须一致。
 */
export async function loadWidthLimit(){
  const s = await loadSettings();
  return (s.ui && Number.isFinite(Number(s.ui.widthLimit))) ? Number(s.ui.widthLimit) : null;
}

/** 保存显示宽度上限到 settings.ui.widthLimit */
export async function saveWidthLimit(limit){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.widthLimit = limit;
  await saveSettings(s);
}

/**
 * 读取"是否核对译文里的控制符丢失"。**未设置时返回 false（默认关）**。
 *
 * 默认关是刻意的：断行类标签（`[r]` / `<r>` / 字面量 `\n`）译文本就要按中文长度
 * 重新断行，把它们当"丢失"报出来多数是噪音。需要时（例如目标引擎的**命令类**
 * 标签确实不能动）再由用户在设置里显式开启。
 * 存 settings.ui.checkControls。
 */
export async function loadCheckControls(){
  const s = await loadSettings();
  return !!(s.ui && s.ui.checkControls);
}

/** 保存"核对控制符丢失"开关到 settings.ui.checkControls（布尔） */
export async function saveCheckControls(on){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.checkControls = !!on;
  await saveSettings(s);
}

/**
 * 读取机翻语境句数（当前句前后各取几句作为上下文参考）。
 * 未设置返回 null（调用方用默认 2）；0 = 显式关闭。
 * 存 settings.ui.mtAround —— 刻意不放进 mt.providers：它作用于**两个** provider，
 * 而 providers 是分引擎存的，放进去会出现"切引擎后语境设置不一致"。
 */
export async function loadMtAround(){
  const s = await loadSettings();
  return (s.ui && Number.isFinite(Number(s.ui.mtAround))) ? Number(s.ui.mtAround) : null;
}

/** 保存机翻语境句数到 settings.ui.mtAround */
export async function saveMtAround(n){
  const s = await loadSettings();
  if (!s.ui) s.ui = {};
  s.ui.mtAround = n;
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

