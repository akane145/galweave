import test from 'node:test';
import assert from 'node:assert/strict';
import { makePara } from '../src/parsers.js';
import { buildProofReport } from '../src/proof-report.js';

function row(id, text, translated){ return makePara(`☆${id}☆紬☆「${text}」`, `「${translated}」`); }
function edit(p, before, after, at, field='translation', line=1){return {id:`c_${at}`,paraId:p.orig,line,field,before,after,at,source:'edit'};}
test('一次汇总四项材料；多次修改取现存最早旧译与当前译文，保留已解决批注',()=>{
  const p=row('0000','待ってた？','你在等我吗？');
  p.pr={status:'approved',annotations:[{type:'suggestion',text:'主语应当是对方。',resolved:true},{type:'note',text:'保留疑问语气。',resolved:false}]};
  const report=buildProofReport([p],[edit(p,'「你等我？」','「你在等我？」',20),edit(p,'「等了吗？」','「你等我？」',10)],{filename:'common.ks',at:0});
  assert.equal(report.count,1); assert.match(report.markdown,/待ってた/);assert.match(report.markdown,/等了吗/);assert.match(report.markdown,/你在等我吗/);
  assert.match(report.markdown,/主语应当是对方/);assert.match(report.markdown,/已解决/);assert.match(report.markdown,/保留疑问语气/);
  assert.equal(report.missingBeforeCount,0);
});
test('有批注无历史不编造旧译；有改译无批注不编造修改理由；无关段落不导出',()=>{
  const p=row('1','原文甲','译文甲');p.pr={annotations:[{type:'question',text:'确认语气',resolved:false}]};
  const q=row('2','原文乙','改译乙');const untouched=row('3','无关原文','无关译文');
  const report=buildProofReport([p,q,untouched],[edit(q,'旧译乙','改译乙',1,'translation',2)]);
  assert.equal(report.count,2);assert.equal(report.missingBeforeCount,1);
  assert.match(report.markdown,/缺失：没有保留/);assert.match(report.markdown,/未填写修改意见/);assert.ok(!report.markdown.includes('无关原文'));
});
test('超过面板的50条仍完整导出，并将无法可靠定位的历史单独报告',()=>{
  const rows=Array.from({length:60},(_,i)=>row(String(i),'原文'+i,'译文'+i));
  const changes=rows.map((p,i)=>edit(p,'旧译'+i,'新译'+i,i,'translation',i+1));changes.push({...changes[0],paraId:'已删除'});
  const report=buildProofReport(rows,changes);assert.equal(report.count,60);assert.equal(report.unmatchedChanges,1);assert.match(report.markdown,/旧译59/);
});
test('译名与译文分别导出；原文代码围栏、Markdown符号和同毫秒修改顺序保真',()=>{
  const p=row('0','日文 ```\n## 标题','最终译文');p.nameTr='小紬';
  p.pr={annotations:[{type:'note',text:'```\n# 不应变成标题',resolved:false}]};
  const history=[edit(p,'中间','最终译文',1),edit(p,'最早','中间',1),edit(p,'紬','小紬',0,'nameTr')];
  const report=buildProofReport([p],history,{filename:'脚本\n# 伪标题.ks'});assert.equal(report.count,2);
  assert.match(report.markdown,/最早/);assert.match(report.markdown,/译名/);assert.match(report.markdown,/小紬/);assert.match(report.markdown,/````text/);
});
