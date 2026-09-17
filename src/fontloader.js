// fontloader.js — 自定义字体的运行时加载(FontFace API + 三种取字节来源)
// 纯逻辑(文件名解析/库归一化/分组)在 fonts.js;这里是唯一碰 DOM / 文件系统的地方。
//
// 取字节来源按平台分三条路:
//   桌面端   entry.path      → Rust read_file_b64,只存路径,不复制字体文件
//   浏览器文件夹 entry.relPath + 持久化的目录句柄 → 按需读,不占额外存储
//   浏览器导入文件 entry.id   → IndexedDB 里的 Blob(File 可结构化克隆)
//
// 字体按族懒加载: 库里收录几百个字体文件也不会有启动开销,只有真正被选用的族才读盘/注册。

import { isTauri, readFileB64, base64ToArrayBuffer, kvGet, kvPut, kvDel, listDirTree } from './fs.js';
import * as fonts from './fonts.js';

/** 浏览器端目录句柄的 IndexedDB 键 */
const HANDLE_KEY = 'galweave:fontdir';
/** 浏览器端单个字体文件的 IndexedDB 键前缀 */
const BLOB_PREFIX = 'galweave:fontblob:';

/** 单个字体文件字节上限,超过直接拒绝(避免一次性把内存打爆) */
export const MAX_FONT_BYTES = 96 * 1024 * 1024;

/** 浏览器端扫描文件夹时按目录名跳过的目录 */
const SKIP_DIRS = new Set(['node_modules', 'system volume information', '$recycle.bin']);

const DOM_READY = typeof document !== 'undefined' && typeof FontFace !== 'undefined';

/** 已注册到 document.fonts 的族 → FontFace[](按族缓存,重复调用不重复注册) */
const faces = new Map();
/** 正在加载的族 → Promise(并发去重: 同一族同时只加载一次) */
const loading = new Map();
/** 浏览器端当前字体文件夹句柄(不落盘时也在内存里留一份) */
let dirHandle = null;

function fail(reason, message){
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}

export function isFamilyLoaded(family){
  return faces.has(fonts.normalizeFamily(family));
}

/** 已注册的族名列表(供状态显示/排查) */
export function loadedFamilies(){
  return [...faces.keys()];
}

/** 浏览器端字体文件夹的目录名;未指定返回 '' */
export function folderHandleName(){
  return dirHandle ? (dirHandle.name || '') : '';
}

export function hasFolderHandle(){
  return !!dirHandle;
}

/* ---------------- 取字节 ---------------- */

/** 解析浏览器目录句柄里的相对路径 → FileSystemFileHandle */
async function resolveFileHandle(root, relPath){
  let dir = root;
  for (let i = 0; i < relPath.length - 1; i++){
    dir = await dir.getDirectoryHandle(relPath[i]);
  }
  return await dir.getFileHandle(relPath[relPath.length - 1]);
}

/** 取已持久化的目录句柄;权限已失效返回 null */
async function ensureDirHandle(){
  if (!dirHandle){
    try {
      const h = await kvGet(HANDLE_KEY);
      if (h && h.kind === 'directory') dirHandle = h;
    } catch (e) { /* 读不到就当没设过 */ }
  }
  if (!dirHandle) return null;
  if (typeof dirHandle.queryPermission === 'function'){
    try {
      const st = await dirHandle.queryPermission({ mode: 'read' });
      if (st !== 'granted') return null;
    } catch (e){ return null; }
  }
  return dirHandle;
}

/** 按条目取字体字节;失败抛带 reason 的 Error('permission'|'missing') */
async function bytesFor(entry){
  if (entry.path && isTauri()){
    try {
      return base64ToArrayBuffer(await readFileB64(entry.path));
    } catch (e){
      throw fail('missing', '读不到字体文件');
    }
  }
  if (Array.isArray(entry.relPath) && entry.relPath.length){
    const root = await ensureDirHandle();
    if (!root) throw fail('permission', '字体文件夹未授权');
    try {
      const fh = await resolveFileHandle(root, entry.relPath);
      const file = await fh.getFile();
      return await file.arrayBuffer();
    } catch (e){
      throw fail('missing', '读不到字体文件');
    }
  }
  let blob = null;
  try { blob = await kvGet(BLOB_PREFIX + entry.id); } catch (e) { blob = null; }
  if (!blob) throw fail('missing', '字体数据已丢失,请重新导入');
  if (blob instanceof Blob) return await blob.arrayBuffer();
  return blob;
}

