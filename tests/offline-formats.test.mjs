import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFormat, parseFormatV2, exportFormat, validateFormat, validateFormatV2, chooseFormat, BUILTIN_FORMATS, migrateV1ToV2, fragmentsFromTemplate, templateFromFragments, cloneFragments, sameFragments, isMultiline} from '../src/offline-formats.js';
const rule={version:1,name:'编号配对',source:'JP[{id}] {text}',target:'CN[{id}] {text}',pairing:'id',ignore:['#']};
test('原译分区按编号配对，只替换译文，原字符与混合换行保留',()=>{
 const raw='#meta\r\nJP[2] 二\r\nJP[1] 一\nCN[1] 旧一\nCN[2] 旧二\r\n';
 const doc=parseFormat(raw,rule);assert.equal(doc.errors.length,0);assert.equal(doc.unmatched.length,0);
 assert.equal(exportFormat(doc,doc.records.map(r=>({translation:r.target.values.text,nameTr:''}))),raw);
 assert.equal(exportFormat(doc,[{translation:'新二'},{translation:'新一'}]),raw.replace('旧一','新一').replace('旧二','新二'));
});
test('多行正文按样例起止符匹配，保留中间指令',()=>{
 const r={...rule,source:'<jp {id}>\n{text}\n</jp>',target:'<cn {id}>\n{text}\n</cn>'};
 const raw='<jp 1>\n第一行\n第二行\n</jp>\n#指令\n<cn 1>\n旧译\n</cn>\n';
 const d=parseFormat(raw,r);assert.equal(d.records.length,1);assert.equal(d.records[0].source.values.text,'第一行\n第二行');
 assert.equal(exportFormat(d,[{translation:'新一\n新二'}]),raw.replace('旧译','新一\n新二'));
});
test('重复编号、缺少译文、双重匹配和未知行不能自动采用',()=>{
 assert.ok(parseFormat('JP[1] 一\nJP[1] 二\nCN[1] 译',rule).errors.length);
 assert.ok(parseFormat('JP[1] 一',rule).errors.length);
 assert.ok(parseFormat('JP[1] 一\nCN[1] 译',{...rule,target:rule.source}).errors.length);
 assert.equal(chooseFormat('JP[1] 一\n未知\nCN[1] 译',[rule]).length,0);
});
test('档案校验与不可信模板拒绝，内置档案可用',()=>{
 assert.throws(()=>validateFormat({...rule,source:'{id}{text}'}));
 assert.throws(()=>validateFormat({...rule,version:99}));
 assert.throws(()=>validateFormat({...rule,source:'JP {bad}'}));
 for(const r of BUILTIN_FORMATS) assert.doesNotThrow(()=>validateFormat(r));
});
test('译文结构注入、行数变更与不可写译名拒绝导出',()=>{
 const d=parseFormat('JP[1] 一\nCN[1] 旧',rule);
 assert.throws(()=>exportFormat(d,[{translation:'新\nJP[2] 伪记录'}]));
 assert.throws(()=>exportFormat(d,[]));
 assert.throws(()=>exportFormat(d,[{translation:'新',nameTr:'未配置姓名'}]));
});
test('按出现顺序配对无需编号，角色名字仅回写译文侧',()=>{
 const d=parseFormat('原[甲]一\n译[乙]旧',{...rule,source:'原[{name}]{text}',target:'译[{name}]{text}',pairing:'order'});
 assert.equal(exportFormat(d,[{translation:'新',nameTr:'丙'}]),'原[甲]一\n译[丙]新');
});
import { buildExport } from '../src/parsers.js';
import { formatParas } from '../src/offline-formats.js';
test('编辑器原格式导出复用档案并拒绝记录重排',()=>{
 const raw='JP[1] 一\nCN[1] 旧一\nJP[2] 二\nCN[2] 旧二';
 const paras=formatParas(parseFormat(raw,rule));
 assert.equal(buildExport(paras,'\n',false),raw);
 paras[0].translation='新一';assert.equal(buildExport(paras,'\n',false),raw.replace('旧一','新一'));
 assert.throws(()=>buildExport(paras.toReversed(),'\n',false));
});
test('BOM、空译文及终止符原样保留',()=>{
 const raw='\uFEFFJP[1] 一\r\nCN[1] \r\n\r\n';
 const d=parseFormat(raw,rule);assert.equal(d.errors.length,0);assert.equal(d.unmatched.length,0);
 assert.equal(exportFormat(d,[{translation:''}]),raw);
});
test('控制标签不得被删除或重排',()=>{
 const d=parseFormat('JP[1] 一[np]\nCN[1] 旧[np]',rule);
 assert.throws(()=>exportFormat(d,[{translation:'新'}]),/控制标记/);
 assert.equal(exportFormat(d,[{translation:'新[np]'}]),'JP[1] 一[np]\nCN[1] 新[np]');
});

