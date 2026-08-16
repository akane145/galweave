// fs.js — 文件读写 / 对话框 / 进度存储
// 在 Tauri 桌面端走 Rust 命令;在普通浏览器里自动降级(读取用 FileReader、保存用下载)。

export const isTauri = () => !!(window.__TAURI_INTERNALS__);

// 动态引入 Tauri 插件(仅桌面端存在)
async function tauriDialog(){ return import('@tauri-apps/plugin-dialog'); }
async function tauriCore(){ return import('@tauri-apps/api/core'); }

/* 浏览器端字节解码(UTF-8 优先,失败尝试 Shift-JIS/EUC-JP) */
function decodeBrowserBytes(buf){
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const utf8 = new TextDecoder('utf-8');
  const tryDecode = (label, fatal) => {
    try {
      return new TextDecoder(label, fatal ? { fatal: true } : undefined).decode(u8);
    } catch (e) { return null; }
  };
  // BOM
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF){
    return { content: utf8.decode(u8.subarray(3)), encoding: 'utf-8' };
  }
  // 严格 UTF-8
  const strict = tryDecode('utf-8', true);
  if (strict !== null) return { content: strict, encoding: 'utf-8' };
  // Shift-JIS / EUC-JP 兜底
  const sjis = tryDecode('shift_jis', false);
  if (sjis !== null) return { content: sjis, encoding: 'shift-jis' };
  const euc = tryDecode('euc-jp', false);
  if (euc !== null) return { content: euc, encoding: 'euc-jp' };
  return { content: utf8.decode(u8), encoding: 'utf-8' };
}

// 浏览器端文件句柄(showOpenFilePicker / 目录浏览拿到,用于直接写回原文件)
let browserFileHandle = null;
export function setBrowserFileHandle(h){ browserFileHandle = h || null; }
export function getBrowserFileHandle(){ return browserFileHandle; }

/**
 * 读取文件 → { content: string, path: string|null, encoding: string }
 * Tauri: invoke read_file(自动检测编码转 UTF-8); 浏览器: ArrayBuffer + 编码检测。
 */
export async function readFileSource(file){
  if (isTauri()){
    const { invoke } = await tauriCore();
    try {
      return await invoke('read_file', { path: file.path });
    } catch (e){
      throw new Error('读取文件失败: ' + e);
    }
  }
  // 浏览器降级: file 是 File 对象,读字节后检测编码
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = decodeBrowserBytes(reader.result);
      resolve({ content: r.content, path: null, encoding: r.encoding });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 写出文件(浏览器端): 优先写回导入时拿到的原文件句柄;否则另存为;都不行则下载。
 * 返回 { saved: boolean, handle: boolean }  — saved: 直接写回原文件成功。
 */
export async function writeBrowserFile(content, displayName){
  if (isTauri()) throw new Error('桌面端请走 writeFileSource');
  // 1) 写回原文件句柄
  if (browserFileHandle){
    try {
      const w = await browserFileHandle.createWritable();
      await w.write(content);
      await w.close();
      return { saved: true };
    } catch (e){
      // 句柄失效(权限被撤销等)→ 继续降级
    }
  }
  // 2) 另存为
  if (window.showSaveFilePicker){
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: displayName || '译文.txt',
        types: [{ description: '文本文件', accept: { 'text/plain': ['.txt'] } }]
      });
      const w = await h.createWritable();
      await w.write(content);
      await w.close();
      return { saved: false, savedAs: true };
    } catch (e){
      if (e && e.name === 'AbortError') return { saved: false, cancelled: true };
    }
  }
  // 3) 下载
  downloadText(content, displayName || '译文.txt');
  return { saved: false, downloaded: true };
}

/** 选择并打开文件(浏览器端,Chrome/Edge 优先拿句柄)。返回 { file, name } 或 null(取消)。 */
export async function pickBrowserFile(){
  if (window.showOpenFilePicker){
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: '文本文件', accept: { 'text/plain': ['.txt', '.ks'] } }],
        multiple: false
      });
      browserFileHandle = h;
      const f = await h.getFile();
      return { file: f, name: f.name };
    } catch (e){
      if (e && e.name === 'AbortError') return null;
      // 其它异常退回普通选择
    }
  }
  return null;
}