/* ---------------- 注册 / 卸载 ---------------- */

/**
 * 加载并注册一个字体族(该族所有字重/字形)。
 * 返回值: { family, loaded, failed, reasons, cached }
 *   reasons 是去重后的失败原因(permission/missing/invalid/too-big/unsupported)
 */
export async function loadFamily(family, files){
  const fam = fonts.normalizeFamily(family);
  if (!fam) return { family: '', loaded: 0, failed: 0, reasons: [] };
  if (faces.has(fam)) return { family: fam, loaded: faces.get(fam).length, failed: 0, reasons: [], cached: true };
  if (loading.has(fam)) return loading.get(fam);
  if (!DOM_READY) return { family: fam, loaded: 0, failed: 1, reasons: ['unsupported'] };

  const job = (async () => {
    const list = fonts.groupFonts(files).find(g => g.family.toLowerCase() === fam.toLowerCase());
    const made = [];
    const reasons = [];
    if (list){
      for (const f of list.faces){
        try {
          const buf = await bytesFor(f);
          if (!buf || !buf.byteLength) throw fail('invalid', '空文件');
          if (buf.byteLength > MAX_FONT_BYTES) throw fail('too-big', '文件过大');
          const face = new FontFace(fam, buf, { weight: String(f.weight), style: f.style });
          await face.load();
          document.fonts.add(face);
          made.push(face);
        } catch (e){
          const r = (e && e.reason) ? e.reason : 'invalid';
          if (!reasons.includes(r)) reasons.push(r);
        }
      }
    }
    if (made.length) faces.set(fam, made);
    return { family: fam, loaded: made.length, failed: reasons.length ? 1 : 0, reasons };
  })();

  loading.set(fam, job);
  try { return await job; } finally { loading.delete(fam); }
}

/** 卸载一个族(从 document.fonts 移除,下次用到再重新注册) */
export function unloadFamily(family){
  const fam = fonts.normalizeFamily(family);
  const list = faces.get(fam);
  if (!list) return;
  for (const face of list){
    try { document.fonts.delete(face); } catch (e) { /* 忽略 */ }
  }
  faces.delete(fam);
}

/** 卸载全部自定义字体 */
export function unloadAll(){
  for (const fam of [...faces.keys()]) unloadFamily(fam);
}

/* ---------------- 浏览器端导入 / 扫描 ---------------- */

/**
 * 浏览器端导入 File 列表: 每个字体文件存一份 Blob 到 IndexedDB,返回条目数组。
 * 返回 { entries, oversized, skipped, total }
 */
export async function importBrowserFiles(fileList){
  const out = [];
  const oversized = [];
  let skipped = 0;
  let total = 0;
  for (const file of (fileList || [])){
    if (!file || !fonts.isFontFile(file.name)){ skipped++; continue; }
    if (file.size > MAX_FONT_BYTES){ oversized.push(file.name); continue; }
    const parsed = fonts.parseFontName(file.name);
    const entry = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      ext: parsed.ext,
      name: file.name,
      size: file.size,
      mtime: file.lastModified,
      src: 'file',
    };
    entry.id = fonts.entryKey(entry);
    try {
      await kvPut(BLOB_PREFIX + entry.id, file);
    } catch (e){
      oversized.push(file.name); // 存不下(配额)与过大同样处理: 跳过该文件
      continue;
    }
    total += file.size;
    out.push(entry);
  }
  return { entries: out, oversized, skipped, total };
}

/** 递归收集目录句柄里的字体文件条目(浏览器端);relPath 供后续按需读取 */
async function walkDirHandle(dir, rel, out, stats){
  const entries = [];
  for await (const [name, handle] of dir.entries()) entries.push({ name, handle });
  for (const { name, handle } of entries){
    if (out.length >= fonts.MAX_FOLDER_FONTS){ stats.truncated = true; return; }
    if (handle.kind === 'directory'){
      if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue;
      await walkDirHandle(handle, rel.concat(name), out, stats);
      continue;
    }
    if (!fonts.isFontFile(name)) continue;
    const parsed = fonts.parseFontName(name);
    const entry = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      ext: parsed.ext,
      name,
      relPath: rel.concat(name),
      src: 'folder',
    };
    try {
      const f = await handle.getFile();
      entry.size = f.size;
      entry.mtime = f.lastModified;
    } catch (e) { /* 拿不到大小不影响使用 */ }
    entry.id = fonts.entryKey(entry);
    out.push(entry);
  }
}