/* ================= v2 契约与 v1 迁移（Task 1） ================= */

test('v1→v2 迁移：单模板变成各一条 pattern，语义类型默认对话',()=>{
 const v2=migrateV1ToV2(rule);
 assert.equal(v2.version,2);
 assert.equal(v2.pairing,'id');
 assert.deepEqual(v2.ignore,['#']);
 assert.equal(v2.sourcePatterns.length,1);
 assert.equal(v2.targetPatterns.length,1);
 assert.equal(v2.sourcePatterns[0].kind,'dialogue');
 assert.equal(v2.sourcePatterns[0].target,v2.targetPatterns[0].id);
 assert.deepEqual(v2.sourcePatterns[0].fragments,[
  {type:'literal',value:'JP['},{type:'field',field:'id'},{type:'literal',value:'] '},{type:'field',field:'text'},
 ]);
});

test('v1→v2 迁移：所有内置档案都能迁移且不抛异常',()=>{
 for(const r of BUILTIN_FORMATS) assert.doesNotThrow(()=>migrateV1ToV2(r),r.name);
});

test('v1→v2 迁移：非法 v1 档案被拒绝（与 validateFormat 同源）',()=>{
 assert.throws(()=>migrateV1ToV2({...rule,version:99}));
 assert.throws(()=>migrateV1ToV2({...rule,source:'{id}{text}'}));
 assert.throws(()=>migrateV1ToV2({...rule,name:''}));
 assert.throws(()=>migrateV1ToV2({...rule,pairing:'id',source:'固定{text}',target:'CN[{id}] {text}'}));
});

test('片段编译与 v1 模板编译逐字等价（迁移不能改变匹配行为）',()=>{
 const cases=[
  ['JP[1] 一\nJP[2] 二\nCN[1] 旧一\nCN[2] 旧二\n',rule],
  ['<jp 1>\n多行\n正文\n</jp>\n<cn 1>\n旧\n</cn>\n',BUILTIN_FORMATS[2]],
  ['原文：甲\n原文：乙\n译文：A\n译文：乙\n',BUILTIN_FORMATS[0]],
  ['原[甲]一\n译[乙]旧\n',{...rule,source:'原[{name}]{text}',target:'译[{name}]{text}',pairing:'order'}],
 ];
 for(const [text,v1] of cases){
  const a=parseFormat(text,v1);
  const v2=migrateV1ToV2(v1);
  const v2doc=parseFormatV2(text,v2);
  assert.equal(v2doc.errors.length,a.errors.length,'错误数应一致：'+v1.name);
  assert.deepEqual(v2doc.errors,a.errors,'错误内容应一致：'+v1.name);
  assert.deepEqual(v2doc.unmatched,a.unmatched,'未识别行应一致：'+v1.name);
  assert.equal(v2doc.records.length,a.records.length,'记录数应一致：'+v1.name);
  a.records.forEach((r,i)=>{
   assert.deepEqual(v2doc.records[i].source.values,r.source.values,'原文取值：'+v1.name);
   assert.deepEqual(v2doc.records[i].target.values,r.target.values,'译文取值：'+v1.name);
  });
 }
});

