// recognize.js — 文本格式识别 / 规范化 / 还原(纯逻辑,浏览器 GUI 与 CLI 共用)
// 逻辑与 scripts/recognize-format.mjs 完全一致(CLI 从此模块导入,单一来源):
//   检测标记字符(☆/★、○/●…)、编号形状、说话人来源(前缀段 / [[名字]])、
//   行分类(对话/旁白/有名文本/控制行)、问题清单;规范化成 ☆/★ 两行格式;按档案还原原格式。
// 本模块不依赖 Node/DOM,可在浏览器与测试中直接使用。

/* ---------------- 基础工具 ---------------- */

// 分行并统计: 前导空行数 leadingBlank、末尾换行数 trailing(含结尾换行)。
// 'a' → trailing 0; 'a\n' → trailing 1; 'a\n\n' → trailing 2(一个空行 + 结尾换行)。
export function splitText(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let leadingBlank = 0;
  while (leadingBlank < raw.length && raw[leadingBlank] === '') leadingBlank++;
  let trailing = 0;
  for (let i = raw.length - 1; i >= 0 && raw[i] === ''; i--) trailing++;
  // 去掉前导/末尾空元素(数量已分别记在 leadingBlank / trailing)
  const lines = raw.slice(leadingBlank, raw.length - trailing);
  return { lines, nl, leadingBlank, trailing };
}

export function isBlank(line) {
  return /^\s*$/.test(line);
}