/**
 * 浏览器端指定字体文件夹: 记住目录句柄(可持久化)+ 递归收集字体条目。
 * 返回 { entries, truncated, folderName }
 */
export async function scanFolderBrowser(handle){
  if (!handle || handle.kind !== 'directory') throw new Error('不是有效的文件夹');
  dirHandle = handle;
  try { await kvPut(HANDLE_KEY, handle); } catch (e) { /* 存不下则本次会话内仍可用 */ }
  const out = [];
  const stats = { truncated: false };
  await walkDirHandle(handle, [], out, stats);
  return { entries: out, truncated: stats.truncated, folderName: handle.name || '' };
}

/**
 * 重新扫描浏览器端字体文件夹。
 * requestPermission 必须由用户手势触发(本函数只在按钮点击里调用)。
 * 返回 { entries, truncated, folderName } 或 null(没有句柄/授权被拒)
 */
export async function rescanFolderBrowser(){
  const root = dirHandle || await kvGet(HANDLE_KEY).catch(() => null);
  if (!root || root.kind !== 'directory') return null;
  dirHandle = root;
  if (typeof root.requestPermission === 'function'){
    const st = await root.requestPermission({ mode: 'read' }).catch(() => 'denied');
    if (st !== 'granted') return null;
  }
  const out = [];
  const stats = { truncated: false };
  await walkDirHandle(root, [], out, stats);
  return { entries: out, truncated: stats.truncated, folderName: root.name || '' };
}

/** 丢弃浏览器端目录句柄(清空字体库时调用) */
export async function clearFolderHandle(){
  dirHandle = null;
  try { await kvDel(HANDLE_KEY); } catch (e) { /* 忽略 */ }
}

/** 删除某个浏览器端字体文件在 IndexedDB 里的字节 */
export async function deleteBrowserBlob(id){
  try { await kvDel(BLOB_PREFIX + id); } catch (e) { /* 忽略 */ }
}

/* ---------------- 桌面端扫描 ---------------- */

/**
 * 桌面端扫描字体文件夹: 只收集路径(不读字节,注册时按需读)。
 * 返回 { entries, truncated }
 */
export async function scanFolderTauri(dirPath){
  const tree = await listDirTree(dirPath);
  const out = [];
  let truncated = false;
  for (const node of tree){
    if (out.length >= fonts.MAX_FOLDER_FONTS){ truncated = true; break; }
    if (node.kind !== 'file' || !fonts.isFontFile(node.name)) continue;
    const parsed = fonts.parseFontName(node.name);
    const entry = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      ext: parsed.ext,
      name: node.name,
      path: node.path,
      src: 'folder',
    };
    entry.id = fonts.entryKey(entry);
    out.push(entry);
  }
  return { entries: out, truncated };
}

/**
 * 桌面端：把文件对话框选中的路径转成条目(不读字节)。
 * 非字体扩展名直接丢弃。
 */
export function entriesFromPaths(paths){
  const out = [];
  for (const p of (paths || [])){
    const path = String(p || '');
    if (!path || !fonts.isFontFile(path)) continue;
    const name = fonts.fileNameOf(path);
    const parsed = fonts.parseFontName(name);
    const entry = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      ext: parsed.ext,
      name,
      path,
      src: 'file',
    };
    entry.id = fonts.entryKey(entry);
    out.push(entry);
  }
  return out;
}

/** 失败原因 → 给用户看的说明 */
export function reasonText(reason){
  switch (reason){
    case 'permission': return '字体文件夹需要重新授权';
    case 'missing': return '字体文件已移走或不存在';
    case 'too-big': return '字体文件过大';
    case 'unsupported': return '当前环境不支持自定义字体';
    default: return '字体文件无法解析';
  }
}