test('v2 校验：非法结构被拒绝',()=>{
 const good=migrateV1ToV2(rule);
 assert.throws(()=>validateFormatV2({...good,version:1}),/版本/);
 assert.throws(()=>validateFormatV2({...good,sourcePatterns:[]}),/至少需要一个原文布局/);
 assert.throws(()=>validateFormatV2({...good,targetPatterns:[]}),/至少需要一个译文布局/);
 assert.throws(()=>validateFormatV2({...good,sourcePatterns:[{...good.sourcePatterns[0],kind:'独白'}]}),/语义类型/);
 assert.throws(()=>validateFormatV2({...good,sourcePatterns:[{...good.sourcePatterns[0],target:'nope'}]}),/不存在的译文布局/);
 assert.throws(()=>validateFormatV2({...good,sourcePatterns:[{...good.sourcePatterns[0],id:'bad id!'}]}),/标识不合法/);
});

test('v2 校验：字段层面的非法被拒绝',()=>{
 const mk=frags=>({version:2,name:'x',pairing:'order',ignore:[],targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'T'},{type:'field',field:'text'}]}],sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:frags}]});
 assert.throws(()=>validateFormatV2(mk([{type:'field',field:'text'}])),/必须以固定文字开头/);
 assert.throws(()=>validateFormatV2(mk([{type:'literal',value:'A'}])),/需包含正文/);
 assert.throws(()=>validateFormatV2(mk([{type:'literal',value:'A'},{type:'field',field:'text'},{type:'field',field:'text'}])),/只能标注一次/);
 assert.throws(()=>validateFormatV2(mk([{type:'literal',value:'A'},{type:'field',field:'text'},{type:'field',field:'id'}])),/固定分隔文字/);
 assert.throws(()=>validateFormatV2(mk([{type:'literal',value:'A'},{type:'field',field:'bad'}])),/只支持编号、角色名、正文/);
 assert.throws(()=>validateFormatV2(mk([{type:'literal',value:'A'},{type:'field',field:'text'},{type:'literal',value:'x'.repeat(5000)}])),/超过/);
});

test('v2 校验：原文与译文布局同形被拒绝（会双匹配）',()=>{
 assert.throws(()=>validateFormatV2({
  version:2,name:'x',pairing:'order',ignore:[],
  targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'A'},{type:'field',field:'text'}]}],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'A'},{type:'field',field:'text'}]}],
 }),/不能相同/);
});

test('v2 校验：相同译文布局自动去重，不产生伪歧义',()=>{
 const shared=[{type:'literal',value:'CN: '},{type:'field',field:'text'}];
 const v=validateFormatV2({
  version:2,name:'x',pairing:'order',ignore:[],
  targetPatterns:[{id:'t1',fragments:shared},{id:'t2',fragments:cloneFragments(shared)}],
  sourcePatterns:[
   {id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'A: '},{type:'field',field:'text'}]},
   {id:'s2',kind:'narration',target:'t2',fragments:[{type:'literal',value:'B: '},{type:'field',field:'text'}]},
  ],
 });
 assert.equal(v.targetPatterns.length,1,'相同译文布局应合并为一条');
 assert.equal(v.sourcePatterns[0].target,v.sourcePatterns[1].target,'两条原文应指向同一译文布局');
});

test('片段工具：模板与片段互转、同形判定、多行识别',()=>{
 const frags=fragmentsFromTemplate('<jp {id}>\n{text}\n</jp>');
 assert.equal(templateFromFragments(frags),'<jp {id}>\n{text}\n</jp>');
 assert.equal(isMultiline(frags),true);
 assert.equal(isMultiline(fragmentsFromTemplate('JP[{id}] {text}')),false);
 assert.equal(sameFragments(frags,cloneFragments(frags)),true);
 assert.equal(sameFragments(frags,fragmentsFromTemplate('JP[{id}] {text}')),false);
});

/* ================= v2 编辑与回写（Task 4） ================= */

