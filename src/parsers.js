// parsers.js — 文本解析模块
// 行为与原单文件 HTML 版 parsePrefix/makePara/parseFile 保持一致(详见 翻译工具说明.md)

/* 解析配置(可编辑,存 settings.json;识别产出的规则档案 profile.parseConfig 同构,可直接复用)
   - open/close: 原文/译文标记字符(默认 ☆/★),输出(★ 行)用它
   - regex: 自定义前缀正则(默认空=按标记自动生成标准结构)
     约定 A(旧): 正则含 2 个捕获组 → group1 前缀、group2 正文
     约定 B(新): 正则含命名捕获组 (?<id>…)(?<name>…)?(?<content>…) → 直接取编号/说话人/正文
   - commentPrefixes: 注释/元信息行前缀(如 #NOTTRANS 的 #),整行跳过不参与原文/译文
   - nameIdPatterns: 名字行编号判定正则(如 ^NAME、^[0-9A-Fa-f]+N$),命中即按名字行处理 */
export const DEFAULT_COMMENT_PREFIXES = ['#', ';', '//', '%'];
export const DEFAULT_NAME_ID_PATTERNS = ['^NAME', '^[0-9A-Fa-f]+N$'];

export const parseConf = {
  open: '☆', close: '★', regex: '',
  commentPrefixes: DEFAULT_COMMENT_PREFIXES.slice(),
  nameIdPatterns: DEFAULT_NAME_ID_PATTERNS.slice(),
};

function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let prefixRe = null;
let markRe = null;
let commentPrefixRe = null;
let nameIdRes = null;

function getPrefixRe(){
  if (prefixRe) return prefixRe;
  if (parseConf.regex){
    try { prefixRe = new RegExp(parseConf.regex); } catch (e){ prefixRe = null; }
  }
  if (!prefixRe){
    const o = escRe(parseConf.open), c = escRe(parseConf.close);
    prefixRe = new RegExp('^([' + o + c + '][^' + o + c + ']*[' + o + c + '](?:[^' + o + c + ']*[' + o + c + '])?)([\\s\\S]*)$');
  }
  return prefixRe;
}

function getMarkRe(){
  if (markRe) return markRe;
  markRe = new RegExp('[' + escRe(parseConf.open) + escRe(parseConf.close) + ']', 'g');
  return markRe;
}

function getCommentPrefixRe(){
  if (commentPrefixRe) return commentPrefixRe;
  // 空数组 = 显式禁用注释行(用户清空生效);返回 null 表示没有注释行
  const pre = parseConf.commentPrefixes || [];
  if (!pre.length){
    commentPrefixRe = null;
  } else {
    commentPrefixRe = new RegExp('^\\s*(?:' + pre.map(escRe).join('|') + ')');
  }
  return commentPrefixRe;
}

function getNameIdRes(){
  if (nameIdRes) return nameIdRes;
  // 空数组 = 显式禁用名字行(用户清空生效);默认值在 parseConf 初始化时已含
  const pats = parseConf.nameIdPatterns || [];
  nameIdRes = pats.map(p => new RegExp(p, 'i'));
  return nameIdRes;
}

export function setParseConf(c){
  if (c && typeof c === 'object'){
    if (typeof c.open === 'string' && c.open) parseConf.open = c.open;
    if (typeof c.close === 'string' && c.close) parseConf.close = c.close;
    if (typeof c.regex === 'string') parseConf.regex = c.regex;
    if (Array.isArray(c.commentPrefixes)) parseConf.commentPrefixes = c.commentPrefixes.slice();
    if (Array.isArray(c.nameIdPatterns)) parseConf.nameIdPatterns = c.nameIdPatterns.slice();
  }
  prefixRe = null;
  markRe = null;
  commentPrefixRe = null;
  nameIdRes = null;
}

export function getParseConf(){
  return {
    open: parseConf.open, close: parseConf.close, regex: parseConf.regex,
    commentPrefixes: parseConf.commentPrefixes.slice(),
    nameIdPatterns: parseConf.nameIdPatterns.slice(),
  };
}

