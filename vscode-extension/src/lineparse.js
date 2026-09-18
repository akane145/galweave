// lineparse.js — 行保真解析器
//
// 目标：把全文拆成「每行一个角色 + 每段一个语义」，并保留原始行号与列区间。
// VS Code 的装饰器 / hover / 大纲 / 折叠 / 诊断全部需要这些坐标，而 src/parsers.js 的
// parseFile 按空行切块后只返回段落内容、丢掉行号，所以这里另做一个行保真的版本。
//
// 识别规则不在此重写 —— 取值一律来自 src/parsers.js：
//   parsePrefix 拆前缀、isNameRowId 判 NAME 行、computeDone 算"已翻译"（唯一口径）、
//   getParseConf 读配置。本模块只额外负责**列区间**的计算。
// 段落对象的字段名与 makePara 对齐，是它的超集，可直接喂给 buildExport / exporter.js / qa.js。

import {
  parsePrefix, isNameRowId, computeDone, getParseConf, setParseConf,
} from '../../src/parsers.js';
// 镜像格式(dc4ph)的判定与桌面版同一个函数 —— 不在这里另写一套探测规则
import { isMirrorFormatText } from '../../src/universal-parser.js';

/** 行角色 */
export const ROLE = {
  ORIG: 'orig',       // 原文行
  TRANS: 'trans',     // 译文行
  COMMENT: 'comment', // 注释/元信息行（#NOTTRANS 等）
  BLANK: 'blank',     // 空行
  OTHER: 'other',     // 段内第三行及以后（parseFile 会丢弃，这里保留不丢）
};

/** 段落类型 */
export const KIND = {
  NAME: 'name',           // 人名条目（NAME 行）
  DIALOGUE: 'dialogue',   // 对话：原文正文含「」
  NARRATION: 'narration', // 旁白：原文正文不含「」
};

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 与 src/parsers.js 的 getMarkRe 同构：把 open/close 的**每个字符**都当作标记字符。
 * 必须保持一致 —— 否则这里切出的前缀段数会与 parsePrefix/segsOf 的结果分叉。
 */
function buildMarkRe(conf) {
  return new RegExp('[' + escRe(conf.open) + escRe(conf.close) + ']', 'g');
}

/** 整段首尾是否完整包裹「」。这是**锁定括号**的判定（与 parsers.js:205 的 brackets 同源），
 *  用于译文编辑时把括号外置到输入框外，**不用于段落分类**。 */
export function isBracketed(s) {
  return typeof s === 'string' && s.length >= 2 && s.startsWith('「') && s.endsWith('」');
}

/** 正文是否**含**引号标记。这是**对话/旁白**的分类判定。
 *  与锁定括号分开算是有意为之 —— 真实样本里存在以「开头却无收尾的对话行：
 *  `☆000010☆直哉☆「そうか？　喜んでもらえて幸いだ。冷めないうちに食べてくれ。`
 *  按首尾包裹会误判成旁白，按包含判断则正确判成对话。 */
export function hasQuote(s) {
  return typeof s === 'string' && (s.includes('「') || s.includes('」'));
}

/* ---------------- 列区间 ---------------- */

/**
 * 自定义正则模式下用 `d` 标志读捕获组偏移。
 * 自动模式（无自定义正则）返回 null。
 * 之所以需要它：标记字符扫描只能推出"前缀内部按标记切的段"，
 * 而自定义正则的结构由用户定义（如说话人在正文 [[ ]] 里），扫描推不出来。
 */
function regexRanges(conf, line) {
  if (!conf.regex) return null;
  let re;
  try { re = new RegExp(conf.regex, 'd'); } catch (e) { return null; }
  const m = line.match(re);
  if (!m || !m.indices) return null;
  const groups = m.groups || {};
  const idx = m.indices.groups || {};
  const pick = (src, name) => {
    const v = src[name];
    return v ? { from: v[0], to: v[1] } : null;
  };
  return {
    hasNamed: groups.id !== undefined || groups.name !== undefined || groups.content !== undefined,
    id: pick(idx, 'id'),
    name: pick(idx, 'name'),
    content: pick(idx, 'content'),
    // 旧约定（无命名组）：group1 = 前缀、group2 = 正文
    group1: m.indices[1] ? { from: m.indices[1][0], to: m.indices[1][1] } : null,
    group2: m.indices[2] ? { from: m.indices[2][0], to: m.indices[2][1] } : null,
  };
}

