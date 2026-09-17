// 当前脚本的校对意见汇总。纯逻辑，所有意见只来自已有批注，不推测改译理由。
const ANNOTATION = {issue:'问题',suggestion:'建议',question:'疑问',note:'备注'};
const STATE = {approved:'已通过',pending:'待校对',issue:'有问题'};
const inline = value => String(value ?? '').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]<>#|]/g,'\\$&');
const block = value => {
  const text=String(value ?? '');const fence='`'.repeat(Math.max(2,...(text.match(/`+/g)||[]).map(s=>s.length))+1);
  return `${fence}text\n${text}\n${fence}`;
};
export function buildProofReport(paras, changes, {filename='未命名脚本',at=Date.now()}={}){
  const positions=new Map(),groups=new Map();let unmatchedChanges=0;
  paras.forEach((p,i)=>{if(!positions.has(p.orig))positions.set(p.orig,[]);positions.get(p.orig).push(i);});
  // 修改记录在存储中是最新在前；同一毫秒时也必须保留这个顺序。
  changes.forEach((c,order)=>{
    if(!['translation','nameTr'].includes(c.field) || c.before===c.after)return;
    const matches=positions.get(c.paraId)||[];const hinted=Number(c.line)-1;
    const i=matches.includes(hinted)?hinted:matches.length===1?matches[0]:-1;
    if(i<0){unmatchedChanges++;return;}
    const key=`${i}:${c.field}`;if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...c,order});
  });
  const entries=[];
  paras.forEach((p,i)=>{
    const annotations=(p.pr?.annotations||[]).filter(a=>typeof a.text==='string' && a.text.trim());
    let fields=['translation','nameTr'].filter(field=>groups.has(`${i}:${field}`));
    if(!fields.length && annotations.length)fields=[p.isName?'nameTr':'translation'];
    for(const field of fields){
      const history=(groups.get(`${i}:${field}`)||[]).sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0)||b.order-a.order);
      entries.push({index:i,field,original:field==='nameTr'?p.name:p.content,before:history.length?history[0].before:null,
        after:field==='nameTr'?p.nameTr:p.translation,speaker:p.nameTr||p.name||'旁白',status:p.pr?.status||'pending',annotations,historyCount:history.length});
    }
  });
  const missingBeforeCount=entries.filter(e=>e.before===null).length;
  const lines=['# Galweave 校对意见','',`脚本：${inline(filename)}`,`导出时间：${new Date(at).toISOString()}`,`共 ${entries.length} 项；其中 ${missingBeforeCount} 项缺少修改前译文。`,'',
    '> 导出当前脚本中有批注或保留改译历史的条目。修改前译文取现存历史中最早的记录，可能不是项目初译；修改后译文取导出时的当前内容。段落号是编辑器序号，不是脚本物理行号。',
    '> 修改历史最多保留 500 条；批注是段落级意见，不能据此断言它对应某一次改动。已解决的意见也会保留。',''];
  if(unmatchedChanges)lines.push(`提示：${unmatchedChanges} 条修改历史无法可靠定位到当前段落，已跳过，未猜测配对。`,'');
  for(const [n,e] of entries.entries()){
    lines.push(`## ${n+1}. 第 ${e.index+1} 段 · ${e.field==='nameTr'?'译名修改':'译文校对'}`,'',
      `角色：${inline(e.speaker)} · 校对状态：${STATE[e.status]||'待校对'} · 合并 ${e.historyCount} 条修改记录`,'',
      '### 日文原文','',block(e.original),'','### 修改前的译文','',
      e.before===null?'缺失：没有保留这条内容修改前的译文，无法还原。':block(e.before),'',
      '### 当前修改后的译文','',String(e.after??'').length?block(e.after):'（当前译文为空）','','### 我的修改意见','');
    if(!e.annotations.length)lines.push('未填写修改意见；没有根据译文变化自动生成理由。','');
    else for(const [j,a] of e.annotations.entries())lines.push(`**意见 ${j+1} · ${ANNOTATION[a.type]||'批注'} · ${a.resolved?'已解决':'未解决'}**`,'',block(a.text),'');
  }
  return {markdown:lines.join('\n'),count:entries.length,missingBeforeCount,unmatchedChanges};
}
