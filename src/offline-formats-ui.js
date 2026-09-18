// offline-formats-ui.js — 样例配置与格式档案（零正则多样例编辑器）
//
// 单一主流程：布局卡片 + 样例对，面向完全不懂正则的用户。
// v1 模板档案在读取时迁移成 v2，并生成两组合成样例供预览和继续编辑；
// UI 不再维护一套平行的“高级模板模式”。
//
// 状态与归纳逻辑分别在 format-editor-state.js / format-samples.js（纯逻辑、已单测），
// 本文件只负责 DOM 渲染与事件接线。

import { BUILTIN_FORMATS, normalizeFormat, validateFormatV2, migrateV1ToV2, parseFormatAny, exportFormat } from './offline-formats.js';
import { inferLayout } from './format-samples.js';
import {
  createEditorState, addLayout, removeLayout, setLayoutKind, setLayoutTitle,
  addSample, removeSample, setSampleText, addMark, removeMark, fieldLabel,
  stateFromRule, buildRule, cloneState,
} from './format-editor-state.js';
import { loadSettings, saveSettings } from './settings.js';
import { downloadTextWithDialog, getAppDir } from './fs.js';

export async function savedFormats(){
 const settings=await loadSettings();
 return (Array.isArray(settings.offlineFormats)?settings.offlineFormats:[]).flatMap(r=>{try{return [normalizeFormat(r)];}catch{return [];}});
}
export async function availableFormats(){
 const unique = new Map();
 for (const r of [...BUILTIN_FORMATS, ...await savedFormats()]){
  const { name: _name, ...config } = r;
  unique.set(JSON.stringify(config), r);
 }
 return [...unique.values()];
}

let hooks, mounted=false, preview=null, page=0, generation=0;
/** 编辑器状态（纯数据，来自 format-editor-state） */
let editor = null;
const $=id=>document.getElementById('of-'+id);

/* ---------------- 报告与预览 ---------------- */

function invalidate(){
 preview=null;$('load').disabled=true;$('report').textContent='配置或文本已改变，请重新预览。';$('rows').replaceChildren();
}

function setReport(msg){ $('report').textContent = msg; }

/** 读当前样例编辑器状态为 v2 规则对象 */
function readRule(){
 const state = { ...cloneState(editor), name: $('name').value,
  pairing: $('pairing').value,
  ignore: $('ignore').value.split('\n').map(x=>x.trim()).filter(Boolean) };
 const built = buildRule(state, inferLayout);
 if (!built.ok){
  const err = new Error(built.errors.map(e=>(e.layout?('「'+e.layout+'」'):'')+
   (e.side?({source:'原文',target:'译文'}[e.side]||e.side):'')+'：'+e.message).join('\n'));
  err.details = built.errors;
  throw err;
 }
 // 归纳成功但个别布局被跳过时，把原因带上（不静默丢弃）
 if (built.errors.length) throw new Error(built.errors.map(e=>e.layout+'：'+e.message).join('\n'));
 return validateFormatV2(built.rule);
}

/* ---------------- 回溯：规则 → 编辑器状态 ---------------- */

function fillFromRule(rule){
 const v2 = (rule&&rule.version===2) ? rule : migrateV1ToV2(rule);
 const st = stateFromRule(v2);
 editor = st || createEditorState();
 $('name').value = rule.name || '';
 $('pairing').value = rule.pairing || 'order';
 $('ignore').value = (rule.ignore||[]).join('\n');
 renderLayouts();
 invalidate();
}

/* ---------------- 渲染：布局卡片 ---------------- */

