import * as fsx from './fs.js';
import { CASE_FOLDER, DEFAULT_VAULT, obsidianUri } from './obsidian.js';

const PREFS = 'obsidian-export.json';
let browserVault = null;
export async function loadExportPrefs(){
  try {
    const data = fsx.isTauri() ? JSON.parse(await fsx.readAppFile(PREFS) || '{}') : await fsx.kvGet(PREFS);
    return { vault: typeof data?.vault === 'string' ? data.vault : DEFAULT_VAULT, projects: Array.isArray(data?.projects) ? data.projects : [] };
  } catch { return { vault: DEFAULT_VAULT, projects: [] }; }
}
export async function saveExportPrefs(prefs){
  if (fsx.isTauri()) await fsx.writeAppFile(PREFS, JSON.stringify(prefs, null, 2));
  else await fsx.kvPut(PREFS, prefs);
}
export function browserVaultName(){ return browserVault?.name || ''; }
export async function saveProofReport(markdown, filename){
  if (fsx.isTauri()) {
    const prefs=await loadExportPrefs();const {invoke}=await import('@tauri-apps/api/core');
    return invoke('create_obsidian_report',{vaultPath:prefs.vault,id:crypto.randomUUID(),content:markdown});
  }
  const stem=String(filename||'脚本').replace(/[\\/:*?"<>|\r\n]/g,'_').slice(0,70);
  const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
  fsx.downloadText(markdown,`${stem}-校对意见-${timestamp}.md`);
  return {downloaded:true};
}
export async function chooseVault(){
  if (fsx.isTauri()) return fsx.pickDirDialog();
  if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持目录授权，请使用“下载 Markdown”，再放入库里的“校对案例”。');
  const selected = await window.showDirectoryPicker({ mode: 'readwrite' });
  await selected.getDirectoryHandle('.obsidian'); // 明确要求选择库根目录。
  browserVault = selected;
  return selected.name;
}
// File System Access API 适配，句柄参数可用于无 DOM 单测。
export async function createDirectoryNote(vault, id, content){
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('经验卡标识不正确。');
  await vault.getDirectoryHandle('.obsidian');
  const cases = await vault.getDirectoryHandle(CASE_FOLDER, { create: true });
  const name = `${id}.md`;
  try { await cases.getFileHandle(name); return { created: false, name }; }
  catch (e) { if (e.name !== 'NotFoundError') throw e; }
  const handle = await cases.getFileHandle(name, { create: true });
  let writer;
  try { writer = await handle.createWritable(); await writer.write(content); await writer.close(); }
  catch (e) {
    try { if (writer) await writer.abort(); } catch { /* writer 已关闭 */ }
    // createWritable 未提交时可能只留下空壳；不删除已被其他程序写入的内容。
    try { if ((await handle.getFile()).size === 0) await cases.removeEntry(name); } catch { /* 保留失败现场 */ }
    throw e;
  }
  return { created: true, name };
}
export async function saveCaseFile(vault, record, content){
  if (fsx.isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('create_obsidian_note', { vaultPath: vault, id: record.id, content });
  }
  if (!browserVault) throw new Error('请先点击“选择库目录”授权浏览器写入，或者使用“下载 Markdown”。');
  const selected = browserVault;
  const write = () => createDirectoryNote(selected, record.id, content);
  const result = navigator.locks ? await navigator.locks.request(`galweave-obsidian:${selected.name}:${record.id}`, write) : await write();
  return { ...result, path: `${selected.name}/${CASE_FOLDER}/${record.id}.md`, uri: `obsidian://open?vault=${encodeURIComponent(selected.name)}&file=${encodeURIComponent(`${CASE_FOLDER}/${record.id}.md`)}&paneType=tab` };
}
export async function openCaseFile(vault, record, result){
  if (fsx.isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_obsidian_note', { vaultPath: vault, id: record.id });
  } else window.location.href = result.uri || obsidianUri(result.path);
}