// 拆出“前缀/编号/说话人”与正文内容。
// 自动模式(默认): ☆0003☆桐吾☆「ありがとう」 -> id=0003 name=桐吾 content=「ありがとう」
// 自定义正则: 命名捕获组 (?<id>…)(?<name>…)?(?<content>…) 优先;
//   无命名组时按旧约定 group1=前缀、group2=正文,编号/说话人从前缀段提取。
// 返回 { prefix, content, id, name, named } ; named=true 表示编号/说话人来自命名组。
export function parsePrefix(line){
  const m = line.match(getPrefixRe());
  if (!m) return { prefix: '', content: line, id: '', name: '', named: false };
  if (m.groups && (m.groups.id !== undefined || m.groups.name !== undefined || m.groups.content !== undefined)){
    return {
      prefix: m[1] !== undefined ? m[1] : '',
      content: m.groups.content !== undefined ? m.groups.content : (m[2] !== undefined ? m[2] : ''),
      id: m.groups.id !== undefined ? m.groups.id : '',
      name: m.groups.name !== undefined ? m.groups.name : '',
      named: true,
    };
  }
  // 旧约定: group1=前缀、group2=正文;编号/说话人从前缀段提取(去掉首尾标记后的段落)
  const segs = m[1] ? m[1].replace(getMarkRe(), '\n').split('\n').slice(1, -1) : [];
  return { prefix: m[1], content: m[2], id: segs[0] || '', name: segs[1] || '', named: false };
}

// 前缀拆成 [id, name] 段(自动/命名组两种模式统一;无说话人段时只有 [id])
function segsOf(pp){
  if (pp.named){
    const s = [];
    if (pp.id !== '') s.push(pp.id);
    if (pp.name !== '') s.push(pp.name);
    return s;
  }
  return pp.prefix.replace(getMarkRe(), '\n').split('\n').slice(1, -1);
}

// 去掉首尾「」(仅当同时存在)
export function stripBrackets(s){
  if (s.length >= 2 && s[0] === '「' && s[s.length - 1] === '」') return s.slice(1, -1);
  return s;
}

// 行的“有效译文内容”:带锁定括号的行取括号中间,否则取整体
export function transValue(p){
  return p.brackets ? stripBrackets(p.translation) : p.translation;
}

// 名字行判定: 编号命中配置的名字行正则(如 NAME|n、N 后缀) —— 正文本身就是说话人,
// 编辑器按名字行处理(名字栏可编辑、自动已翻译)。
export function isNameRowId(id){
  return getNameIdRes().some(re => re.test(id));
}

// 注释/元信息行(如 #NOTTRANS): 行首是配置的注释前缀,不作为原文/译文内容
function isCommentLine(ln){
  const re = getCommentPrefixRe();
  return re ? re.test(ln) : false;
}

// 把一行原文(可选带已有译文)组装成段落数据对象
// 返回: { orig, prefix, content, id, name, segs, isName, nameTr, translation, brackets, done }
export function makePara(orig, translation, nameTr){
  const pp = parsePrefix(orig);
  const prefix = pp.prefix;
  const content = pp.content;
  const segs = segsOf(pp);
  const id = pp.id;
  // NAME 条目(☆NAME|n☆沙織)或名字行编号(☆000001N☆里奈):“正文”本身就是说话人
  const isName = isNameRowId(id);
  let name = isName ? content : pp.name;
  // 【宗一郎】 这类角括号包裹的名字: 名字取括号内,导出时自动还原括号
  let nameWrap = false;
  if (isName){
    const u = content.match(/^【([\s\S]*?)】$/);
    if (u){ name = u[1]; nameWrap = true; }
  }
  let tr = translation || '';
  // 原文或译文首尾带「」时锁定括号:存储统一为包含「」
  const brackets = (content.startsWith('「') && content.endsWith('」')) ||
                   (tr.startsWith('「') && tr.endsWith('」'));
  if (brackets && tr !== '' && !(tr.startsWith('「') && tr.endsWith('」'))){
    tr = '「' + tr + '」';
  }
  const mid = brackets ? stripBrackets(tr) : tr;
  // 名字行译名(来自 ★ 行正文)若带【】,与原文名同样剥掉,统一由导出时还原
  let nameTrFinal = nameTr || name;
  if (isName && nameWrap && nameTrFinal.startsWith('【') && nameTrFinal.endsWith('】')){
    nameTrFinal = nameTrFinal.slice(1, -1);
  }
  return {
    orig, prefix, content, id, name, segs, isName: !!isName,
    nameWrap,
    nameTr: nameTrFinal,
    translation: tr,
    brackets: brackets,
    // NAME 行: 名字框有内容(原文名或译名)即算已翻译 —— 自动确认,无需手动标记。
    // 原文名/中文同名(如「大和」)导入即已翻译;清空名字框才会回到未翻译。
    done: isName ? ((nameTrFinal || name) !== '') : (mid.trim() !== '')
  };
}