/** 正文区间的兜底定位：优先"正文在行尾"倒推，否则 indexOf。 */
function locateContent(line, content) {
  if (!content) return { from: line.length, to: line.length };
  if (line.endsWith(content)) return { from: line.length - content.length, to: line.length };
  const i = line.indexOf(content);
  return i >= 0 ? { from: i, to: i + content.length } : { from: 0, to: 0 };
}

/**
 * 一行原文的语义片段列区间。三条路径按可用性优先：
 *   1. 自定义正则 + 命名捕获组 → 直接用 m.indices，最精确（可取到正文里的说话人）
 *   2. 自定义正则 + 旧约定(2 组) → 前缀取 group1，正文取 group2，段在前缀内按标记切
 *   3. 自动模式 → 标记字符扫描切段（段0=编号、段1=说话人），正文取行尾
 */
function rangesOf(conf, line, pp, ctx) {
  const rr = regexRanges(conf, line);

  if (rr && rr.hasNamed) {
    return {
      idRange: rr.id,
      speakerRange: rr.name,
      contentRange: rr.content || locateContent(line, pp.content),
      prefixEnd: rr.id ? rr.id.to : pp.prefix.length,
      source: 'regex-named',
    };
  }

  if (rr && rr.group1) {
    // 前缀内按标记切片，再整体偏移到 group1 的起始列
    const base = rr.group1.from;
    const segs = ctx.segments(line.slice(rr.group1.from, rr.group1.to));
    const at = (s) => (s ? { from: base + s.from, to: base + s.to } : null);
    return {
      idRange: at(segs[0]),
      speakerRange: at(segs[1]),
      contentRange: rr.group2 || locateContent(line, pp.content),
      prefixEnd: rr.group1.to,
      source: 'regex-legacy',
    };
  }

  // 自动模式：前缀从第 0 列开始，段坐标即绝对坐标
  const segs = ctx.segments(pp.prefix);
  return {
    idRange: segs.length >= 1 ? { from: segs[0].from, to: segs[0].to } : null,
    speakerRange: segs.length >= 2 ? { from: segs[1].from, to: segs[1].to } : null,
    contentRange: locateContent(line, pp.content),
    prefixEnd: pp.prefix.length,
    source: 'auto',
  };
}

/* ---------------- 解析 ---------------- */

function makeCtx(conf) {
  const prefixes = conf.commentPrefixes || [];
  const commentRe = prefixes.length
    ? new RegExp('^\\s*(?:' + prefixes.map(escRe).join('|') + ')')
    : null;
  const markRe = buildMarkRe(conf);

  return {
    conf,
    isComment(ln) {
      return commentRe ? commentRe.test(ln) : false;
    },
    /**
     * 前缀 → 段数组 [{from, to, text}]，段序即语义（段0=编号，段1=说话人）。
     * 与 parsers.js 的 segsOf 等价：标记字符把前缀切开后去掉首尾两个空段。
     */
    segments(prefix) {
      markRe.lastIndex = 0;
      const pos = [];
      let m;
      while ((m = markRe.exec(prefix))) pos.push(m.index);
      if (pos.length < 2) return [];
      const spans = [{ from: 0, to: pos[0], text: prefix.slice(0, pos[0]) }];
      for (let i = 0; i + 1 < pos.length; i++) {
        const from = pos[i] + 1, to = pos[i + 1];
        spans.push({ from, to, text: prefix.slice(from, to) });
      }
      const last = pos[pos.length - 1];
      spans.push({ from: last + 1, to: prefix.length, text: prefix.slice(last + 1) });
      return spans.slice(1, -1);
    },
  };
}

