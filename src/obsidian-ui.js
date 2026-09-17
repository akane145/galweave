import * as fsx from './fs.js';
import { buildCase, caseMarkdown, normalizeSource } from './obsidian.js';
import { loadExportPrefs, saveExportPrefs, chooseVault, browserVaultName, saveCaseFile, openCaseFile } from './obsidian-files.js';

function node(tag, className, text){
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function field(container, name, label, value, { area = false, readonly = false, required = false, max = 200 } = {}){
  const wrap = node('label', 'field', label); const input = document.createElement(area ? 'textarea' : 'input');
  if (!area) input.type = 'text'; else input.rows = 3;
  input.name = name; input.value = value || ''; input.readOnly = readonly; input.required = required; input.maxLength = max;
  wrap.append(input); container.append(wrap); return input;
}
export async function showObsidianExport(snapshot){
  if (document.querySelector('dialog.obsidian-export')) return;
  const prefs = await loadExportPrefs();
  const key = normalizeSource(snapshot.document).replace(/[^/]+$/, '') || snapshot.document;
  const previous = prefs.projects.find(p => p?.key === key) || {};
  const project = previous.project || snapshot.filename?.replace(/\.[^.]+$/, '') || '未命名作品';
  const initial = await buildCase({ ...snapshot, project, route: previous.route || '' });
  const focusBefore = document.activeElement;
  const modal = node('dialog', 'modal obsidian-export'); modal.setAttribute('aria-labelledby','obsidian-export-title');
  const heading = node('h3', '', '收藏到 Obsidian'); heading.id = 'obsidian-export-title'; modal.append(heading);
  modal.append(node('p','hint','保存选中的这一次修改，附上原文、相邻两段和原有批注。重复收藏会保留已有笔记，你后来写的心得不会被覆盖。'));
  const form = node('form','obsidian-export-form'); modal.append(form);
  const destination = node('div','obsidian-destination');
  const vault = field(destination,'vault','Obsidian 库根目录',fsx.isTauri() ? prefs.vault : browserVaultName() || prefs.vault,{ readonly: !fsx.isTauri() });
  const choose = node('button','secondary','选择库目录'); choose.type = 'button'; destination.append(choose);
  form.append(destination);
  const grid = node('div','obsidian-fields'); form.append(grid);
  const projectInput = field(grid,'project','作品名（必填）',initial.project,{required:true});
  const route = field(grid,'route','路线 / 章节（选填）',initial.route);
  const title = field(form,'title','经验卡标题',initial.title);
  field(form,'original','日文原文',initial.original,{area:true,readonly:true,max:30000});
  const diff = node('div','obsidian-fields'); form.append(diff);
  field(diff,'before','这次修改前',initial.before,{area:true,readonly:true,max:30000});
  field(diff,'after','这次修改后（历史记录）',initial.after,{area:true,readonly:true,max:30000});
  const detail = node('details','obsidian-context'); detail.append(node('summary','','查看来源、角色、上下文与批注'));
  detail.append(node('pre','',`角色：${initial.character || '旁白'}\n位置：${initial.location}\n\n${initial.context}`)); form.append(detail);
  const note = field(form,'note','我的改译理由 / 心得（选填）','',{area:true,max:30000}); note.placeholder = '例如：结合前句，这里是在嘴硬。原有批注已另存，不会自动变成你的理由。';
  const tags = field(form,'tags','标签（逗号分隔）',''); tags.placeholder = '主语判断，人物口吻';
  const statusLabel = node('label','field','经验卡确认状态'); const status = document.createElement('select'); status.name = 'status';
  status.add(new Option('待确认 · 留待复核','pending')); status.add(new Option('已确认 · 我核对过了','confirmed')); statusLabel.append(status); form.append(statusLabel);
  form.append(node('p','hint','作品和路线按当前脚本目录记忆。收藏不会改变编辑器的校对状态，也不会调用 AI。保存后可在译间点“刷新”查看。'));
  const feedback = node('p','obsidian-feedback'); feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite'); form.append(feedback);
  const actions = node('div','actions'); form.append(actions);
  const close = node('button','secondary','取消'); close.type = 'button';
  const download = node('button','secondary','下载 Markdown'); download.type = 'button';
  const open = node('button','secondary','在 Obsidian 打开'); open.type = 'button'; open.hidden = true;
  const save = node('button','primary','收藏到库'); save.type = 'submit'; actions.append(close,download,open,save);
  let busy = false, saved = null;
  const finish = () => { if (busy) return; modal.close(); modal.remove(); if (focusBefore?.isConnected) focusBefore.focus(); };
  const revealFeedback = () => feedback.scrollIntoView({ block:'nearest' });
  const fail = e => { feedback.classList.add('error'); feedback.textContent = typeof e === 'string' ? e : e?.message || '操作失败，请重试。'; revealFeedback(); };
  const setBusy = v => { busy = v; for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = v; };
  const collect = async () => {
    const record = await buildCase({ ...snapshot, project: projectInput.value.trim(), route: route.value.trim() });
    record.title = title.value.trim() || initial.title; record.note = note.value;
    record.tags = [...new Set(tags.value.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean))]; record.status = status.value;
    return { record, markdown: caseMarkdown(record) };
  };
  const remember = async () => {
    const latest = await loadExportPrefs();
    const projects = [{ key, project: projectInput.value.trim(), route: route.value.trim() }, ...latest.projects.filter(p => p?.key !== key)].slice(0,100);
    await saveExportPrefs({ vault: fsx.isTauri() ? vault.value.trim() : latest.vault, projects });
  };
  choose.addEventListener('click',async () => {
    try { const selected = await chooseVault(); if (selected) vault.value = selected; }
    catch(e){ if(e.name !== 'AbortError') fail(e.name === 'NotFoundError' ? '请选择包含 .obsidian 文件夹的库根目录。' : e); }
  });
  close.addEventListener('click',finish);
  modal.addEventListener('cancel',e => { e.preventDefault(); finish(); });
  // 原应用全局 Ctrl+S / 撤销等快捷键不能穿透到游戏脚本。
  modal.addEventListener('keydown',e => { e.stopPropagation(); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if(!busy) form.requestSubmit(); } });
  form.addEventListener('submit',async e => {
    e.preventDefault(); if (busy) return; setBusy(true); feedback.classList.remove('error');
    try {
      const {record,markdown} = await collect(); const selected = vault.value.trim();
      const result = await saveCaseFile(selected,record,markdown); saved = { record, result, vault:selected };
      feedback.textContent = result.created ? `已收藏：${result.path}` : `这次修改已收藏，已有笔记保持原样。本次填写的心得未覆盖旧笔记，可复制后在 Obsidian 中补充。\n${result.path}`;
      open.hidden = false; close.textContent = '完成';
      try { await remember(); } catch { feedback.textContent += '\n笔记已保存，但目录偏好未能记住。'; }
      revealFeedback();
    } catch(e){ fail(e); }
    finally { setBusy(false); }
  });
  download.addEventListener('click',async () => {
    if (busy || !form.reportValidity()) return; setBusy(true); feedback.classList.remove('error');
    try {
      const {record,markdown} = await collect(); fsx.downloadText(markdown,`${record.id}.md`);
      feedback.textContent = '已发起 Markdown 下载。请将文件放入 Obsidian 库的“校对案例”目录；若同名笔记已存在，请保留已有笔记。';
      try { await remember(); } catch { /* 下载不依赖设置保存 */ }
      revealFeedback();
    } catch(e){ fail(e); } finally { setBusy(false); }
  });
  open.addEventListener('click',async () => { if (!saved || busy) return; try { await openCaseFile(saved.vault,saved.record,saved.result); } catch(e){ fail(e); } });
  document.body.append(modal); modal.showModal(); projectInput.focus();
}