// 把文件文本解析成段落(空行分隔,每段最多两行:☆原文 + ★已有译文)
// 返回 { paras, nl } ; nl 为文件换行风格('\n' 或 '\r\n')
export function parseFile(text){
  const nl = text.indexOf('\r') >= 0 ? '\r\n' : '\n';
  const raw = text.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  for (const ln of raw){
    if (ln.trim() === ''){
      if (cur.length){ blocks.push(cur); cur = []; }
    } else {
      cur.push(ln);
    }
  }
  if (cur.length) blocks.push(cur);
  const paras = blocks.map(b => {
    // 注释/元信息行(#、;、//、% 开头,如 #NOTTRANS)不作为原文/译文:
    // 从块里剥离,附着到段落(p.comments),导出时还原回原文行之前。
    // 否则编辑器会把 #NOTTRANS 当原文行,真正的正文提取不出来。
    const comments = b.filter(isCommentLine);
    const content = b.filter(ln => !isCommentLine(ln));
    const origLine = content[0] || b[0]; // 无正文行时退化为原块首行(纯注释块)
    let nameTr = '', translation = '';
    if (content[1]){
      const s = parsePrefix(content[1]);
      translation = s.content;
      // NAME 条目 / 名字行编号:译名位于 ★ 行正文;其他:位于说话人段
      nameTr = isNameRowId(s.id) ? s.content : s.name;
    }
    const para = makePara(origLine, translation, nameTr);
    if (comments.length && content.length) para.comments = comments;
    return para;
  });
  // 原文件是否以空行结尾(保证导出无损还原)。
  // 注意: split(/\r?\n/) 对"以换行结尾"的文件会产生一个末尾空元素,那不是空行;
  // 空行结尾意味着末尾至少两个空元素(如 "...\n\n" → ['…','',''] 或 "...\r\n\r\n" → ['…','',''])。
  const n = raw.length;
  const trailingBlank = n >= 2 && raw[n - 1] === '' && raw[n - 2] === '' && blocks.length > 0;
  return { paras, nl, trailingBlank };
}

// 构造 ★ 译文行前缀:段数与原文一致,说话人段用可编辑的 nameTr(标记字符用配置的 close)
//   '☆0003☆桐吾☆' -> '★0003★<nameTr>★'   '☆TEXT|0☆' -> '★TEXT|0★'
export function buildStarPrefix(p){
  const segs = p.segs.slice();
  if (segs.length >= 2){
    segs[1] = p.nameTr; // 说话人段
  } else if (p.nameTr !== ''){
    segs.push(p.nameTr); // 原文无说话人段,但用户填了名字 → 追加
  }
  return parseConf.close + segs.join(parseConf.close) + parseConf.close;
}

// 重建整个导出文本(☆原文 + ★译文 + 空行)
// 规则: 原文行始终输出; NAME 条目始终输出 ★ 行; 普通行仅当译文有效时输出 ★ 行
// trailingBlank: 原文件以空行结尾时保留末尾空行(保证无损还原)
export function buildExport(paras, nl, trailingBlank){
  const lines = [];
  for (const p of paras){
    if (p.comments?.length) lines.push(...p.comments); // 注释行(如 #NOTTRANS)还原回原文行之前
    lines.push(p.orig); // 原文行原样保留
    if (p.isName){
      // 名字条目:始终输出 ★ 行,保证两行结构;名字未改时保留原名
      // 【名】 包裹的名字:导出时自动还原括号
      const nm = (p.nameTr || p.name);
      lines.push(parseConf.close + p.segs[0] + parseConf.close + (p.nameWrap ? '【' + nm + '】' : nm));
    } else if (transValue(p).trim() !== ''){
      lines.push(buildStarPrefix(p) + p.translation); // 译文行(含可编辑说话人)
    }
    lines.push(''); // 段落间空行
  }
  if (!trailingBlank){
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
  }
  return lines.join(nl) + nl;
}

/* ---------- 术语表扫描(词条提示用) ---------- */