/**
 * 行保真解析。
 *
 * `options.conf` 是「每文档独立规则」的落点：`src/parsers.js` 的配置是模块级状态，
 * 而本函数**全程同步**（没有任何 await），所以"就地灌入配置 → 同步解析完"之间
 * 不可能被别的调用插进来，一次解析用的必然是一套规则。
 * 传了 conf 之后模块状态会停在最后一套上，因此**调用方应当始终显式传 conf**，
 * 不要依赖"当前生效配置"这种隐式状态。
 *
 * @param {string} text 全文
 * @param {{conf?: object}} [options]
 * @returns {{
 *   nl: string, trailingBlank: boolean,
 *   lines: Array<{index:number,text:string,role:string,paraIndex:number|null}>,
 *   paras: Array<object>,
 *   summary: {total:number,name:number,dialogue:number,narration:number,done:number,untranslated:number}
 * }}
 */
export function parseLines(text, options = {}) {
  const src = typeof text === 'string' ? text : '';
  if (options.conf) setParseConf(options.conf);
  const conf = getParseConf();
  const ctx = makeCtx(conf);
  const nl = src.indexOf('\r') >= 0 ? '\r\n' : '\n';
  const raw = src.split(/\r?\n/);

  const lines = raw.map((t, i) => ({
    index: i, text: t, role: ROLE.BLANK, paraIndex: null,
  }));

  // 镜像格式(dc4ph 文本导出)结构自证，不走规则库 —— 见文件末尾「镜像格式」一节
  if (isMirrorFormatText(src)) return parseMirrorLines(src, raw, lines, nl);

  const paras = [];

  function buildPara(indices) {
    const commentIdx = [];
    const contentIdx = [];
    for (const i of indices) {
      if (ctx.isComment(raw[i])) {
        commentIdx.push(i);
        lines[i].role = ROLE.COMMENT;
      } else {
        contentIdx.push(i);
      }
    }
    // 纯注释块：不产生段落。与 parseFile 的退化行为（把首行当原文）不同 ——
    // 在编辑器里注释块本就没有原文，凭空造一个段落反而会误导装饰器。
    if (!contentIdx.length) return;

    contentIdx.forEach((i, k) => {
      lines[i].role = k === 0 ? ROLE.ORIG : (k === 1 ? ROLE.TRANS : ROLE.OTHER);
    });

    const origIdx = contentIdx[0];
    const transIdx = contentIdx.length > 1 ? contentIdx[1] : null;
    const origLine = raw[origIdx];
    const pp = parsePrefix(origLine);

    const isName = isNameRowId(pp.id);
    // NAME 条目（☆NAME|n☆沙織）：正文本身就是说话人；【】包裹时取括号内（导出时还原）
    let name = isName ? pp.content : pp.name;
    let nameWrap = false;
    if (isName) {
      const u = pp.content.match(/^【([\s\S]*?)】$/);
      if (u) { name = u[1]; nameWrap = true; }
    }

    // 译文侧（来自 ★ 行；无 ★ 行时留空）
    let translation = '';
    let nameTr = '';
    let translationRange = null;
    let transId = '';
    let transSegs = [];
    if (transIdx !== null) {
      const tp = parsePrefix(raw[transIdx]);
      translation = tp.content;
      nameTr = isNameRowId(tp.id) ? tp.content : tp.name;
      translationRange = locateContent(raw[transIdx], tp.content);
      // 译文行的编号与段数单独留着：结构校验要拿它和原文行比对
      // （编号不匹配、说话人段数不一致都靠这两个）
      transId = tp.id;
      transSegs = tp.named
        ? [tp.id, tp.name].filter(s => s !== '')
        : (tp.prefix ? ctx.segments(tp.prefix).map(s => s.text) : []);
    }

    // 「锁定括号」保留 makePara 的口径（原文或译文任一命中），用于译文编辑；
    // 「对话/旁白」另用 hasQuote 只看原文正文 —— 两者不可混用，见函数上方注释。
    const brackets = isBracketed(pp.content) || isBracketed(translation);
    const kind = isName
      ? KIND.NAME
      : (hasQuote(pp.content) ? KIND.DIALOGUE : KIND.NARRATION);

    let nameTrFinal = nameTr || name;
    if (isName && nameWrap && nameTrFinal.startsWith('【') && nameTrFinal.endsWith('】')) {
      nameTrFinal = nameTrFinal.slice(1, -1);
    }

    const ranges = rangesOf(conf, origLine, pp, ctx);
    const paraIndex = paras.length;
    const para = {
      // —— 与 makePara 同构的字段（便于直接喂给 buildExport/exporter/qa）——
      orig: origLine,
      prefix: pp.prefix,
      content: pp.content,
      id: pp.id,
      name,
      // 段序与 parsers.js 的 segsOf 对齐：命名组模式取 [id, name]，自动模式按标记切
      segs: pp.named
        ? [pp.id, pp.name].filter(s => s !== '')
        : (pp.prefix ? ctx.segments(pp.prefix).map(s => s.text) : []),
      isName,
      nameWrap,
      nameTr: nameTrFinal,
      translation,
      brackets,
      mirror: null,
      done: false, // 下面由 computeDone 统一口径回填

      // —— 扩展专用：行号与列区间 ——
      index: paraIndex,
      kind,
      lineIndices: {
        orig: origIdx,
        trans: transIdx,
        comments: commentIdx,
        extra: contentIdx.slice(2),
      },
      prefixEnd: ranges.prefixEnd,
      contentRange: ranges.contentRange,
      idRange: ranges.idRange,
      // 无说话人段 → null；空说话人段（☆0002☆☆）→ 零宽区间
      speakerRange: ranges.speakerRange,
      translationRange,
      transId,
      transSegs,
      rangeSource: ranges.source,
      // 归属于本段的注释行（位于原文行之前）。
      // 必须是**字符串数组** —— parsers.buildExport 里是 `lines.push(...p.comments)`，
      // 放对象进去会把 "[object Object]" 写进导出文件。行号见 lineIndices.comments。
      comments: commentIdx.filter(i => i < origIdx).map(i => raw[i]),
    };
    para.done = computeDone(para);

    paras.push(para);
    lines[origIdx].paraIndex = paraIndex;
    if (transIdx !== null) lines[transIdx].paraIndex = paraIndex;
    for (const i of commentIdx) lines[i].paraIndex = paraIndex;
  }

  let block = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].trim() === '') {
      if (block.length) { buildPara(block); block = []; }
      continue;
    }
    block.push(i);
  }
  if (block.length) buildPara(block);

  return finalize(src, raw, lines, paras, nl, false);
}