/** 选择文件夹(浏览器端,showDirectoryPicker)。返回目录句柄或 null(取消)。 */
export async function pickBrowserDir(){
  if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持文件夹浏览,请使用 Chrome 或 Edge。仍可用「导入文本」逐个打开。');
  try {
    return await window.showDirectoryPicker();
  } catch (e){
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
}

/** 递归列出浏览器目录句柄 → 扁平 [{ name, kind, depth, handle }](目录在前,名称→扩展名排序)。 */
export async function listBrowserDir(dirHandle, depth, out){
  out = out || [];
  depth = depth || 0;
  if (depth > 40) return out;
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) entries.push({ name, handle });
  const extOf = n => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i + 1).toLowerCase() : ''; };
  entries.sort((a, b) => {
    const ad = a.handle.kind === 'directory', bd = b.handle.kind === 'directory';
    if (ad !== bd) return ad ? -1 : 1;
    const nc = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    if (nc !== 0) return nc;
    return extOf(a.name).localeCompare(extOf(b.name));
  });
  for (const { name, handle } of entries){
    out.push({ name, kind: handle.kind === 'directory' ? 'directory' : 'file', depth, handle });
    if (handle.kind === 'directory') await listBrowserDir(handle, depth + 1, out);
  }
  return out;
}

/** 写出文件。Tauri: invoke write_file(保存前自动生成 .bak 备份); 浏览器: 下载。 */
export async function writeFileSource(path, content, displayName){
  if (isTauri()){
    const { invoke } = await tauriCore();
    try {
      return await invoke('write_file', { path, content });
    } catch (e){
      throw new Error('保存失败: ' + e);
    }
  }
  downloadText(content, displayName || '译文.txt');
  return { saved: false, downloaded: true, path: null };
}

/** 列出目录 → 扁平文件树数组 [{ name, path, kind, depth }] */
export async function listDirTree(dirPath){
  if (!isTauri()) throw new Error('文件夹浏览需要桌面版(或使用「导入文本」逐个打开)');
  const { invoke } = await tauriCore();
  return invoke('list_dir', { path: dirPath });
}

/** 读取任意路径文本(JSON 导入等用)。 */
export async function readTextFileSource(path){
  const res = await readFileSource({ path });
  return res.content;
}

/** 写任意路径文本(项目术语表等用;走 write_file 命令)。浏览器模式抛错。 */
export async function writeTextFileSource(path, content){
  if (isTauri()){
    const { invoke } = await tauriCore();
    await invoke('write_file', { path, content });
    return;
  }
  throw new Error('浏览器模式不支持直接写文件');
}

/** 读文件为 base64(Tauri 端;背景图片/MDX 词典等二进制)。浏览器模式抛错。 */
export async function readFileB64(path){
  if (isTauri()){
    const { invoke } = await tauriCore();
    return await invoke('read_file_b64', { path });
  }
  throw new Error('浏览器模式请使用 FileReader 读文件');
}