/** 渲染全部布局卡片（结构变化时全量重绘；输入时只改状态不重绘，避免打断输入） */
function renderLayouts(){
 const host = $('layouts');
 if (!host || !editor) return;
 host.replaceChildren();
 editor.layouts.forEach((L) => host.appendChild(renderLayoutCard(L)));
 if (!editor.layouts.length){
  const p = document.createElement('p');
  p.className = 'settings-caption';
  p.textContent = '还没有布局。点下面的「＋ 添加布局」开始。';
  host.appendChild(p);
 }
 // 归纳状态随重绘一起更新：渲染点是所有结构变更的收口，
  // 在这里算一次，省得在 8 个改动点各加一行（漏一个就会显示过期状态）。
 renderLayoutStatus();
}

function renderLayoutCard(L){
 const card = document.createElement('div');
 card.className = 'of-layout';
 card.dataset.layout = L.id;

 const head = document.createElement('div');
 head.className = 'of-layout-head';
 const title = document.createElement('input');
 title.type='text'; title.className='of-layout-title'; title.value=L.title; title.maxLength=60;
 title.setAttribute('aria-label','布局名称');
 title.addEventListener('input',()=>{ editor = setLayoutTitle(editor, L.id, title.value); invalidate(); });
 const kind = document.createElement('select');
 kind.className='of-layout-kind'; kind.setAttribute('aria-label','这一布局的原文类型');
 for (const [v,label] of [['dialogue','对话（可能有角色名）'],['narration','旁白（无角色名）']]){
  const o=document.createElement('option'); o.value=v; o.textContent=label; kind.append(o);
 }
 kind.value = L.kind;
 kind.addEventListener('change',()=>{ editor = setLayoutKind(editor, L.id, kind.value); invalidate(); });
 const del = document.createElement('button');
 del.type='button'; del.className='of-layout-del'; del.textContent='✕';
 del.title='删除这个布局';
 del.setAttribute('aria-label','删除布局「'+(L.title||'未命名')+'」');
 del.addEventListener('click',()=>{ editor = removeLayout(editor, L.id); renderLayouts(); invalidate(); });
 head.append(title, kind, del);
 card.appendChild(head);

 // 样例对（原文 / 译文并排）
 const pairs = document.createElement('div');
 pairs.className='of-samples';
 const n = Math.max(L.source.samples.length, L.target.samples.length);
 for (let i=0;i<n;i++){
  pairs.appendChild(renderSamplePair(L, i));
 }
 card.appendChild(pairs);

 const foot = document.createElement('div');
 foot.className='of-layout-foot';
 const add = document.createElement('button');
 add.type='button'; add.className='toolbtn'; add.textContent='＋ 添加一组样例';
 add.addEventListener('click',()=>{ editor = addSample(editor, L.id); renderLayouts(); invalidate(); });
 const delSample = document.createElement('button');
 delSample.type='button'; delSample.className='toolbtn secondary'; delSample.textContent='－ 删除最后一组';
 delSample.disabled = n<=0;
 delSample.addEventListener('click',()=>{ editor = removeSample(editor, L.id, n-1); renderLayouts(); invalidate(); });
 foot.append(add, delSample);
 // 这个布局的归纳状态
 const status = document.createElement('span');
 status.className='of-layout-status';
 status.dataset.statusFor = L.id;
 foot.appendChild(status);
 card.appendChild(foot);

 return card;
}