/**
 * 收尾：段尾空行、末尾换行、段落摘要。标准路径与镜像路径共用 ——
 * 这两份字段各算一遍就是等着分叉，而"导出无损还原"全靠它们。
 */
function finalize(src, raw, lines, paras, nl, isMirror) {
  // 原文件是否以空行结尾（与 parsers.js:357 同口径，保证导出无损还原）
  const n = raw.length;
  const trailingBlank = n >= 2 && raw[n - 1] === '' && raw[n - 2] === '' && paras.length > 0;

  // 原文件末尾是否有换行。buildExport 收尾是 `lines.join(nl) + nl`，
  // **总是**补一个换行，所以末尾没有换行的文件回写后会多出一个 —— 导出时靠这个字段还原。
  const endsWithNewline = /(\r?\n)$/.test(src);

  const summary = {
    total: paras.length,
    name: paras.filter(p => p.kind === KIND.NAME).length,
    dialogue: paras.filter(p => p.kind === KIND.DIALOGUE).length,
    narration: paras.filter(p => p.kind === KIND.NARRATION).length,
    done: paras.filter(p => p.done).length,
    untranslated: paras.filter(p => !p.done).length,
  };

  return { nl, trailingBlank, endsWithNewline, lines, paras, summary, isMirror };
}

/* ---------------- 镜像格式（dc4ph 文本导出） ----------------
 *
 * 一条消息 = `#0x地址` + `★◎ 001 ◎★//原文` + `★◎ 001 ◎★译文`（三连），
 * 未翻译时两份正文相同（引擎约定：译文行预填原文）。所以「已翻译」不能按"译文非空"判 ——
 * computeDone 已按 isPlaceholderTrans 统一口径，与桌面版同源，这里不另立标准。
 *
 * 两处与桌面版 parseMirrorFile 的差异，都是**行保真**要求下的有意选择：
 *   1) 译文正文原样存进 translation。makeMirrorPara 会在"原文带「」而译文不带"时替译文补上「」，
 *      而补出来的括号原文里没有 —— buildExport 写回后往返自检会挂，等于拒绝导出这个文件。
 *   2) 最后一条消息缺普通行（导出中断）时，识别成"原文行 + 缺译文行"的段落，
 *      桌面版把整行当正文 —— 这样「补上译文行」能按镜像格式补出格式正确的那一行。
 */