export function isComment(line) {
  return /^\s*(?:#|;|\/\/|;|%)[^\S\r\n]?/.test(line) && !/^\s*[○●☆★◯◉]/u.test(line);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------------- 标记字符检测 ---------------- */

function markerStats(lines) {
  const stats = new Map();
  for (const line of lines) {
    const first = [...line.trimStart()][0];
    if (!first || /[\p{L}\p{N}_\s]/u.test(first)) continue;
    const rest = line.trimStart().slice(first.length);
    const second = rest.indexOf(first);
    if (second < 1) continue;
    const id = rest.slice(0, second);
    if (!id || id.length > 80) continue;
    const item = stats.get(first) || { marker: first, lines: 0, ids: new Map(), examples: [] };
    item.lines += 1;
    item.ids.set(id, (item.ids.get(id) || 0) + 1);
    if (item.examples.length < 3) item.examples.push(line.trim());
    stats.set(first, item);
  }
  return stats;
}

export function detectMarks(lines) {
  const stats = markerStats(lines);
  const candidates = [...stats.values()].sort((a, b) => b.lines - a.lines);
  if (!candidates.length) return { open: '☆', close: '★', pairs: 0, confidence: 0 };

  const pairScores = [];
  for (const left of candidates) {
    for (const right of candidates) {
      if (left.marker === right.marker) continue;
      let common = 0;
      for (const id of left.ids.keys()) if (right.ids.has(id)) common += 1;
      if (common) pairScores.push({ left, right, common, score: common * 10 + Math.min(left.lines, right.lines) });
    }
  }
  pairScores.sort((a, b) => b.score - a.score);
  const best = pairScores[0];
  if (best) return {
    open: best.left.marker,
    close: best.right.marker,
    pairs: best.common,
    confidence: Math.min(1, best.common / Math.max(1, Math.min(best.left.lines, best.right.lines))),
  };
  return { open: candidates[0].marker, close: '', pairs: 0, confidence: 0.2 };
}

/* ---------------- 行结构分析 ---------------- */

export function parseMarkedLine(line, marker) {
  const trimmed = line.trimStart();
  if (!marker || !trimmed.startsWith(marker)) return null;
  const second = trimmed.indexOf(marker, marker.length);
  if (second < 1) return null;
  const id = trimmed.slice(marker.length, second);
  const tail = trimmed.slice(second + marker.length);
  const segs = tail.split(marker);
  let name = '';
  let content = tail;
  if (segs.length >= 2) {
    name = segs.shift();
    content = segs.join(marker);
  }
  return {
    line,
    marker,
    id,
    name,
    content,
    segments: [id, ...(name !== '' || tail.includes(marker) ? [name] : []), content],
    prefix: `${trimmed.slice(0, marker.length)}${id}${marker}`,
    leadingWhitespace: line.slice(0, line.length - trimmed.length),
  };
}

export function parseBracketSpeaker(content) {
  // 支持 [[名]] 与 【名】 两种说话人包裹(记录样式,还原时按原样式贴回)
  const m = content.match(/^\s*(\[\[[^\]]*\]\]|【[^】]*】)(\s*)([\s\S]*)$/u);
  if (!m) return { name: '', content };
  const raw = m[1];
  const bracketStyle = raw.startsWith('【') ? '【】' : '[[]]';
  const name = (bracketStyle === '【】' ? raw.slice(1, -1) : raw.slice(2, -2)).trim();
  return { name, content: m[3], bracketSpeaker: true, bracketStyle };
}

// 名字行正文里的角括号包裹(【名】): 名字取括号内
function stripNameWrap(content) {
  const m = content.match(/^【([\s\S]*?)】$/);
  return m ? m[1] : content;
}

// 对话行正文只取「…」部分(含括号);括号外内容(如 [np] 标签)剥离出来单独保留,供还原时贴回。
// 这样"自动识别"产出的正文里不再有「」之外的字符(用户不改那些部分,也不该进译文编辑区)。
export function splitDialogue(content) {
  const m = content.match(/^[「『][\s\S]*?[」』]/u);
  if (!m) return { dialogue: content, extra: '' };
  return { dialogue: m[0], extra: content.slice(m[0].length) };
}

export function hasDialogueQuote(content) {
  return /^\s*(?:[「『“"]|\[[^\]]+\]\s*[「『“"])/u.test(content);
}

// 名字行判定(与 parsers.js 一致): NAME|n 前缀 或 N 后缀编号
// patterns: 可选的名字行编号正则数组(来自规则档案/检测结果,如 ['^NAME','^[0-9A-Fa-f]+N$'])
export function isNameRowId(id, patterns) {
  if (patterns && patterns.length) return patterns.some(p => new RegExp(p, 'i').test(id));
  return /^NAME/i.test(id) || /^[0-9A-Fa-f]+N$/i.test(id);
}

export function classify(row) {
  if (!row) return 'unknown';
  if (row.kind === 'control') return 'control';
  if (row.nameEntry) return 'name-entry';
  if (row.name) return hasDialogueQuote(row.source) ? 'dialogue' : 'named-text';
  return hasDialogueQuote(row.source) ? 'dialogue' : 'narration';
}

export function detectIdShape(ids) {
  const values = ids.filter(Boolean);
  if (!values.length) return 'none';
  if (values.every((id) => /^\d+$/u.test(id))) return 'numeric';
  if (values.every((id) => /^[0-9A-F]+$/iu.test(id))) return 'hex';
  if (values.every((id) => /^[0-9A-F|]+$/iu.test(id)) && values.some((id) => id.includes('|'))) return 'hex-pipe';
  if (values.every((id) => /^(?:TEXT|NAME)\|\d+$/iu.test(id))) return 'text-name';
  if (values.every((id) => /^[0-9A-F]+[NRT]$/iu.test(id))) return 'suffix-nrt';
  return 'other';
}

export function idRegex(shape) {
  return ({
    numeric: '^[0-9]+$',
    hex: '^[0-9A-Fa-f]+$',
    'hex-pipe': '^[0-9A-Fa-f|]+$',
    'text-name': '^(TEXT|NAME)\\|\\d+$',
    'suffix-nrt': '^[0-9A-Fa-f]+[NRT]$',
  })[shape] || '';
}

/* ---------------- 成对分块 ---------------- */

const DEFAULT_COMMENT_PREFIXES = ['#', ';', '//', '%'];
const DEFAULT_NAME_ID_PATTERNS = ['^NAME', '^[0-9A-Fa-f]+N$'];

// 注释前缀检测(返回正则;命中即整行视为注释/控制行,如 #NOTTRANS)
export function makeCommentRe(prefixes){
  const pre = prefixes && prefixes.length ? prefixes : DEFAULT_COMMENT_PREFIXES;
  return new RegExp('^\\s*(?:' + pre.map(escapeRegExp).join('|') + ')');
}

// 从“名字行”的编号集合反推名字行编号正则
// 名字行来源 = 开头 NAME + 数字(NAME|n) + N 后缀;其他编号一律不是名字行。
// 返回正则数组(如 ['^NAME', '^[0-9A-Fa-f]+N$']);无名字行时返回默认集(识别阶段始终可判定)。
export function detectNameIdPatterns(ids){
  const set = new Set();
  for (const id of ids){
    if (!id) continue;
    if (/^NAME/i.test(id)) set.add('^NAME');
    else if (/^[0-9A-Fa-f]+N$/i.test(id)) set.add('^[0-9A-Fa-f]+N$');
  }
  return [...set];
}

// 返回统计来源使用的名字行判定模式(检测结果优先;未检测到则回退内置默认,保证档案明确可复用)
function namePatternsFor(detected, ids){
  if (detected && detected.length) return detected;
  return DEFAULT_NAME_ID_PATTERNS.slice();
}

// 从行的开头字符统计“疑似注释前缀”(用于 #NOTTRANS 之类注释行)
// 规则: 每个前缀首字按出现次数取代表字;# ; / % 出现次数都 ≥2 才纳入(避免误判);
// 除此之外仅当 >50% 的块都以同一符号开头时纳入(单行注释等场景)。
export function detectCommentPrefixes(lines){
  const stats = new Map();
  for (const line of lines){
    if (isBlank(line)) continue;
    const m = line.match(/^\s*([#;/%][^\s#;/%])/);
    if (!m) continue;
    const p = m[1];
    const c = p[0];
    stats.set(c, (stats.get(c) || 0) + 1);
  }
  const out = [];
  const total = lines.filter(l => !isBlank(l)).length;
  for (const [c, n] of stats){
    if (n >= 2 && (['#', ';', '/', '%'].includes(c) || n / total > 0.5)) out.push(c);
  }
  return out;
}

function makePairBlocks(lines, marks, namePatterns, commentPrefixes) {
  const commentRe = makeCommentRe(commentPrefixes);
  const nameRes = (namePatterns && namePatterns.length ? namePatterns : DEFAULT_NAME_ID_PATTERNS)
    .map(p => new RegExp(p, 'i'));
  const isNameId = id => nameRes.some(re => re.test(id));

  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (isBlank(line)) flush();
    else current.push(line);
  }
  flush();

  const rows = [];
  const issues = [];
  let sequence = 0;
  for (const block of blocks) {
    const sourceLine = block.map((line, index) => ({ line, index, parsed: parseMarkedLine(line, marks.open) }))
      .find((entry) => entry.parsed);
    const transLine = block.map((line, index) => ({ line, index, parsed: parseMarkedLine(line, marks.close) }))
      .find((entry) => entry.parsed);
    if (!sourceLine && !transLine) {
      const kind = block.every(isComment) ? 'control' : 'unmarked';
      rows.push({ sequence: sequence++, kind, source: block[0], translation: '', lines: block, id: '' });
      if (kind === 'unmarked') issues.push({ type: 'other-line', detail: `无法归类行: ${block[0].slice(0, 80)}` });
      continue;
    }
    if (!sourceLine) {
      rows.push({ sequence: sequence++, kind: 'translation-only', source: '', translation: transLine.line, lines: block, id: transLine.parsed.id });
      issues.push({ type: 'trans-without-orig', detail: `译文行前无对应原文行: ${transLine.line.slice(0, 80)}` });
      continue;
    }
    const source = sourceLine.parsed;
    const translation = transLine?.parsed || null;
    const controlLines = block.filter((line) => commentRe.test(line));
    const bracket = parseBracketSpeaker(source.content);
    const transBracket = translation ? parseBracketSpeaker(translation.content) : { name: '', content: '' };
    const explicitNameSegment = source.segments.length >= 3;
    const sourceName = source.name || bracket.name;
    const sourceContent = source.name !== '' || explicitNameSegment ? source.content : bracket.content;
    const translationName = translation ? (translation.name || transBracket.name) : '';
    const translationContent = translation ? (translation.name ? translation.content : transBracket.content) : '';
    // 名字行(NAME|n / N 后缀): 正文即名字,【名】包裹时名字取括号内(正文保留原样供还原)
    const nameEntryRow = isNameId(source.id);
    const row = {
      sequence: sequence++,
      kind: 'row',
      id: source.id,
      nameEntry: nameEntryRow,
      sourceLine: source.line,
      translationLine: translation?.line || '',
      source: nameEntryRow ? source.content : sourceContent,
      sourceExtra: '',
      translation: nameEntryRow ? (translation ? translation.content : '') : translationContent,
      translationExtra: '',
      name: nameEntryRow ? stripNameWrap(source.content) : sourceName,
      sourceName: nameEntryRow ? stripNameWrap(source.content) : sourceName,
      translationName: nameEntryRow ? (translation ? stripNameWrap(translation.content) : '') : translationName,
      marker: source.marker,
      translationMarker: translation?.marker || marks.close,
      segments: source.segments,
      bracketSpeaker: nameEntryRow ? false : !!bracket.bracketSpeaker,
      bracketStyle: bracket.bracketStyle || '[[]]',
      explicitNameSegment,
      original: { source: source.line, translation: translation?.line || '' },
      controls: controlLines,
      lineKind: '',
    };
    // 对话行(非名字行): 正文只保留「…」内内容;「」外的标签等剥离到 Extra(档案保留,还原时贴回)
    if (!nameEntryRow){
      const sourceDialogue = hasDialogueQuote(row.source) ? splitDialogue(row.source) : null;
      const transDialogue = row.translation && hasDialogueQuote(row.translation) ? splitDialogue(row.translation) : null;
      row.source = sourceDialogue ? sourceDialogue.dialogue : row.source;
      row.sourceExtra = sourceDialogue ? sourceDialogue.extra : '';
      row.translation = transDialogue ? transDialogue.dialogue : row.translation;
      row.translationExtra = transDialogue ? transDialogue.extra : '';
    }
    row.lineKind = classify(row);
    rows.push(row);
    if (translation && source.id.toLowerCase() !== translation.id.toLowerCase()) {
      issues.push({ type: 'id-mismatch', detail: `原文 ${source.id} ↔ 译文 ${translation.id}` });
    }
    if (!translation) issues.push({ type: 'orig-only', detail: `原文没有对应译文: ${source.line.slice(0, 80)}` });
  }
  return { blocks, rows, issues };
}

// 编号偏移检测: 译文编号 = 原文编号 + offset 的系统性错位(如 ★ 行比 ☆ 行大 1)。
// 支持带后缀的编号(000000T / 000008N): 剥离尾部字母后按十六进制数字部分比较,后缀须一致。
// 返回 { offset, matched, total }。
// 用法: 传入 makePairBlocks 产出的 rows 与译文标记字符,在 detect() 主流程中调用。
export function detectIdOffset(rows, closeMarker){
  // 编号可能是十进制补零(000010=10)或十六进制(00000A=10): 含 A-F 按 16 进制,否则按 10 进制
  const numPart = id => {
    const m = id.match(/^([0-9A-Fa-f]+)([NRT]*)$/i);
    if (!m || !m[1]) return null;
    const base = /[A-Fa-f]/.test(m[1]) ? 16 : 10;
    return { n: parseInt(m[1], base), suf: m[2] || '' };
  };
  const diffs = new Map();
  let total = 0;
  for (const row of rows){
    if (row.kind !== 'row' || !row.translationLine) continue;
    const trans = parseMarkedLine(row.translationLine, closeMarker);
    if (!trans) continue;
    const s = numPart(row.id);
    const t = numPart(trans.id);
    if (!s || !t || s.suf !== t.suf) continue;
    const d = t.n - s.n;
    diffs.set(d, (diffs.get(d) || 0) + 1);
    total++;
  }
  if (!total) return { offset: 0, matched: 0, total: 0 };
  let best = 0, bestN = -1;
  for (const [d, n] of diffs) if (n > bestN){ bestN = n; best = d; }
  return { offset: best, matched: bestN, total };
}

/* ---------------- 识别主流程 ---------------- */

export function detect(text, file = '') {
  const { lines, nl, leadingBlank, trailing } = splitText(text);
  const marks = detectMarks(lines);
  // 注释前缀 / 名字行编号模式: 从数据中检测,写入规则档案供编辑器/下次导入复用
  const commentPrefixes = detectCommentPrefixes(lines);
  const detectedNamePatterns = detectNameIdPatterns(
    lines.map(l => { const p = parseMarkedLine(l, marks.open); return p ? p.id : ''; })
  );
  const namePatterns = namePatternsFor(detectedNamePatterns,
    lines.map(l => { const p = parseMarkedLine(l, marks.open); return p ? p.id : ''; }));
  const parsed = makePairBlocks(lines, marks, namePatterns, commentPrefixes);
  const rows = parsed.rows;
  const issues = parsed.issues;
  // 系统性编号偏移(译文 = 原文 + offset,如 ★000001T 配 ☆000000T);位置配对正确时仅作记录,
  // 不当作问题;真正的问题仍按逐对编号比较,但在偏移模式下跳过。
  const offsetInfo = marks.close ? detectIdOffset(rows, marks.close) : { offset: 0, matched: 0, total: 0 };
  const offset = offsetInfo.offset;
  const offsetMode = offset !== 0 && offsetInfo.matched / Math.max(1, offsetInfo.total) >= 0.8;
  const realIssues = issues.filter((x) =>
    x.type !== 'id-mismatch' ||
    (() => {
      const m = x.detail.match(/原文 (.+?) ↔ 译文 (.+)$/);
      if (!m) return true;
      const numPart = id => {
        const p = id.match(/^([0-9A-Fa-f]+)([NRT]*)$/i);
        if (!p || !p[1]) return null;
        const base = /[A-Fa-f]/.test(p[1]) ? 16 : 10;
        return { n: parseInt(p[1], base), suf: p[2] || '' };
      };
      const s = numPart(m[1]);
      const t = numPart(m[2]);
      if (!s || !t || s.suf !== t.suf) return true;
      return t.n - s.n !== offset;
    })()
  );
  const dataRows = rows.filter((row) => row.kind === 'row');
  const names = new Map();
  const tags = new Map();
  const ids = [];
  let dialogue = 0;
  let narration = 0;
  let namedText = 0;
  let nameEntry = 0;
  let control = 0;
  let separators = 0;
  for (const row of rows) {
    if (row.kind === 'row') {
      ids.push(row.id);
      if (row.name) names.set(row.name, (names.get(row.name) || 0) + 1);
      if (row.lineKind === 'dialogue') dialogue += 1;
      else if (row.lineKind === 'narration') narration += 1;
      else if (row.lineKind === 'named-text') namedText += 1;
      else if (row.lineKind === 'name-entry') nameEntry += 1;
      for (const value of `${row.source}${row.sourceExtra || ''}\n${row.translation}${row.translationExtra || ''}`.match(/\[[^\]]+\]|<[^>]+>|\([^)]*\)/gu) || []) tags.set(value, (tags.get(value) || 0) + 1);
    } else if (row.kind === 'control') control += 1;
  }
  for (let i = 0; i < lines.length; i += 1) if (isBlank(lines[i])) separators += 1;
  const nameSource = dataRows.some((row) => row.bracketSpeaker) ? 'bracket' : dataRows.some((row) => row.name) ? 'segment' : 'none';
  const nameSlot = nameSource === 'segment' ? 'yes' : nameSource === 'bracket' ? 'no' : 'none';
  // 置信度: 有配对时按对齐占比重算(原文编号与译文编号相同,或偏移模式下相差 offset 都算对齐);
  // 覆盖 detectMarks 基于"同名编号"的保守估计(编号错位的文件按偏移对齐后应恢复为高置信)
  let confidence = marks.confidence;
  if (marks.close && marks.pairs > 0){
    const numPart = id => {
      const m = id.match(/^([0-9A-Fa-f]+)([NRT]*)$/i);
      if (!m || !m[1]) return null;
      const base = /[A-Fa-f]/.test(m[1]) ? 16 : 10;
      return { n: parseInt(m[1], base), suf: m[2] || '' };
    };
    let aligned = 0, paired = 0;
    for (const row of rows){
      if (row.kind !== 'row' || !row.translationLine) continue;
      const trans = parseMarkedLine(row.translationLine, marks.close);
      if (!trans) continue;
      paired++;
      const same = row.id.toLowerCase() === trans.id.toLowerCase();
      const s = numPart(row.id);
      const t = numPart(trans.id);
      const shifted = offsetMode && s && t && s.suf === t.suf && (t.n - s.n) === offset;
      if (same || shifted) aligned++;
    }
    confidence = paired ? aligned / paired : 1;
  }
  return {
    version: 1,
    tool: 'recognize-format',
    file: file || '',
    encoding: 'utf-8',
    nl,
    leadingBlank,
    trailing,
    marks: { open: marks.open, close: marks.close, pairs: marks.pairs, confidence: Number(confidence.toFixed(3)) },
    // 规则档案(可复用): 注释前缀 + 名字行编号模式 + 编号偏移 + 解析配置
    commentPrefixes,
    nameIdPatterns: namePatterns,
    idOffset: { offset, matched: offsetInfo.matched, total: offsetInfo.total, systematic: offsetMode },
    structure: {
      idShape: detectIdShape(ids),
      idRegex: idRegex(detectIdShape(ids)),
      nameSource,
      nameSlot,
      nameSlotLabel: [...names.keys()][0] || '',
      lineKinds: { dialogue, narration, namedText, nameEntry, control, separator: separators },
      tags: Object.fromEntries([...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
      nameValues: Object.fromEntries([...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)),
    },
    rowTypes: {
      // 名字行 = 编号命中 nameIdPatterns(NAME|n 前缀 + N 后缀,如 000001N),正文即说话人
      nameRows: dataRows.filter((row) => row.nameEntry).length,
      nameSuffixN: dataRows.filter((row) => row.nameEntry && !/^NAME/i.test(row.id)).length,
      speakerRows: dataRows.filter((row) => row.name).length,
      controlRows: control,
      separatorRows: separators,
      commentPrefixes: rows.filter((row) => row.kind === 'control').map((row) => row.source).slice(0, 10),
    },
    stats: {
      blocks: rows.length,
      paired: dataRows.filter((row) => row.translationLine).length,
      origOnly: dataRows.filter((row) => !row.translationLine).length,
      transOnly: rows.filter((row) => row.kind === 'translation-only').length,
    },
    issues: realIssues,
    parseConfig: {
      open: marks.open, close: marks.close || '', regex: '',
      commentPrefixes,
      nameIdPatterns: namePatterns,
    },
    editable: {
      nameField: nameSource === 'segment',
      note: nameSource === 'segment'
        ? '名字位于前缀段，编辑器名字栏可用。'
        : nameSource === 'bracket'
          ? '名字位于正文前部 [[ ]] 内，规范化后可进入编辑器名字栏。'
          : '没有检测到说话人字段。',
    },
    rows,
  };
}

/* ---------------- 规范化(→ 编辑器原生 ☆/★) ---------------- */

function canonicalLine(marker, row, translation = false) {
  if (row.kind !== 'row') return row.source || '';
  // 名字行(NAME|n / N 后缀): 正文即名字,保持 标记+编号+标记+正文 结构(含【】原样)
  if (row.nameEntry){
    const content = translation ? row.translation : row.source;
    return `${marker}${row.id}${marker}${content}`;
  }
  const id = row.id;
  const name = translation ? row.translationName : row.name;
  const content = translation ? row.translation : row.source;
  const effectiveName = name || '';
  return effectiveName || row.explicitNameSegment
    ? `${marker}${id}${marker}${effectiveName}${marker}${content}`
    : `${marker}${id}${marker}${content}`;
}

// 规范化整个文件成 ☆/★ 两行格式(保留前导空行与末尾换行/空行)
export function canonicalize(profile) {
  const out = [];
  for (const row of profile.rows || []) {
    if (row.kind !== 'row') {
      if (row.source) out.push(row.source);
      out.push('');
      continue;
    }
    // 控制行(如 #NOTTRANS)留在原文行之前(同一段) —— 编辑器解析时会自动剥离附着,
    // 不会再把注释行当原文行;还原时也按原分组贴回
    if (row.controls?.length) out.push(...row.controls);
    out.push(canonicalLine('☆', row, false));
    if (row.translationLine) out.push(canonicalLine('★', row, true));
    out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const nl = profile.nl || '\n';
  const trailing = profile.trailing !== undefined ? profile.trailing : (profile.trailingBlank ? 1 : 0);
  let text = out.join(nl) + nl.repeat(trailing);
  // 保留前导空行(如文件开头有空行),保证 --restore 无损
  const lead = (profile.leadingBlank || 0);
  if (lead > 0) text = nl.repeat(lead) + text;
  return text;
}

/* ---------------- 还原(规范 ☆/★ → 原格式) ---------------- */

function parseCanonicalRows(text) {
  const { lines } = splitText(text);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const source = parseMarkedLine(lines[i], '☆');
    if (!source) continue;
    const translation = parseMarkedLine(lines[i + 1] || '', '★');
    rows.push({ source, translation: translation || null, lineIndex: i });
    if (translation) i += 1;
  }
  return rows;
}

function replaceContent(originalLine, content, marker, name = null, bracketSpeaker = false, explicitNameSegment = false, bracketStyle = '[[]]') {
  const parsed = parseMarkedLine(originalLine, marker);
  if (!parsed) return originalLine;
  const prefix = originalLine.slice(0, originalLine.length - originalLine.trimStart().length);
  const useName = name !== null ? name : parsed.name;
  // 说话人包裹样式: [[名]] 前有空格;【名】紧贴正文
  const restoredContent = bracketSpeaker && useName
    ? (bracketStyle === '【】' ? `【${useName}】` : ` [[${useName}]] `) + content
    : content;
  return (parsed.name !== '' || explicitNameSegment) && !bracketSpeaker
    ? `${prefix}${marker}${parsed.id}${marker}${useName}${marker}${restoredContent}`
    : `${prefix}${marker}${parsed.id}${marker}${restoredContent}`;
}

// 用识别档案(profile)把规范化文本还原回原格式
export function restore(profile, canonicalText) {
  const canonicalRows = parseCanonicalRows(canonicalText);
  const out = [];
  let rowIndex = 0;
  for (const row of profile.rows || []) {
    if (row.kind !== 'row') {
      if (row.source) out.push(row.source);
      continue;
    }
    const current = canonicalRows[rowIndex] || canonicalRows.find((candidate) => candidate.source.id === row.id) || null;
    if (row.controls?.length) out.push(...row.controls);
    // 「」外的标签等在规范化时被剥离,还原时贴回(已含则不重复)
    const attachExtra = (content, extra) => (extra && !content.endsWith(extra)) ? content + extra : content;
    // 名字行/普通行统一走 replaceContent: 只替换正文,原行结构(标记/编号/说话人/★编号)完整保留
    const source = current
      ? replaceContent(row.original.source, attachExtra(current.source.content, row.sourceExtra), row.marker || profile.marks.open, row.name || '', !!row.bracketSpeaker, !!row.explicitNameSegment, row.bracketStyle || '[[]]')
      : row.original.source;
    out.push(source);
    if (row.translationLine) {
      const trans = current?.translation;
      out.push(trans
        ? replaceContent(row.original.translation, attachExtra(trans.content, row.translationExtra), row.translationMarker || profile.marks.close, row.translationName || '', !!row.bracketSpeaker, !!row.explicitNameSegment, row.bracketStyle || '[[]]')
        : row.original.translation);
    }
    out.push('');
    rowIndex += 1;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const nl = profile.nl || '\n';
  const trailing = profile.trailing !== undefined ? profile.trailing : (profile.trailingBlank ? 1 : 0);
  let text = out.join(nl) + nl.repeat(trailing);
  const lead = profile.leadingBlank || 0;
  if (lead > 0) text = nl.repeat(lead) + text;
  return text;
}

/* ---------------- 报告渲染(CLI 与 GUI 共用) ---------------- */

export function renderReport(profile) {
  const s = profile.stats;
  const st = profile.structure;
  const issueLines = profile.issues.length ? profile.issues.slice(0, 12).map((x) => `  - ${x.type}: ${x.detail}`).join('\n') : '  - 无';
  const names = Object.keys(st.nameValues || {});
  const off = profile.idOffset;
  const offsetLine = off && off.systematic ? `  - 编号偏移: 译文 = 原文 +${off.offset}（${off.matched}/${off.total} 对一致,已自动放行,不视为问题）` : '';
  const ruleLine = [
    `  - 注释前缀: ${(profile.commentPrefixes || []).join('、') || '（无）'}`,
    `  - 名字行编号: ${(profile.nameIdPatterns || []).join('、') || '（内置默认）'}`,
  ];
  return [
    `[格式识别] ${profile.file || '<stdin>'}`,
    `标记: 原文 ${profile.marks.open || '(无)'} / 译文 ${profile.marks.close || '(无)'}  置信度 ${profile.marks.confidence}`,
    `结构: 编号 ${st.idShape}  说话人来源 ${st.nameSource}  编辑器名字栏 ${profile.editable.nameField ? '可用' : '不可用'}`,
    `统计: 段落 ${s.blocks}  成对 ${s.paired}  原文独有 ${s.origOnly}  译文独有 ${s.transOnly}`,
    `分类: 对话 ${st.lineKinds.dialogue}  旁白/正文 ${st.lineKinds.narration}  有名文本 ${st.lineKinds.namedText}  名字行 ${st.lineKinds.nameEntry}  控制行 ${st.lineKinds.control}  间隔 ${st.lineKinds.separator}`,
    `人名${names.length ? ` (${names.length})` : ''}: ${names.slice(0, 20).join('、') || '未检测到'}`,
    `可复用规则:`,
    ...ruleLine,
    ...(offsetLine ? [offsetLine] : []),
    `问题 (${profile.issues.length}):\n${issueLines}`,
  ].join('\n');
}

/* ---------------- 编辑器模拟(接收 parsers 模块,浏览器/Node 通用) ---------------- */

// 用真实解析器(传入 src/parsers.js 模块)模拟编辑器导入一段文本,返回统计。
// 编辑器导出会丢前导空行并补末尾换行,这两类差异不算还原失败。
export function analyzeWithParsers(parsers, text, config, label) {
  parsers.setParseConf(config || { open: '☆', close: '★', regex: '' });
  const { paras, nl, trailingBlank } = parsers.parseFile(text);
  const withId = paras.filter(p => p.id).length;
  const nameRows = paras.filter(p => p.isName).length;
  const named = paras.filter(p => !p.isName && p.name).length;
  const done = paras.filter(p => p.done).length;
  let roundTrip;
  try {
    const exported = parsers.buildExport(paras, nl, trailingBlank);
    const norm = s => s.replace(/^\r?\n/, '').replace(new RegExp(nl + '$'), '');
    roundTrip = norm(exported) === norm(text);
  } catch (e) {
    roundTrip = 'ERR:' + e.message;
  }
  return {
    label,
    paras: paras.length, withId, noId: paras.length - withId,
    nameRows, named, done, roundTrip,
  };
}