/** 造一个"对话 + 旁白"两种原文布局、共用一种译文布局的 v2 档案 */
function twoLayoutRule(){
 return validateFormatV2({
  version:2,name:'对话与旁白',pairing:'id',ignore:['#'],
  targetPatterns:[{id:'t1',fragments:[
   {type:'literal',value:'CN['},{type:'field',field:'id'},{type:'literal',value:'] '},{type:'field',field:'text'},
  ]}],
  sourcePatterns:[
   {id:'s1',kind:'dialogue',target:'t1',fragments:[
    {type:'literal',value:'☆'},{type:'field',field:'id'},{type:'literal',value:'☆'},{type:'field',field:'name'},{type:'literal',value:'☆'},{type:'field',field:'text'},
   ]},
   {id:'s2',kind:'narration',target:'t1',fragments:[
    {type:'literal',value:'◆'},{type:'field',field:'id'},{type:'literal',value:'◆'},{type:'field',field:'text'},
   ]},
  ],
 });
}

test('v2：同一文件混合解析带角色名对话与无角色名旁白',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 assert.equal(doc.errors.length,0,'不该有错误：'+doc.errors.join('|'));
 assert.equal(doc.unmatched.length,0);
 assert.equal(doc.records.length,2);
 assert.equal(doc.records[0].kind,'dialogue');
 assert.equal(doc.records[1].kind,'narration');
 assert.equal(doc.records[0].source.values.name,'アリス');
});

test('v2：对话进角色名与正文栏，旁白不伪造角色名',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const paras=formatParas(parseFormatV2(raw,twoLayoutRule()));
 assert.equal(paras[0].name,'アリス','对话应有角色名');
 assert.equal(paras[0].translation,'早上好');
 assert.equal(paras[1].name,'','旁白不该伪造角色名');
 assert.equal(paras[1].translation,'真好看的晚霞');
 assert.equal(paras[1].offlineKind,'narration','要带上布局语义，供 UI 显示');
 assert.equal(paras[0].offlineSourcePattern,'s1');
});

test('v2：只改译文时，原文/编号/固定前缀逐字符不变',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 const out=exportFormat(doc,[{translation:'早安'},{translation:'晚霞真好看'}]);
 assert.equal(out,raw.replace('早上好','早安').replace('真好看的晚霞','晚霞真好看'));
 expectNoStructuralChange(raw,out);
});

test('v2：改译名只写译文侧 name 槽；旁白走同一译文布局时不误写',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 // 译文布局 t1 没有 name 槽 → 试图改译名应被拒绝（写回位置不存在）
 assert.throws(()=>exportFormat(doc,[{translation:'早上好',nameTr:'爱丽丝'},{translation:'真好看的晚霞'}]),
  /未配置译名写回位置/);
});

test('v2：未编辑回写与原文件逐字符一致（含 BOM、CRLF、混合换行）',()=>{
 const raws=[
  '\uFEFF☆1☆アリス☆おはよう\r\n◆2◆きれいな夕焼けだ\r\nCN[1] 早上好\r\nCN[2] 真好看的晚霞\r\n',
  '☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞',
 ];
 for(const raw of raws){
  const doc=parseFormatV2(raw,twoLayoutRule());
  assert.equal(doc.errors.length,0,'不该有错误');
  assert.equal(exportFormat(doc,doc.records.map(r=>({translation:r.target.values.text}))),raw,'未编辑回写必须逐字符一致');
 }
});

test('v2：记录被重排或删除时阻止回写',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 const paras=formatParas(doc);
 // 重排：把两条记录换个位置。
 // 断言只要求"必须抛错" —— 两道门禁都可能先命中（buildExport 的顺序校验、
 // exportFormat 的记录完整性校验），任一拦住即达到目的，不锁定具体措辞。
 const swapped=[paras[1],paras[0]];
 assert.throws(()=>buildExport(swapped,'\n',false),/记录|顺序|不完整/);
 // 删除：少一条
 assert.throws(()=>buildExport([paras[0]],'\n',false),/记录|顺序|不完整/);
});

test('v2：offlineKey 与档案顺序不一致时，buildExport 明确拒绝',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 const paras=formatParas(doc);
 // 顺序仍在、但 key 被改过 → 命中 buildExport 的顺序守卫
 const bogus=paras.map((p,i)=>({...p,offlineKey:String(9-i)}));
 assert.throws(()=>buildExport(bogus,'\n',false),/记录顺序发生变化/);
});