const MIRROR_HEADER_RE = /^#0x[0-9A-Fa-f]+$/;
// 与 src/parsers.js:264 的 MIRROR_RAW_LINE_RE 同构：装饰对 A B … B A + 3 位编号，
// 紧跟的单个 // 是"这是一条原文行"的结构标记。
const MIRROR_LINE_RE = /^( *)(\p{So})(\p{So})[ \t]*(\d{3})[ \t]*\3\2(\/\/)?([\s\S]*)$/u;

/** 镜像行正文：装饰后紧跟的单个 // 是结构标记（剥除），之后全部算正文。 */
function mirrorBodyOf(m) {
  const tail = m[6] || '';
  return m[5] && tail.startsWith('//') ? tail.slice(2) : tail;
}

/** 编号所在的列区间；取不到返回 null。 */
function mirrorIdRangeOf(line, m) {
  const head = m[1].length + m[2].length + m[3].length;
  const at = line.indexOf(m[4], head);
  return at < 0 ? null : { from: at, to: at + m[4].length };
}

/**
 * 斜线行 → 它对应的普通行（去掉结构标记 // 的那一行）。不是斜线行时返回 null。
 * 供「补上译文行」在尾部截断的文件上补出格式正确的一行 —— 用 ☆/★ 那套前缀会写出引擎读不出来的内容。
 */
export function mirrorPlainLineOf(line) {
  const s = typeof line === 'string' ? line : '';
  const m = s.match(MIRROR_LINE_RE);
  if (!m || !m[5]) return null;
  // 正文本身以 // 开头时（★◎ 001 ◎★////正文）剥不干净，宁可拒绝也不猜
  if ((m[6] || '').startsWith('//')) return null;
  const body = mirrorBodyOf(m);
  return s.slice(0, s.length - body.length - 2) + body;
}

/**
 * 轻量探测：这份文本是不是镜像格式（供解析前分流，不必先跑一遍规则库）。
 * 判定复用桌面版的 isMirrorFormatText —— 探测规则只有一份。
 */
export function isMirrorDoc(text) {
  return isMirrorFormatText(typeof text === "string" ? text : "");
}