/** base64 字符串 → ArrayBuffer(纯函数,可单测);用于解码 readFileB64 的结果 */
export function base64ToArrayBuffer(b64){
  const bin = atob(String(b64 || ''));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/* ---------------- 软件目录数据文件(与 exe 同目录,便携) ---------------- */

/** 读取软件目录(与 exe 同目录)下的数据文件;不存在返回 null;浏览器降级返回 null。 */
export async function readAppFile(name){
  if (isTauri()){
    const { invoke } = await tauriCore();
    const r = await invoke('read_app_file', { name });
    return r === null || r === undefined ? null : r;
  }
  return null;
}

/** 写入软件目录下的数据文件;浏览器降级抛错(由调用方回退 localStorage)。 */
export async function writeAppFile(name, content){
  if (isTauri()){
    const { invoke } = await tauriCore();
    await invoke('write_app_file', { name, content });
    return;
  }
  throw new Error('浏览器模式不支持写入软件目录');
}

/** 选择要打开的文件。返回 { path, name } 或 null(取消)。filters 可选: [{name, extensions}] */
export async function openFileDialog(filters){
  if (isTauri()){
    const { open } = await tauriDialog();
    const res = await open({ multiple: false, filters: filters || [{ name: '文本文件', extensions: ['txt', 'ks'] }] });
    if (res === null) return null;
    return { path: res, name: res.split(/[\\/]/).pop() || res };
  }
  return null; // 浏览器走 <input type=file>
}

/** 选择文件夹。返回路径或 null(取消)。 */
export async function pickDirDialog(){
  if (isTauri()){
    const { open } = await tauriDialog();
    const res = await open({ directory: true });
    return res || null;
  }
  return null;
}

/** 程序(exe)所在目录。Tauri 端返回真实路径;浏览器端返回 null。 */
export async function getAppDir(){
  if (!isTauri()) return null;
  try {
    const { invoke } = await tauriCore();
    return await invoke('app_dir');
  } catch (e) { return null; }
}

/** 另存为对话框。返回 { path, name } 或 null(取消)。defaultDir 指定默认目录;
 *  filters 可选,形如 [{ name, extensions }],默认 txt/json。 */
export async function saveFileDialog(suggestedName, defaultDir, filters){
  if (isTauri()){
    const { save } = await tauriDialog();
    const name = suggestedName || '译文.txt';
    const def = defaultDir ? String(defaultDir).replace(/[\\/]+$/, '') + '\\' + name : name;
    const res = await save({ defaultPath: def, filters: filters || [{ name: '文本文件', extensions: ['txt', 'json'] }] });
    if (res === null) return null;
    return { path: res, name: res.split(/[\\/]/).pop() || res };
  }
  return null;
}

/** 保存文本并让用户选择路径。
 *  Tauri: 原生另存为对话框(默认目录 defaultDir,通常是 exe 所在文件夹);
 *  浏览器: 优先 File System Access API 的保存选择器,不支持时降级为直接下载。 */
export async function downloadTextWithDialog(content, name, defaultDir){
  if (isTauri()){
    const res = await saveFileDialog(name, defaultDir);
    if (!res) return { saved: false, cancelled: true };
    await writeTextFileSource(res.path, content);
    return { saved: true, path: res.path };
  }
  if (window.showSaveFilePicker){
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: '文本文件', accept: { 'text/plain': ['.txt', '.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(content);
      await w.close();
      return { saved: true };
    } catch (e){
      if (e && e.name === 'AbortError') return { saved: false, cancelled: true };
      // 其他异常(如环境不支持)降级为普通下载
    }
  }
  downloadText(content, name);
  return { saved: false, downloaded: true };
}

/** 下载(浏览器降级)。 */
export function downloadText(content, name){
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 翻译进度持久化 ----------------
 * 桌面端: 优先写 <源目录>/.galweave/<文件名>.progress.json —— 源文件目录下的 .galweave 子文件夹,
 *         避免在项目目录里堆一堆辅助文件;随时可备份/查看/手动恢复。
 *         旧版本(同目录 <源文件>.progress.json)自动迁移: 读到旧文件后搬到新位置。
 *         源文件目录只读/写失败时自动降级 IndexedDB;浏览器端直接走 IndexedDB。
 * 数据结构: { version: 1, updatedAt, paras: [{ orig, translation, nameTr }] }
 */

const LS_KEY = 'galtrans_progress_v1';
const DB_NAME = 'galtrans_progress';
const STORE = 'states';
const PROGRESS_SUFFIX = '.progress.json';

/** 是否绝对路径(桌面端按完整路径存进度文件;浏览器端只有文件名)。 */
export function isAbsPath(p){
  return typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p));
}

/** 绝对路径的源文件目录(纯字符串切分,兼容 / 与 \) */
function dirOf(path){
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}
function basenameOf(path){
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 新位置: <源目录>/.galweave/<文件名>.progress.json */
function progressFilePath(key){ return dirOf(key) + '/.galweave/' + basenameOf(key) + PROGRESS_SUFFIX; }
/** 旧位置(同目录,迁移用) */
function legacyProgressFilePath(key){ return key + PROGRESS_SUFFIX; }
/** 进度文件路径(供 UI 显示;纯拼接,不含 I/O) */
export function progressPathDisplay(sourcePath){ return dirOf(sourcePath) + '/.galweave/' + basenameOf(sourcePath) + PROGRESS_SUFFIX; }

function normalizeParas(paras){
  return paras.map(p => ({ orig: p.orig, translation: p.translation || '', nameTr: p.nameTr || '' }));
}

// 桌面端: 读 .galweave/<name>.progress.json;旧位置回退 + 自动迁移;不存在/损坏返回 undefined
async function fileSavedState(key){
  if (!isTauri() || !isAbsPath(key)) return undefined;
  const read = async (p) => {
    try {
      const raw = await readTextFileSource(p);
      if (!raw) return undefined;
      const data = JSON.parse(raw);
      return (data && Array.isArray(data.paras)) ? data : undefined;
    } catch (e) { return undefined; }
  };
  // 新位置
  let data = await read(progressFilePath(key));
  if (data) return data;
  // 旧位置回退: 读到后搬到新位置(迁移),再返回
  const legacy = legacyProgressFilePath(key);
  data = await read(legacy);
  if (data){
    try { await writeTextFileSource(progressFilePath(key), JSON.stringify({ version: 1, updatedAt: data.updatedAt, paras: data.paras }, null, 2)); } catch (e) {}
    try {
      const { invoke } = await tauriCore();
      await invoke('remove_file', { path: legacy });
    } catch (e) {}
    return data;
  }
  return undefined;
}

// 桌面端: 写 .galweave/<name>.progress.json;写失败返回 false(调用方降级 IndexedDB)
async function fileSaveState(key, paras){
  if (!isTauri() || !isAbsPath(key)) return false;
  try {
    await writeTextFileSource(progressFilePath(key), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      paras: normalizeParas(paras)
    }, null, 2));
    return true;
  } catch (e) { return false; }
}