test('v2：回写校验能挡住把译文改成伪造新记录的内容',()=>{
 const raw='☆1☆アリス☆おはよう\nCN[1] 早上好\n';
 const rule=validateFormatV2({
  version:2,name:'x',pairing:'id',ignore:[],
  targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'CN['},{type:'field',field:'id'},{type:'literal',value:'] '},{type:'field',field:'text'}]}],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'☆'},{type:'field',field:'id'},{type:'literal',value:'☆'},{type:'field',field:'text'}]}],
 });
 const doc=parseFormatV2(raw,rule);
 assert.throws(()=>exportFormat(doc,[{translation:'新\n☆2☆伪记录'}]));
});

test('v2：多行正文的编辑与回写（换行合法）',()=>{
 const rule=validateFormatV2({
  version:2,name:'多行',pairing:'id',ignore:[],
  targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'<cn '},{type:'field',field:'id'},{type:'literal',value:'>\n'},{type:'field',field:'text'},{type:'literal',value:'\n</cn>'}]}],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'<jp '},{type:'field',field:'id'},{type:'literal',value:'>\n'},{type:'field',field:'text'},{type:'literal',value:'\n</jp>'}]}],
 });
 const raw='<jp 1>\n第一行\n第二行\n</jp>\n<cn 1>\n旧一\n旧二\n</cn>\n';
 const doc=parseFormatV2(raw,rule);
 assert.equal(doc.records.length,1);
 assert.equal(doc.records[0].source.values.text,'第一行\n第二行');
 assert.equal(exportFormat(doc,[{translation:'新一\n新二'}]),raw.replace('旧一\n旧二','新一\n新二'));
});

/** 断言：原文侧的所有字符都还在（结构未被编辑动过） */
function expectNoStructuralChange(before,after){
 const stripTranslation=s=>s.split(/\r?\n/).filter(l=>!l.startsWith('CN[')).join('\n');
 assert.equal(stripTranslation(after),stripTranslation(before),'原文侧不应有任何变化');
}

/* ================= 控制符与结构注入门禁（Task 5） ================= */

/** 带控制符的 v2 档案（正文里含 [r] 换行标签） */
function tokenRule(){
 return validateFormatV2({
  version:2,name:'带控制符',pairing:'id',ignore:[],
  targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'CN['},{type:'field',field:'id'},{type:'literal',value:'] '},{type:'field',field:'text'}]}],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'☆'},{type:'field',field:'id'},{type:'literal',value:'☆'},{type:'field',field:'text'}]}],
 });
}

test('v2 门禁：译文删掉控制符 → 阻止回写',()=>{
 const raw='☆1☆あ[r]い\nCN[1] 啊[r]咦\n';
 const doc=parseFormatV2(raw,tokenRule());
 assert.throws(()=>exportFormat(doc,[{translation:'啊咦'}]),/控制标记被删除、新增或重排/);
});

test('v2 门禁：译文新增控制符 → 阻止回写',()=>{
 const raw='☆1☆あい\nCN[1] 啊咦\n';
 const doc=parseFormatV2(raw,tokenRule());
 assert.throws(()=>exportFormat(doc,[{translation:'啊[r]咦'}]),/控制标记被删除、新增或重排/);
});

test('v2 门禁：命令类控制符重排 → 阻止回写',()=>{
 // ⚠️ 这里刻意用**命令类**（%p 定位，语法为 `%p100;`）而不是换行类（[r]）：
 //    tokenizeInline 只比对控制符的**序列**，同种换行标签互换位置序列不变。
 //    而这是设计使然 —— universal-parser.js 明确写了"译文断行要随中文长度重排，
 //    译者常需要挪动断点"，断行标签换位置不该拦。
 //    命令类会改脚本行为，必须拦；本用例验证门禁对命令类有效。
 const raw='☆1☆あ%p100;い%p200;う\nCN[1] 甲%p100;乙%p200;丙\n';
 const doc=parseFormatV2(raw,tokenRule());
 // 交换两个定位命令的顺序 → token 序列变为 ['%p200;','%p100;']
 assert.throws(()=>exportFormat(doc,[{translation:'甲%p200;乙%p100;丙'}]),/控制标记被删除、新增或重排/);
});