function renderSamplePair(L, i){
 const wrap = document.createElement('div');
 wrap.className='of-sample-pair';

 for (const side of ['source','target']){
  const box = document.createElement('div');
  box.className='of-sample';
  const label = document.createElement('label');
  const sideName = side==='source'?'原文':'译文';
  label.textContent = sideName + '样例 ' + (i+1);
  const ta = document.createElement('textarea');
  ta.rows=3; ta.spellcheck=false;
  ta.dataset.side = side; ta.dataset.index = String(i);
  ta.value = (L[side].samples[i] && L[side].samples[i].text) || '';
  ta.setAttribute('aria-label', label.textContent);
  ta.addEventListener('input',()=>{ editor = setSampleText(editor, L.id, side, i, ta.value); invalidate(); });
  // 标注按钮：作用于这个 textarea 的当前选区
  const bar = document.createElement('div');
  bar.className='of-mark-bar';
  for (const f of ['id','name','text']){
   const b=document.createElement('button');
   b.type='button'; b.className='toolbtn secondary';
   b.textContent='标为'+fieldLabel(f);
   b.dataset.mark = side+':'+f;
   b.addEventListener('click',()=>{
    const r = addMark(editor, L.id, side, i, { start:ta.selectionStart, end:ta.selectionEnd, field:f });
    if (!r.ok){ setReport('⚠ '+r.error); return; }
    editor = r.state; renderLayouts(); invalidate();
    setReport('已标注为「'+fieldLabel(f)+'」。');
   });
   bar.appendChild(b);
  }
  // 已标注字段：以可撤销胶囊显示（不暴露内部语法）
  const chips = document.createElement('div');
  chips.className='of-chips';
  const marks = (L[side].samples[i] && L[side].samples[i].marks) || [];
  for (const m of marks){
   const chip=document.createElement('button');
   chip.type='button'; chip.className='of-chip';
   const text=(ta.value||'').slice(m.start,m.end);
   chip.textContent = fieldLabel(m.field) + '：' + (text.length>10?text.slice(0,10)+'…':text);
   chip.title='点击撤销这处标注';
   chip.setAttribute('aria-label','撤销'+fieldLabel(m.field)+'标注：'+text);
   chip.addEventListener('click',()=>{ editor = removeMark(editor, L.id, side, i, m.field); renderLayouts(); invalidate(); });
   chips.appendChild(chip);
  }
  box.append(label, ta, bar, chips);
  wrap.appendChild(box);
 }
 return wrap;
}

/** 每个布局的归纳状态文案（Task 7：即时比较样例骨架，用自然语言说明冲突）
 *
 *  ⚠️ 每次标注/改样例后都要调（不能只在点「预览」时算）——
 *     plan.md Task 7 要求"系统即时比较样例骨架，显示一致或冲突位置"。
 *     只在预览时算的话，用户要一路点到最后才知道标错了。 */
function renderLayoutStatus(){
 if (!editor) return;
 editor.layouts.forEach(L=>{
  const el = document.querySelector('[data-status-for="'+L.id+'"]');
  if (!el) return;
  const src = inferLayout(L.source.samples);
  const tgt = inferLayout(L.target.samples);
  if (src.ok && tgt.ok){
   el.textContent = '✓ 已归纳：' + L.source.samples.length + ' 组样例结构一致';
   el.className = 'of-layout-status ok';
   return;
  }
  // 优先报原文侧（用户先标原文）；两侧都错时报原文
  el.textContent = '⚠ ' + (!src.ok ? ('原文：'+src.error) : ('译文：'+tgt.error));
  el.className = 'of-layout-status bad';
 });
}

/* ---------------- 预览 ---------------- */

function renderPreview(){
 const d=preview;if(!d)return;
 setReport(`${d.rule.name}：${d.records.length} 条原译文，${d.errors.length} 个错误，${d.unmatched.length} 行未识别。\n`+
  d.errors.join('\n')+(d.unmatched.length?'\n未识别行将保持原样；请逐一确认是否漏掉了正文。':d.errors.length?'':'\n未编辑回写校验通过。'));
 const list=$('rows');list.replaceChildren();
 const entries=[...d.records.map(r=>({line:r.source.line,layout:(r.kind==='narration'?'旁白':'对话'),source:r.source.values.text,target:r.target.values.text})),
  ...d.unmatched.map(r=>({line:r.line,layout:'',source:r.text,target:'未识别（保持原样）'}))];
 const total=Math.max(1,Math.ceil(entries.length/50));page=Math.min(page,total-1);
 for(const r of entries.slice(page*50,page*50+50)){
  const tr=document.createElement('tr');
  for(const text of [r.line,r.layout,r.source,r.target]){const td=document.createElement('td');td.textContent=String(text);tr.append(td);}
  list.append(tr);
 }
 $('pages').textContent=`第 ${page+1} / ${total} 页（全部 ${entries.length} 项）`;
 $('prev').disabled=page===0;$('next').disabled=page>=total-1;
 $('load').disabled=!!d.errors.length||!!d.unmatched.length&&!$('ack').checked;
}

