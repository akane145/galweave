import { BUILTIN_FORMATS, validateFormat, parseFormat, exportFormat } from './offline-formats.js';
import { loadSettings, saveSettings } from './settings.js';
import { downloadTextWithDialog, getAppDir } from './fs.js';

export async function savedFormats(){
 const settings=await loadSettings();
 return (Array.isArray(settings.offlineFormats)?settings.offlineFormats:[]).flatMap(r=>{try{return [validateFormat(r)];}catch{return [];}});
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
const $=id=>document.getElementById('of-'+id);
function read(){return validateFormat({version:1,name:$('name').value,source:$('source').value,target:$('target').value,pairing:$('pairing').value,ignore:$('ignore').value.split('\n').map(x=>x.trim()).filter(Boolean)});}
function invalidate(){preview=null;$('load').disabled=true;$('report').textContent='配置或文本已改变，请重新预览。';$('rows').replaceChildren();}
function fill(rule){$('name').value=rule.name;$('source').value=rule.source;$('target').value=rule.target;$('pairing').value=rule.pairing;$('ignore').value=rule.ignore.join('\n');$('ack').checked=false;invalidate();}
async function choices(){
 const selected=$('profiles').value;$('profiles').replaceChildren();
 const rules=[...BUILTIN_FORMATS,...await savedFormats()];
 rules.forEach((r,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=(i<BUILTIN_FORMATS.length?'内置 · ':'我的 · ')+r.name;$('profiles').append(o);});
 $('profiles').value=selected||'0';return rules;
}
function mark(side,key){
 const input=$(side),a=input.selectionStart,b=input.selectionEnd;
 if(a===b){$('report').textContent='请先在样例中选中要标注的文字。';return;}
 input.setRangeText('{'+key+'}',a,b,'select');input.focus();invalidate();
}
function renderPreview(){
 const d=preview;if(!d)return;
 $('report').textContent=`${d.rule.name}：${d.records.length} 条原译文，${d.errors.length} 个错误，${d.unmatched.length} 行未识别。\n`+
 d.errors.join('\n')+(d.unmatched.length?'\n未识别行将保持原样；请逐一确认是否漏掉了正文。':d.errors.length?'':'\n未编辑回写校验通过。');
 const list=$('rows');list.replaceChildren();
 const entries=[...d.records.map(r=>({line:r.source.line,source:r.source.values.text,target:r.target.values.text})),...d.unmatched.map(r=>({line:r.line,source:r.text,target:'未识别（保持原样）'}))];
 const total=Math.max(1,Math.ceil(entries.length/50));page=Math.min(page,total-1);
 for(const r of entries.slice(page*50,page*50+50)){
  const tr=document.createElement('tr');for(const text of [r.line,r.source,r.target]){const td=document.createElement('td');td.textContent=String(text);tr.append(td);}list.append(tr);
 }
 $('pages').textContent=`第 ${page+1} / ${total} 页（全部 ${entries.length} 项）`;
 $('prev').disabled=page===0;$('next').disabled=page>=total-1;
 $('load').disabled=!!d.errors.length||!!d.unmatched.length&&!$('ack').checked;
}
function run(){
 try{
  const {text,err}=hooks.getSource();if(err)throw new Error(err);
  const d=parseFormat(text,read());
  if(!d.errors.length&&exportFormat(d,d.records.map(r=>({translation:r.target.values.text,nameTr:r.target.values.name})))!==text)throw new Error('未编辑回写不一致');
  preview=d;page=0;$('ack').checked=false;renderPreview();
 }catch(e){invalidate();$('report').textContent=e.message;}
}
export async function initOfflineFormats(options){
 hooks=options;const current=++generation;
 if(!mounted){
  const host=document.createElement('section');host.className='settings-section offline-format-section';
  host.innerHTML=`<div class="settings-section-heading"><span class="settings-section-index">离线</span><div><h4>样例配置与格式档案</h4><p>无需 AI 或额外环境。复制原文和译文样例，选中文字并标注字段。支持单行、多行块、顺序或编号配对。</p></div></div>
  <div class="row"><label for="of-profiles">格式档案</label><select id="of-profiles"></select><button type="button" id="of-use">使用档案</button><button type="button" id="of-import">导入档案</button><input id="of-file" type="file" accept=".json" hidden></div>
  <label for="of-name">档案名称</label><input id="of-name" type="text" maxlength="100">
  <div class="offline-template-grid">
   <div><label for="of-source">原文样例 / 模板</label><textarea id="of-source" rows="4" spellcheck="false"></textarea><div class="row"><button type="button" data-of-mark="source:text">标为正文</button><button type="button" data-of-mark="source:id">标为编号</button><button type="button" data-of-mark="source:name">标为角色名</button></div></div>
   <div><label for="of-target">译文样例 / 模板</label><textarea id="of-target" rows="4" spellcheck="false"></textarea><div class="row"><button type="button" data-of-mark="target:text">标为正文</button><button type="button" data-of-mark="target:id">标为编号</button><button type="button" data-of-mark="target:name">标为角色名</button></div></div>
  </div>
  <p class="settings-caption">固定符号和换行保留。正文标为 {text}，编号为 {id}，角色名为 {name}。每个模板需要固定开头；多行正文请连同起止标记复制。当前需有配对译文槽（内容可为空）。</p>
  <label for="of-pairing">原译配对</label><select id="of-pairing"><option value="order">按各自出现顺序</option><option value="id">按相同编号（支持原译分区）</option></select>
  <label for="of-ignore">不参与翻译的行前缀（每行一个）</label><textarea id="of-ignore" rows="2"></textarea>
  <div class="row"><button type="button" id="of-preview">预览全部文本</button><button type="button" id="of-save">保存为我的档案</button><button type="button" id="of-export">导出档案</button><button type="button" id="of-delete">删除我的同名档案</button></div>
  <pre id="of-report" class="recog-report" role="status" aria-live="polite"></pre>
  <label><input type="checkbox" id="of-ack">我已检查未识别行，确认它们无需翻译并保持原样</label>
  <div class="offline-preview"><table><thead><tr><th>原文行</th><th>原文 / 未识别内容</th><th>译文</th></tr></thead><tbody id="of-rows"></tbody></table></div>
  <div class="row"><button type="button" id="of-prev">上一页</button><span id="of-pages"></span><button type="button" id="of-next">下一页</button><button type="button" id="of-load" disabled>按此格式载入</button></div>
  <p class="settings-caption">保存的档案用于后续导入自动匹配；只有唯一匹配、无错误且无未识别行时自动采用。导出的档案只含规则，不含脚本文本。</p>`;
  document.querySelector('#setModal .settings-scroll').insertBefore(host,document.querySelector('.parse-manual-section'));
  mounted=true;
  host.querySelectorAll('[data-of-mark]').forEach(btn=>btn.addEventListener('click',()=>mark(...btn.dataset.ofMark.split(':'))));
  for(const id of ['name','source','target','pairing','ignore'])$(id).addEventListener('input',invalidate);
  for(const id of ['recogText','recogSrcFile','recogSrcPaste'])document.getElementById(id).addEventListener('input',invalidate);
  $('preview').addEventListener('click',run);
  $('ack').addEventListener('change',renderPreview);
  $('prev').addEventListener('click',()=>{page--;renderPreview();});$('next').addEventListener('click',()=>{page++;renderPreview();});
  $('use').addEventListener('click',async()=>{const i=Number($('profiles').value);const rules=await choices();if(rules[i])fill(rules[i]);});
  $('save').addEventListener('click',async()=>{try{
   const rule=read(),settings=await loadSettings(),rules=await savedFormats();
   if(rules.some(r=>r.name===rule.name))throw new Error('名称已存在，请改名，或先删除同名档案。');
   settings.offlineFormats=[...rules,rule];await saveSettings(settings);await choices();$('report').textContent='档案已保存，下次导入时自动匹配。';
  }catch(e){$('report').textContent=e.message;}});
  $('delete').addEventListener('click',async()=>{try{const settings=await loadSettings();settings.offlineFormats=(await savedFormats()).filter(r=>r.name!==$('name').value.trim());await saveSettings(settings);await choices();$('report').textContent='已删除我的同名档案（内置档案保留）。';}catch(e){$('report').textContent=e.message;}});
  $('export').addEventListener('click',async()=>{try{await downloadTextWithDialog(JSON.stringify(read(),null,2),'galweave-format.json',await getAppDir());}catch(e){$('report').textContent=e.message;}});
  $('import').addEventListener('click',()=>$('file').click());
  $('file').addEventListener('change',async()=>{try{const file=$('file').files[0];if(!file)return;if(file.size>32768)throw new Error('档案超过 32 KB');fill(validateFormat(JSON.parse(await file.text())));$('report').textContent='档案已导入，可预览后保存到我的档案。';}catch(e){$('report').textContent='导入失败：'+e.message;}finally{$('file').value='';}});
  $('load').addEventListener('click',async()=>{try{
   if(!preview||$('load').disabled)return;
   const {text,err}=hooks.getSource();if(err||text!==preview.text||JSON.stringify(read())!==JSON.stringify(preview.rule)){invalidate();return;}
   await hooks.load(preview);
  }catch(e){$('report').textContent=e.message;}});
 }
 const rules=await choices();if(current!==generation)return;
 if(!$('name').value)fill(rules[0]);else invalidate();
}
