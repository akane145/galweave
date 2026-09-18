// offline-formats-ui.js — 样例配置与格式档案（零正则多样例编辑器）
//
// 两条通路并存（这是有意的）：
//   1. **主流程：布局卡片 + 样例对**（默认）—— 面向完全不懂正则的用户。
//      为每个布局提供 ≥2 组原文/译文样例，选中文字点按钮标注字段，
//      程序归纳出规则。
//   2. **高级：直接编辑模板**（折叠）—— v1 的 {text}/{id}/{name} 模板语法。
//      保留它是因为既有用户档案与内置档案都是模板形态，且模板能表达
//      样例难以演示的边界情形。主流程图里不出现模板语法。
//
// 状态与归纳逻辑分别在 format-editor-state.js / format-samples.js（纯逻辑、已单测），
// 本文件只负责 DOM 渲染与事件接线。

import { BUILTIN_FORMATS, validateFormat, validateFormatV2, migrateV1ToV2, parseFormatAny, exportFormat } from './offline-formats.js';
import { inferLayout } from './format-samples.js';
import {
  createEditorState, addLayout, removeLayout, setLayoutKind, setLayoutTitle,
  addSample, removeSample, setSampleText, addMark, removeMark, fieldLabel,
  stateFromRule, buildRule, cloneState, templateOfFragments,
} from './format-editor-state.js';
import { loadSettings, saveSettings } from './settings.js';
import { downloadTextWithDialog, getAppDir } from './fs.js';