/* ---------------- 运行 ---------------- */

function run(){
 try{
  const {text,err}=hooks.getSource();if(err)throw new Error(err);
  const d=parseFormatAny(text,readRule());
  if(!d.errors.length&&exportFormat(d,d.records.map(r=>({translation:r.target.values.text,nameTr:r.target.values.name})))!==text)throw new Error('未编辑回写不一致');
  preview=d;page=0;$('ack').checked=false;
  renderLayoutStatus();
  renderPreview();
 }catch(e){invalidate();setReport(e.message);}
}

/* ---------------- 挂载 ---------------- */

export async function initOfflineFormats(options){
 hooks=options;const current=++generation;
 if(!mounted){
  const host=document.createElement('section');host.className='settings-section offline-format-section';
  host.innerHTML=`<div class="settings-section-heading"><span class="settings-section-index">02</span><div><h4>样例格式档案</h4><p>给每种布局至少两组原文与译文样例，选中文字标明字段，程序生成可复用规则。</p></div><span class="settings-badge settings-badge--muted">自定义</span></div>
  <div class="of-profile-row">
   <div class="field of-profile-field"><label for="of-profiles">格式档案</label><select id="of-profiles"></select></div>
   <div class="of-profile-actions"><button type="button" class="toolbtn secondary" id="of-use">使用档案</button><button type="button" class="toolbtn secondary" id="of-import">导入档案</button><input id="of-file" type="file" accept=".json" hidden></div>
  </div>
  <div class="of-config-grid">
   <div class="field"><label for="of-name">档案名称</label><input id="of-name" type="text" maxlength="100"></div>
   <div class="field"><label for="of-pairing">原译配对</label><select id="of-pairing"><option value="order">按各自出现顺序</option><option value="id">按相同编号（支持原译分区）</option></select></div>
  </div>
  <div id="of-layouts"></div>
  <div class="of-layout-actions"><button type="button" class="toolbtn settings-primary" id="of-add-dialogue">＋ 添加对话布局</button><button type="button" class="toolbtn secondary" id="of-add-narration">＋ 添加旁白布局</button></div>
  <p class="settings-caption">每个布局至少两组样例。未标注文字作为固定结构原样保留；点已标注字段可撤销。</p>
  <div class="field of-ignore-field"><label for="of-ignore">不参与翻译的行前缀</label><textarea id="of-ignore" rows="2" placeholder="每行一个，例如 # 或 ;"></textarea><small>匹配这些前缀的整行会保持原样，不进入翻译记录。</small></div>
  <div class="of-rule-actions"><button type="button" class="toolbtn settings-primary" id="of-preview">预览全部文本</button><button type="button" class="toolbtn secondary" id="of-save">保存为我的档案</button><button type="button" class="toolbtn secondary" id="of-export">导出档案</button><button type="button" class="toolbtn danger" id="of-delete">删除同名档案</button></div>
  <pre id="of-report" class="recog-report" role="status" aria-live="polite"></pre>
  <label class="of-ack"><input type="checkbox" id="of-ack">我已检查未识别行，确认它们无需翻译并保持原样</label>
  <div class="offline-preview"><table><thead><tr><th>原文行</th><th>类型</th><th>原文 / 未识别内容</th><th>译文</th></tr></thead><tbody id="of-rows"></tbody></table></div>
  <div class="of-preview-actions"><button type="button" class="toolbtn secondary" id="of-prev">上一页</button><span id="of-pages"></span><button type="button" class="toolbtn secondary" id="of-next">下一页</button><button type="button" class="toolbtn settings-primary" id="of-load" disabled>按此格式载入</button></div>
  <p class="settings-caption">保存的档案用于后续导入自动匹配；只有唯一匹配、无错误且无未识别行时自动采用。导出的档案只含规则，不含脚本文本。</p>`;
  document.querySelector('#setModal .settings-scroll').insertBefore(host,document.querySelector('.parse-manual-section'));
  mounted=true;

  for(const id of ['name','pairing','ignore']) $(id).addEventListener('input',invalidate);
  for(const id of ['recogText','recogSrcFile','recogSrcPaste'])document.getElementById(id).addEventListener('input',invalidate);
  $('add-dialogue').addEventListener('click',()=>{ editor=addLayout(editor,'dialogue');renderLayouts();invalidate(); });
  $('add-narration').addEventListener('click',()=>{ editor=addLayout(editor,'narration');renderLayouts();invalidate(); });
  $('preview').addEventListener('click',run);
  $('ack').addEventListener('change',renderPreview);
  $('prev').addEventListener('click',()=>{page--;renderPreview();});$('next').addEventListener('click',()=>{page++;renderPreview();});
  $('use').addEventListener('click',async()=>{const i=Number($('profiles').value);const rules=await choices();if(rules[i])fillFromRule(rules[i]);});
  $('save').addEventListener('click',async()=>{try{
   const rule=readRule(),settings=await loadSettings(),rules=await savedFormats();
   if(rules.some(r=>r.name===rule.name))throw new Error('名称已存在，请改名，或先删除同名档案。');
   settings.offlineFormats=[...rules,rule];await saveSettings(settings);await choices();
   setReport('档案已保存，下次导入时自动匹配。');
  }catch(e){setReport(e.message);}});
  $('delete').addEventListener('click',async()=>{try{const settings=await loadSettings();settings.offlineFormats=(await savedFormats()).filter(r=>r.name!==$('name').value.trim());await saveSettings(settings);await choices();setReport('已删除我的同名档案（内置档案保留）。');}catch(e){setReport(e.message);}});
  $('export').addEventListener('click',async()=>{try{await downloadTextWithDialog(JSON.stringify(readRule(),null,2),'galweave-format.json',await getAppDir());}catch(e){setReport(e.message);}});
  $('import').addEventListener('click',()=>$('file').click());
  $('file').addEventListener('change',async()=>{try{
   const file=$('file').files[0];if(!file)return;
   if(file.size>32768)throw new Error('档案超过 32 KB');
   const obj=JSON.parse(await file.text());
   // v2 走严格校验，v1 走迁移——两者最终都回填到样例编辑器
    fillFromRule(normalizeFormat(obj));
   setReport('档案已导入，可预览后保存到我的档案。');
  }catch(e){setReport('导入失败：'+e.message);}finally{$('file').value='';}});
  $('load').addEventListener('click',async()=>{try{
   if(!preview||$('load').disabled)return;
   const {text,err}=hooks.getSource();
   if(err||text!==preview.text||JSON.stringify(readRule())!==JSON.stringify(preview.rule)){invalidate();return;}
   await hooks.load(preview);
  }catch(e){setReport(e.message);}});
 }
 await choices();if(current!==generation)return;
 // 首次打开：**从空白开始**，不回填第一个内置档案。
 // 回填会把内置模板（如 `原文：{text}`）当成"样例文本"填进样例框，
 // 用户按提示改文本时标注坐标随即失效 —— 零正则流程反而更容易踩坑。
 // 想用内置档案请走「使用档案」按钮，那是明确的选择动作。
 if(!editor) editor=createEditorState();
 renderLayouts();
 invalidate();
}

async function choices(){
 const selected=$('profiles').value;$('profiles').replaceChildren();
 const rules=[...BUILTIN_FORMATS,...await savedFormats()];
 rules.forEach((r,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=(i<BUILTIN_FORMATS.length?'内置 · ':'我的 · ')+r.name;$('profiles').append(o);});
 $('profiles').value=selected||'0';return rules;
}