// 扫描原文正文中命中的术语词条(按词条长度降序、原文精确匹配,避免短词条先吃掉长词条的子串)
// 返回命中片段数组: [{ from, to, src, dst }] 按出现顺序
export function scanTerms(content, terms){
  if (!terms || !Object.keys(terms).length) return [];
  // 按词条长度降序,长的先匹配
  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  const marks = [];
  let i = 0;
  while (i < content.length){
    let hit = null;
    for (const k of keys){
      if (content.startsWith(k, i)){
        hit = { from: i, to: i + k.length, src: k, dst: terms[k] };
        break;
      }
    }
    if (hit){
      marks.push(hit);
      i = hit.to;
    } else {
      i++;
    }
  }
  return marks;
}

/* ---------- 原文高亮区间计算(纯逻辑,可单测) ---------- */

// 把区间列表合并成不重叠单元(断点切分),每单元归属最高优先级类型(mark > term)
export function mergeRanges(ranges){
  if (!ranges.length) return [];
  const pts = new Set();
  for (const r of ranges){ pts.add(r.from); pts.add(r.to); }
  const ps = [...pts].sort((a, b) => a - b);
  const units = [];
  for (let k = 0; k < ps.length - 1; k++){
    const from = ps[k], to = ps[k + 1];
    if (from === to) continue;
    // 找覆盖该单元的区间;优先级 mark > term
    let type = null, data = null;
    for (const r of ranges){
      if (r.from <= from && to <= r.to){
        if (r.type === 'mark'){ type = 'mark'; data = null; break; }
        if (r.type === 'term' && !type){ type = 'term'; data = r.dst; }
      }
    }
    units.push({ from, to, type, data });
  }
  return units;
}

// 计算第 i 行原文的高亮区间(搜索匹配 mark + 术语命中 term)
// 关键: 只采用本行 i 的搜索匹配,避免其他行的匹配坐标污染本行高亮
export function buildOrigHighlights(i, content, matches, terms){
  const ranges = [];
  for (const m of matches){
    if (m.i === i && m.col === 'orig') ranges.push({ type: 'mark', from: m.from, to: m.to });
  }
  for (const t of scanTerms(content, terms)){
    ranges.push({ type: 'term', from: t.from, to: t.to, dst: t.dst });
  }
  return mergeRanges(ranges);
}

// 合并保存的进度到新解析的段落(恢复进度时用,纯函数,可单测):
// 规则 —— 文件本身已带的译文(★ 行)与名字优先,进度只填补文件未翻译的行。
// 避免陈旧的缓存进度整体覆盖掉文件里已有的译文(否则只能删 AppData 恢复)。
// fresh/saved 均按 orig 对齐(行号错位时精确匹配原文,不按行号硬搬)。
export function mergeSavedState(fresh, saved){
  const byOrig = new Map();
  for (const q of saved) byOrig.set(q.orig, q);
  return fresh.map(p => {
    const q = byOrig.get(p.orig);
    if (!q) return p;
    const out = Object.assign({}, p);
    // 译文: 文件已翻译则保留文件的;未翻译才用进度里的(并保持括号规则)。
    // 占位译文(★ 行与 ☆ 行内容完全相同,如 ★TEXT|1★<原文照抄>)也视为未翻译,
    // 允许进度译文补进来 —— 否则恢复进度会被文件里的日文占位行挡掉。
    const fileHasTrans = transValue(p).trim() !== '' && !(!p.isName && p.translation === p.content);
    if (!fileHasTrans && (q.translation || '').trim() !== ''){
      let tr = q.translation;
      if (p.brackets && !(tr.startsWith('「') && tr.endsWith('」'))) tr = '「' + tr + '」';
      out.translation = tr;
    }
    // 名字: 文件 ★ 行已指定(≠原文)则保留;否则用进度里的译名
    if (p.nameTr === p.name && q.nameTr && q.nameTr !== q.name){
      out.nameTr = q.nameTr;
    }
    // 同步已翻译状态(与 makePara 的 done 口径一致)
    out.done = out.isName ? (out.nameTr || '').trim() !== '' : transValue(out).trim() !== '';
    return out;
  });
}

// NAME 行历史数据迁移(纯函数,可单测):
// 旧版本把名字误存进 NAME 行的 translation,但 NAME 条目不导出 ★ 正文,造成"改了不生效"。
// 迁移规则: NAME 行且 nameTr 仍是原名时,把 translation 转正到 nameTr 并清空 translation。
// 返回迁移条数。
export function migrateNameTranslations(paras){
  let n = 0;
  for (const p of paras){
    if (!p.isName) continue;
    const t = (p.translation || '').trim();
    if (t && p.nameTr === p.name){
      p.nameTr = t;
      p.translation = '';
      n++;
    }
  }
  return n;
}