export async function savedFormats(){
 const settings=await loadSettings();
 return (Array.isArray(settings.offlineFormats)?settings.offlineFormats:[]).flatMap(r=>{try{return [normalize(r)];}catch{return [];}});
}
/** 统一读取：v1 原样（保持既有行为），v2 严格校验 */
function normalize(r){
 return (r&&r.version===2)?validateFormatV2(r):validateFormat(r);
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
/** 高级模板模式的输入（与 editor 二选一；用户切到高级时才用） */
let advanced = { source:'', target:'' };
const $=id=>document.getElementById('of-'+id);

/* ---------------- 报告与预览 ---------------- */

function invalidate(){
 preview=null;$('load').disabled=true;$('report').textContent='配置或文本已改变，请重新预览。';$('rows').replaceChildren();
}

function setReport(msg){ $('report').textContent = msg; }

/** 当前模式：'samples'（默认）| 'advanced' */
function mode(){ return $('mode') && $('mode').value === 'advanced' ? 'advanced' : 'samples'; }

/** 读当前配置为规则对象（两种模式各自的入口） */
function readRule(){
 if (mode() === 'advanced'){
  return validateFormat({
   version:1,
   name: $('name').value,
   source: $('adv-source').value,
   target: $('adv-target').value,
   pairing: $('pairing').value,
   ignore: $('ignore').value.split('\n').map(x=>x.trim()).filter(Boolean),
  });
 }
 // 样例模式：状态 → 归纳 → v2 规则
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
 // 档案里**只有结构、没有原始样例文本**（plan.md 明确要求不保存样例），
 // 所以回填时用模板串占位：用户能看清结构，粘贴真实样例后重新标注即可。
 editor.layouts.forEach((L,i)=>{
  const sp = v2.sourcePatterns[i];
  const tp = sp ? v2.targetPatterns.find(t => t && t.id === sp.target) : null;
  if (sp && L.source.samples[0]) L.source.samples[0].text = templateOfFragments(sp.fragments);
  if (tp && L.target.samples[0]) L.target.samples[0].text = templateOfFragments(tp.fragments);
 });
 $('name').value = rule.name || '';
 $('pairing').value = rule.pairing || 'order';
 $('ignore').value = (rule.ignore||[]).join('\n');
 // v1 档案额外回填到高级模板（用户切过去就能看到原始模板）
 if (rule.version === 1){ advanced = { source:rule.source, target:rule.target }; if($('adv-source'))$('adv-source').value=rule.source; if($('adv-target'))$('adv-target').value=rule.target; }
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
 foot.className='row';
 const add = document.createElement('button');
 add.type='button'; add.textContent='＋ 添加一组样例';
 add.addEventListener('click',()=>{ editor = addSample(editor, L.id); renderLayouts(); invalidate(); });
 const delSample = document.createElement('button');
 delSample.type='button'; delSample.className='secondary'; delSample.textContent='－ 删除最后一组';
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
  bar.className='row of-mark-bar';
  for (const f of ['id','name','text']){
   const b=document.createElement('button');
   b.type='button'; b.className='secondary';
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
 const layoutName=(r)=>{
  if(!r.kind)return '';
  return ' · '+(r.kind==='narration'?'旁白':'对话');
 };
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
 void layoutName;
}

/* ---------------- 运行 ---------------- */

function run(){
 try{
  const {text,err}=hooks.getSource();if(err)throw new Error(err);
  const d=parseFormatAny(text,readRule());
  if(!d.errors.length&&exportFormat(d,d.records.map(r=>({translation:r.target.values.text,nameTr:r.target.values.name})))!==text)throw new Error('未编辑回写不一致');
  preview=d;page=0;$('ack').checked=false;
  if (mode()==='samples') renderLayoutStatus();
  renderPreview();
 }catch(e){invalidate();setReport(e.message);}
}

/* ---------------- 挂载 ---------------- */

export async function initOfflineFormats(options){
 hooks=options;const current=++generation;
 if(!mounted){
  const host=document.createElement('section');host.className='settings-section offline-format-section';
  host.innerHTML=`<div class="settings-section-heading"><span class="settings-section-index">离线</span><div><h4>样例配置与格式档案</h4><p>无需 AI 或额外环境。给每种布局至少两组原文/译文样例，选中文字标为「编号 / 角色名 / 正文」，程序据此生成规则。</p></div></div>
  <div class="row"><label for="of-profiles">格式档案</label><select id="of-profiles"></select><button type="button" id="of-use">使用档案</button><button type="button" id="of-import">导入档案</button><input id="of-file" type="file" accept=".json" hidden></div>
  <label for="of-name">档案名称</label><input id="of-name" type="text" maxlength="100">

  <div class="row"><label for="of-mode">配置方式</label><select id="of-mode">
   <option value="samples">用样例标注（推荐，不需要懂正则）</option>
   <option value="advanced">直接编辑模板（高级）</option>
  </select></div>

  <div id="of-pane-samples">
   <div id="of-layouts"></div>
   <div class="row"><button type="button" id="of-add-dialogue">＋ 添加对话布局</button><button type="button" id="of-add-narration" class="secondary">＋ 添加旁白布局</button></div>
   <p class="settings-caption">每个布局至少两组样例。未标注的文字会作为固定结构原样保留；标注错了点胶囊即可撤销。</p>
  </div>

  <div id="of-pane-advanced" class="hidden">
   <div class="offline-template-grid">
    <div><label for="of-adv-source">原文模板</label><textarea id="of-adv-source" rows="4" spellcheck="false"></textarea></div>
    <div><label for="of-adv-target">译文模板</label><textarea id="of-adv-target" rows="4" spellcheck="false"></textarea></div>
   </div>
   <p class="settings-caption">正文标为 {text}，编号为 {id}，角色名为 {name}。每个模板需要固定开头。</p>
  </div>

  <label for="of-pairing">原译配对</label><select id="of-pairing"><option value="order">按各自出现顺序</option><option value="id">按相同编号（支持原译分区）</option></select>
  <label for="of-ignore">不参与翻译的行前缀（每行一个）</label><textarea id="of-ignore" rows="2"></textarea>
  <div class="row"><button type="button" id="of-preview">预览全部文本</button><button type="button" id="of-save">保存为我的档案</button><button type="button" id="of-export">导出档案</button><button type="button" id="of-delete">删除我的同名档案</button></div>
  <pre id="of-report" class="recog-report" role="status" aria-live="polite"></pre>
  <label><input type="checkbox" id="of-ack">我已检查未识别行，确认它们无需翻译并保持原样</label>
  <div class="offline-preview"><table><thead><tr><th>原文行</th><th>类型</th><th>原文 / 未识别内容</th><th>译文</th></tr></thead><tbody id="of-rows"></tbody></table></div>
  <div class="row"><button type="button" id="of-prev">上一页</button><span id="of-pages"></span><button type="button" id="of-next">下一页</button><button type="button" id="of-load" disabled>按此格式载入</button></div>
  <p class="settings-caption">保存的档案用于后续导入自动匹配；只有唯一匹配、无错误且无未识别行时自动采用。导出的档案只含规则，不含脚本文本。</p>`;
  document.querySelector('#setModal .settings-scroll').insertBefore(host,document.querySelector('.parse-manual-section'));
  mounted=true;

  for(const id of ['name','pairing','ignore']) $(id).addEventListener('input',invalidate);
  $('adv-source').addEventListener('input',()=>{advanced.source=$('adv-source').value;invalidate();});
  $('adv-target').addEventListener('input',()=>{advanced.target=$('adv-target').value;invalidate();});
  for(const id of ['recogText','recogSrcFile','recogSrcPaste'])document.getElementById(id).addEventListener('input',invalidate);
  $('mode').addEventListener('change',()=>{
   const adv = mode()==='advanced';
   $('pane-samples').classList.toggle('hidden',adv);
   $('pane-advanced').classList.toggle('hidden',!adv);
   invalidate();
  });
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
   fillFromRule(obj&&obj.version===2?validateFormatV2(obj):validateFormat(obj));
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