/** 镜像格式的行保真解析：与 parsers.js 的 parseMirrorFile 同构，多出行号与列区间。 */
function parseMirrorLines(src, raw, lines, nl) {
  const paras = [];
  let pending = []; // 已扫过、尚未归属的 #0x 头行号（导出时写在原文行之前）

  function push(para, commentIdx) {
    para.index = paras.length;
    for (const i of commentIdx) {
      para.comments.push(raw[i]);
      para.lineIndices.comments.push(i);
      lines[i].paraIndex = para.index;
    }
    paras.push(para);
    lines[para.lineIndices.orig].paraIndex = para.index;
    if (para.lineIndices.trans !== null) lines[para.lineIndices.trans].paraIndex = para.index;
    return para;
  }

  /** 一条完整消息（// 原文行 + 同编号普通行）→ 段落 */
  function pairPara(slashIdx, plainIdx, m, pm) {
    const slashLine = raw[slashIdx];
    const plainLine = raw[plainIdx];
    const body = mirrorBodyOf(m);
    const plainBody = mirrorBodyOf(pm);
    // 正文一律取"行尾倒推"，与 parsers.js 里 prefix = line.slice(0, len - body.length) 同算法，
    // 否则前缀里会漏掉 // 这类结构标记
    const contentRange = locateContent(slashLine, body);
    const translationRange = locateContent(plainLine, plainBody);
    const para = {
      orig: slashLine,
      prefix: slashLine.slice(0, contentRange.from),
      content: body,
      id: m[4],
      // 镜像格式没有"说话人段"：名字行（正文就是一个名字）也是普通段落
      name: '',
      segs: [m[4]],
      isName: false,
      nameWrap: false,
      nameTr: '',
      translation: plainBody,
      brackets: isBracketed(body) || isBracketed(plainBody),
      mirror: {
        plainPrefix: plainLine.slice(0, translationRange.from),
        plainBody,
        indent: body.startsWith('　'),
      },
      done: false, // 由 computeDone 统一计算：预填原文不算已译

      index: paras.length,
      kind: hasQuote(body) ? KIND.DIALOGUE : KIND.NARRATION,
      lineIndices: { orig: slashIdx, trans: plainIdx, comments: [], extra: [] },
      prefixEnd: contentRange.from,
      contentRange,
      idRange: mirrorIdRangeOf(slashLine, m),
      speakerRange: null,
      translationRange,
      transId: pm[4],
      transSegs: [pm[4]],
      rangeSource: 'mirror',
      comments: [],
    };
    para.done = computeDone(para);
    return para;
  }

  /**
   * 镜像文件里不成对的行（尾部截断的最后一条消息等）。
   * 与 parsers.js 的兜底一致：整行当正文保留，不丢内容、不改写。
   */
  function loosePara(idx) {
    const line = raw[idx];
    return {
      orig: line, prefix: '', content: line, id: '', name: '', segs: [],
      isName: false, nameWrap: false, nameTr: '', translation: '',
      brackets: false, mirror: null, done: false,

      index: paras.length,
      kind: hasQuote(line) ? KIND.DIALOGUE : KIND.NARRATION,
      lineIndices: { orig: idx, trans: null, comments: [], extra: [] },
      prefixEnd: 0,
      contentRange: { from: 0, to: line.length },
      idRange: null,
      speakerRange: null,
      translationRange: null,
      transId: '',
      transSegs: [],
      rangeSource: 'mirror',
      comments: [],
    };
  }

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim() === '') continue;
    if (MIRROR_HEADER_RE.test(line.trim())) {
      lines[i].role = ROLE.COMMENT;
      pending.push(i);
      continue;
    }
    const m = line.match(MIRROR_LINE_RE);
    if (m && m[5]) {
      // // 行之后的**第一条非空行**是同一编号的普通行（译文行）
      let j = i + 1;
      while (j < raw.length && raw[j].trim() === '') j += 1;
      const pm = j < raw.length ? raw[j].match(MIRROR_LINE_RE) : null;
      if (pm && !pm[5] && pm[4] === m[4]) {
        lines[i].role = ROLE.ORIG;
        lines[j].role = ROLE.TRANS;
        push(pairPara(i, j, m, pm), pending);
        pending = [];
        i = j;
        continue;
      }
    }
    lines[i].role = ROLE.ORIG;
    push(loosePara(i), pending);
    pending = [];
  }

  return finalize(src, raw, lines, paras, nl, true);
}

/** 取指定行号所在的段落（越界或该行不属于任何段落时返回 null）。 */
export function paraAtLine(parsed, lineIndex) {
  const ln = parsed?.lines?.[lineIndex];
  if (!ln || ln.paraIndex === null || ln.paraIndex === undefined) return null;
  return parsed.paras[ln.paraIndex] || null;
}
