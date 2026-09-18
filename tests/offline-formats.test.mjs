import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFormat, exportFormat, validateFormat, chooseFormat, BUILTIN_FORMATS} from '../src/offline-formats.js';
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