// 桌面端: 删除新位置 + 旧位置;失败返回 false
async function fileRemoveState(key){
  if (!isTauri() || !isAbsPath(key)) return false;
  try {
    const { invoke } = await tauriCore();
    await invoke('remove_file', { path: progressFilePath(key) });
    await invoke('remove_file', { path: legacyProgressFilePath(key) });
    return true;
  } catch (e) { return false; }
}

function idbOpen(){
  return new Promise((resolve, reject) => {
    if (!window.indexedDB){ reject(new Error('no indexedDB')); return; }
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key){
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return undefined; }
}

async function idbPut(key, val){
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 忽略 */ }
}

async function idbDel(key){
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 忽略 */ }
}

export async function savedState(name){
  // 桌面端: 明文进度文件优先;否则回退 IndexedDB(兼容旧版本数据)
  const f = await fileSavedState(name);
  if (f) return f;
  const v = await idbGet(name);
  if (v !== undefined) return v;
  // 兼容旧版 localStorage 进度
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return o[name];
  } catch (e) { return undefined; }
}
export async function saveState(name, paras){
  const ok = await fileSaveState(name, paras);
  if (!ok) await idbPut(name, { paras: normalizeParas(paras) });
}
export async function removeSavedState(name){
  const ok = await fileRemoveState(name);
  if (!ok) await idbDel(name);
}

/* 校对数据(浏览器版): IndexedDB,键 'proof:<文件名>' */

export async function proofState(name){
  return await idbGet('proof:' + name);
}
export async function saveProofState(name, data){
  await idbPut('proof:' + name, data);
}
export async function removeProofState(name){
  await idbDel('proof:' + name);
}