test('v2 门禁：换行类标签挪位置允许（译者需按中文长度重新断行）',()=>{
 const raw='☆1☆あ[r]い[r]う\nCN[1] 甲[r]乙[r]丙\n';
 const doc=parseFormatV2(raw,tokenRule());
 // 数量与种类不变、位置调整 → 应允许（这是既有的、经论证的设计）
 assert.doesNotThrow(()=>exportFormat(doc,[{translation:'甲乙[r]丙[r]'}]));
});

test('v2 门禁：控制符原样保留时允许回写',()=>{
 const raw='☆1☆あ[r]い\nCN[1] 啊[r]咦\n';
 const doc=parseFormatV2(raw,tokenRule());
 assert.equal(exportFormat(doc,[{translation:'甲[r]乙'}]),raw.replace('啊[r]咦','甲[r]乙'));
});

test('v2 门禁：译文里插入"像新记录"的内容不能改变记录数',()=>{
 const raw='☆1☆あ\n☆2☆い\nCN[1] 甲\nCN[2] 乙\n';
 const doc=parseFormatV2(raw,tokenRule());
 assert.equal(doc.records.length,2);
 // 在第一行译文里塞入第二行的原文样式 → 回写复验时记录数或原文取值必然对不上
 assert.throws(()=>exportFormat(doc,[{translation:'甲\n☆3☆伪'},{translation:'乙'}]),/结构|记录|边界/);
});

test('v2 门禁：译文里插入译文前缀也不能改变字段边界',()=>{
 const raw='☆1☆あ\nCN[1] 甲\n';
 const doc=parseFormatV2(raw,tokenRule());
 assert.throws(()=>exportFormat(doc,[{translation:'甲\nCN[2] 伪'}]));
});

test('v2 门禁：多行正文的合法换行与结构性结束标记可区分',()=>{
 const rule=validateFormatV2({
  version:2,name:'多行',pairing:'id',ignore:[],
  targetPatterns:[{id:'t1',fragments:[{type:'literal',value:'<cn '},{type:'field',field:'id'},{type:'literal',value:'>\n'},{type:'field',field:'text'},{type:'literal',value:'\n</cn>'}]}],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:[{type:'literal',value:'<jp '},{type:'field',field:'id'},{type:'literal',value:'>\n'},{type:'field',field:'text'},{type:'literal',value:'\n</jp>'}]}],
 });
 const raw='<jp 1>\n一\n二\n</jp>\n<cn 1>\n旧\n</cn>\n';
 const doc=parseFormatV2(raw,rule);
 // 合法：正文内换行
 assert.equal(exportFormat(doc,[{translation:'新甲\n新乙'}]),raw.replace('旧','新甲\n新乙'));
 // 非法：正文里写入结束标记，会提前终止记录
 assert.throws(()=>exportFormat(doc,[{translation:'新\n</cn>\n<cn 2>伪'}]));
});

test('v2 门禁：翻译记忆/术语批量替换后仍能安全回写（不误伤）',()=>{
 const raw='☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早上好\nCN[2] 真好看的晚霞\n';
 const doc=parseFormatV2(raw,twoLayoutRule());
 // 模拟一次普通编辑：两句都改
 const out=exportFormat(doc,[{translation:'早安'},{translation:'晚霞真好看'}]);
 assert.equal(out,'☆1☆アリス☆おはよう\n◆2◆きれいな夕焼けだ\nCN[1] 早安\nCN[2] 晚霞真好看\n');
 // 再解析应完全一致
 const again=parseFormatV2(out,twoLayoutRule());
 assert.equal(again.errors.length,0);
 assert.equal(again.records.length,2);
 assert.equal(again.records[0].target.values.text,'早安');
});
