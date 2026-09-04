// universal-parser.js — 无损物理行扫描 + Galgame 文本语义模块
// 只新增结构视图，不改变 parsers.js / recognize.js 的既有契约。

import {
  detectIdShape,
  detectMarks,
  hasDialogueQuote,
  isNameRowId,
  parseBracketSpeaker,
  parseMarkedLine,
} from './recognize.js';

export const DOCUMENT_VERSION = 1;

const TOKEN_RE = /(<r>|\[(?:n|r|np)\]|%(?:p(?:-?\d+)?|f[^;\r\n]*);|\\{1,2}n|\[[^\]\r\n,]+,\d+\])/giu;

function tokenRole(value){
  if (value === '<r>' || /^\[(?:n|r)\]$/iu.test(value) || /^\\{1,2}n$/u.test(value)) return 'line-break';
  if (/^\[np\]$/iu.test(value)) return 'wait';
  if (/^%p/iu.test(value)) return 'position';
  if (/^%f/iu.test(value)) return 'font';
  return 'command';
}

/** 将可翻译文字与必须原样保护的引擎控制符拆开；所有 token 拼接后恒等于输入。 */
export function tokenizeInline(text){
  const source = typeof text === 'string' ? text : '';
  const tokens = [];
  let cursor = 0;
  TOKEN_RE.lastIndex = 0;
  for (const match of source.matchAll(TOKEN_RE)){
    const start = match.index;
    if (start > cursor){
      tokens.push({ type: 'text', role: 'text', value: source.slice(cursor, start), start: cursor, end: start, protected: false });
    }
    const value = match[0];
    tokens.push({ type: 'control', role: tokenRole(value), value, start, end: start + value.length, protected: true });
    cursor = start + value.length;
  }
  if (cursor < source.length || !tokens.length){
    tokens.push({ type: 'text', role: 'text', value: source.slice(cursor), start: cursor, end: source.length, protected: false });
  }
  return tokens;
}

/** 用稳定、逐个唯一的占位符遮蔽引擎 token，避免机翻改写控制指令。 */
export function maskProtectedTokens(text){
  const source = typeof text === 'string' ? text : '';
  const controls = tokenizeInline(source).filter(token => token.protected);
  let namespace = 'GWCTRL';
  while (source.includes(`⟦${namespace}:`)) namespace += '_';
  const tokens = [];
  let cursor = 0;
  let masked = '';
  for (let i = 0; i < controls.length; i++){
    const token = controls[i];
    const placeholder = `⟦${namespace}:${i}⟧`;
    masked += source.slice(cursor, token.start) + placeholder;
    tokens.push({
      placeholder,
      value: token.value,
      role: token.role,
      sourceStart: token.start,
      sourceEnd: token.end,
    });
    cursor = token.end;
  }
  masked += source.slice(cursor);
  return { version: 1, namespace, source, text: masked, tokens };
}

function occurrenceCount(text, value){
  if (!value) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(value, cursor)) >= 0){
    count++;
    cursor += value.length;
  }
  return count;
}

/**
 * 恢复机翻结果中的受保护 token。任何缺失、重复、重排或未知占位符都会失败，
 * 调用方不得在失败时写入译文。
 */
export function restoreProtectedTokens(translatedText, mask){
  const text = typeof translatedText === 'string' ? translatedText : '';
  if (!mask || !Array.isArray(mask.tokens) || typeof mask.namespace !== 'string'){
    return { ok: false, text: null, errors: [{ code: 'invalid-mask', placeholder: '' }] };
  }
  const errors = [];
  const expected = new Set(mask.tokens.map(token => token.placeholder));
  const placeholderRe = new RegExp(`⟦${mask.namespace}:\\d+⟧`, 'gu');
  for (const value of text.match(placeholderRe) || []){
    if (!expected.has(value) && !errors.some(error => error.code === 'unknown' && error.placeholder === value)){
      errors.push({ code: 'unknown', placeholder: value });
    }
  }

  const positions = [];
  for (const token of mask.tokens){
    const count = occurrenceCount(text, token.placeholder);
    if (count === 0) errors.push({ code: 'missing', placeholder: token.placeholder });
    else if (count > 1) errors.push({ code: 'duplicate', placeholder: token.placeholder });
    positions.push(text.indexOf(token.placeholder));
  }
  const present = positions.filter(position => position >= 0);
  if (present.some((position, index) => index > 0 && position < present[index - 1])){
    errors.push({ code: 'reordered', placeholder: '' });
  }
  if (errors.length) return { ok: false, text: null, errors };

  let restored = text;
  for (const token of mask.tokens){
    restored = restored.replace(token.placeholder, token.value);
  }
  return { ok: true, text: restored, errors: [] };
}

/** 分割物理行并保留每一行自己的 EOL，支持 LF / CRLF / CR 混用。 */
export function splitPhysicalLines(text){
  const source = typeof text === 'string' ? text : '';
  const lines = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = re.exec(source))){
    if (!match[0]) break;
    lines.push({ number: lines.length + 1, content: match[1], eol: match[2], raw: match[0] });
    if (!match[2]) break;
  }
  return lines;
}

function commentPrefixes(profile){
  const configured = profile?.commentPrefixes;
  return Array.isArray(configured) ? configured : ['#', ';', '//', '%'];
}

function isControlLine(content, prefixes){
  const trimmed = content.trimStart();
  return prefixes.some(prefix => trimmed.startsWith(prefix));
}

function leadingMarker(content){
  const trimmed = content.trimStart();
  const marker = [...trimmed][0] || '';
  if (!marker || /[\p{L}\p{N}_\s]/u.test(marker)) return '';
  return trimmed.indexOf(marker, marker.length) > 0 ? marker : '';
}

function inferAdjacentMarks(contents){
  const nonBlank = contents.filter(content => content.trim());
  const pairs = new Map();
  for (let i = 0; i < nonBlank.length - 1; i++){
    const source = leadingMarker(nonBlank[i]);
    const target = leadingMarker(nonBlank[i + 1]);
    if (!source || !target || source === target) continue;
    const key = source + '\0' + target;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const best = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const [open, close] = best[0].split('\0');
  return { open, close, pairs: best[1], confidence: 0.75 };
}

function parseSide(line, marker){
  const parsed = parseMarkedLine(line.content, marker);
  if (!parsed) return null;
  const leading = line.content.length - line.content.trimStart().length;
  const trimmed = line.content.slice(leading);
  const idEnd = trimmed.indexOf(marker, marker.length);
  const tailStart = leading + idEnd + marker.length;
  const tail = line.content.slice(tailStart);
  const speakerEndInTail = tail.indexOf(marker);
  let explicitSpeaker = '';
  let text = tail;
  let textStart = tailStart;
  let speakerSpan = null;
  const diagnostics = [];
  if (speakerEndInTail >= 0){
    const candidateSpeaker = tail.slice(0, speakerEndInTail);
    const candidateText = tail.slice(speakerEndInTail + marker.length);
    const clearSpeaker = candidateSpeaker === '' ||
      /^(?:标题|標題|title)$/iu.test(candidateSpeaker) ||
      hasDialogueQuote(candidateText);
    if (clearSpeaker){
      explicitSpeaker = candidateSpeaker;
      text = candidateText;
      speakerSpan = { start: tailStart, end: tailStart + speakerEndInTail };
      textStart = tailStart + speakerEndInTail + marker.length;
    }
    if (!clearSpeaker){
      diagnostics.push('ambiguous-marker-in-payload');
    }
  }
  const bracket = explicitSpeaker || isNameRowId(parsed.id) ? null : parseBracketSpeaker(text);
  let bracketSpeaker = bracket?.name || '';
  let bracketStyle = bracket?.bracketStyle || '';
  if (bracketSpeaker){
    const match = text.match(/^(\s*)(\[\[([^\]]*)\]\]|【([^】]*)】)(\s*)/u);
    const openSize = match[2].startsWith('[[') ? 2 : 1;
    const innerStart = textStart + match[1].length + openSize;
    speakerSpan = { start: innerStart, end: innerStart + bracketSpeaker.length };
    textStart += match[0].length;
    text = line.content.slice(textStart);
  }
  return {
    id: parsed.id,
    text,
    explicitSpeaker,
    bracketSpeaker,
    bracketStyle,
    layout: speakerEndInTail >= 0 && speakerSpan && !bracketSpeaker ? 'segment-speaker' : bracketSpeaker ? 'bracket-speaker' : 'plain',
    tokens: tokenizeInline(text),
    diagnostics,
    spans: { text: { start: textStart, end: line.content.length }, speaker: speakerSpan },
    raw: line.content,
    line: line.number,
  };
}

function looksLikeInferredSpeaker(record, next){
  if (!record || !next || record.source.explicitSpeaker || record.source.bracketSpeaker) return false;
  if (record.source.text.length < 1 || record.source.text.length > 24) return false;
  if (/[。！？!?「」『』]/u.test(record.source.text)) return false;
  return hasDialogueQuote(next.source.text) && !next.source.explicitSpeaker && !next.source.bracketSpeaker;
}

function baseKind(record, next){
  const id = record.id || '';
  if (/R$/iu.test(id)) return 'directive';
  if (isNameRowId(id)) return 'speaker';
  if (/^(?:标题|標題|title)$/iu.test(record.source.explicitSpeaker)) return 'title';
  if (hasDialogueQuote(record.source.text)) return 'dialogue';
  if (looksLikeInferredSpeaker(record, next)) return 'speaker';
  if (record.source.explicitSpeaker || record.source.bracketSpeaker) return 'named-text';
  return 'narration';
}

function classifyRecords(records){
  let activeSpeaker = null;
  const speakerText = value => {
    const match = String(value || '').match(/^【([\s\S]*)】$/u);
    return match ? match[1] : String(value || '');
  };
  for (let i = 0; i < records.length; i++){
    const record = records[i];
    record.kind = baseKind(record, records[i + 1]);
    record.confidence = 0.94;
    record.diagnostics = [
      ...(record.source.diagnostics || []),
      ...(record.translation?.diagnostics || []),
    ];
    if (record.diagnostics.includes('ambiguous-marker-in-payload')) record.confidence = 0.72;

    if (record.kind === 'speaker'){
      const inferred = !isNameRowId(record.id);
      record.speaker = {
        source: speakerText(record.source.text),
        translation: speakerText(record.translation?.text || record.source.text),
        mode: inferred ? 'inferred' : 'state',
      };
      if (inferred){
        record.confidence = 0.68;
        record.diagnostics.push('inferred-speaker');
      }
      activeSpeaker = record.speaker;
    } else {
      const sourceSpeaker = record.source.explicitSpeaker || record.source.bracketSpeaker;
      const translationSpeaker = record.translation?.explicitSpeaker || record.translation?.bracketSpeaker || sourceSpeaker;
      if (sourceSpeaker){
        record.speaker = {
          source: sourceSpeaker,
          translation: translationSpeaker,
          mode: record.source.bracketSpeaker ? 'bracket' : 'segment',
        };
      } else if (record.kind === 'dialogue' && activeSpeaker){
        record.speaker = { ...activeSpeaker, mode: 'inherited' };
        record.confidence = Math.min(record.confidence, 0.88);
      } else {
        record.speaker = { source: '', translation: '', mode: 'none' };
      }
    }
    if (record.translation && record.translation.text === record.source.text){
      record.confidence = Math.min(record.confidence, 0.72);
      record.diagnostics.push('unchanged-translation');
    }
    if (record.kind === 'directive') record.confidence = /APPEND/iu.test(record.source.text) ? 1 : 0.9;
    if (record.kind === 'title') record.confidence = 1;
  }
  return records;
}

function grammarCandidates(records){
  const total = Math.max(1, records.length);
  const counts = id => records.filter(record => record.source.layout === id).length;
  return [
    { id: 'segment-speaker', score: counts('segment-speaker') / total },
    { id: 'bracket-speaker', score: counts('bracket-speaker') / total },
    { id: 'plain-marked', score: counts('plain') / total },
    { id: 'stateful-ntr', score: records.filter(record => /[NTR]$/iu.test(record.id)).length / total },
  ].filter(item => item.score > 0).sort((a, b) => b.score - a.score);
}

function inferIdOffset(records){
  const paired = records.filter(record => record.translation);
  const useHex = paired.some(record => /[A-F]/iu.test(record.source.id) || /[A-F]/iu.test(record.translation.id));
  const base = useHex ? 16 : 10;
  const diffs = new Map();
  let total = 0;
  for (const record of paired){
    const source = String(record.source.id || '').match(/^([0-9A-F]+)([NRT]*)$/iu);
    const target = String(record.translation.id || '').match(/^([0-9A-F]+)([NRT]*)$/iu);
    if (!source || !target || source[2].toUpperCase() !== target[2].toUpperCase()) continue;
    const diff = parseInt(target[1], base) - parseInt(source[1], base);
    diffs.set(diff, (diffs.get(diff) || 0) + 1);
    total++;
  }
  const best = [...diffs.entries()].sort((a, b) => b[1] - a[1])[0] || [0, 0];
  return {
    offset: best[0],
    matched: best[1],
    total,
    systematic: best[0] !== 0 && best[1] / Math.max(1, total) >= 0.8,
  };
}

/**
 * 通用只读解析入口。records 是语义视图，lines 是无损物理结构；未知内容始终留在 lines 中。
 */
export function parseDocument(text, options = {}){
  const source = typeof text === 'string' ? text : '';
  const lines = splitPhysicalLines(source);
  const contents = lines.map(line => line.content);
  let detected = options.profile?.marks || detectMarks(contents);
  if (!detected.close){
    const adjacent = inferAdjacentMarks(contents);
    if (adjacent) detected = adjacent;
  }
  const sourceMark = detected.open || '☆';
  const targetMark = detected.close || '';
  const prefixes = commentPrefixes(options.profile);
  const records = [];
  const pendingControls = [];
  const issues = [];
  let openRecord = null;
  const occurrences = new Map();

  for (const line of lines){
    if (!line.content.trim()) continue;
    if (isControlLine(line.content, prefixes) && !parseMarkedLine(line.content, sourceMark)){
      pendingControls.push(line.content);
      continue;
    }
    const sourceSide = parseSide(line, sourceMark);
    if (sourceSide){
      const occurrence = (occurrences.get(sourceSide.id) || 0) + 1;
      occurrences.set(sourceSide.id, occurrence);
      openRecord = {
        key: `${sourceSide.id || 'line-' + line.number}#${occurrence}`,
        id: sourceSide.id,
        source: sourceSide,
        translation: null,
        controls: pendingControls.splice(0),
        lineSpan: { start: line.number, end: line.number },
      };
      records.push(openRecord);
      continue;
    }
    const targetSide = targetMark ? parseSide(line, targetMark) : null;
    if (targetSide){
      if (openRecord && !openRecord.translation){
        openRecord.translation = targetSide;
        openRecord.lineSpan.end = line.number;
      } else {
        issues.push({ type: 'translation-only', line: line.number, detail: line.content });
      }
      continue;
    }
    issues.push({ type: 'unmarked-line', line: line.number, detail: line.content });
  }
  if (pendingControls.length) issues.push({ type: 'orphan-control', line: lines.length, detail: pendingControls.join('\n') });

  classifyRecords(records);
  const candidates = grammarCandidates(records);
  const inferredOffset = inferIdOffset(records);
  const knownOffset = options.profile?.idOffset;
  const offsetInfo = knownOffset?.systematic ? knownOffset : inferredOffset;
  const idShape = options.profile?.structure?.idShape || detectIdShape(records.map(record => record.id));
  const kinds = {};
  for (const record of records) kinds[record.kind] = (kinds[record.kind] || 0) + 1;
  const tokenRoles = [...new Set(records.flatMap(record => [
    ...record.source.tokens,
    ...(record.translation?.tokens || []),
  ]).filter(token => token.protected).map(token => token.role))];

  return {
    version: DOCUMENT_VERSION,
    file: options.file || options.profile?.file || '',
    raw: source,
    lines,
    records,
    issues,
    format: {
      version: 1,
      framing: { sourceMark, targetMark, boundary: 'next-marked-line', preserveBlankLines: true },
      commentPrefixes: prefixes.slice(),
      id: { shape: idShape },
      pairing: {
        strategy: offsetInfo.systematic ? 'position-with-systematic-offset' : 'adjacent-source-target',
        offset: offsetInfo.offset || 0,
        matched: offsetInfo.matched || 0,
        total: offsetInfo.total || 0,
        systematic: !!offsetInfo.systematic,
      },
      grammar: { selected: candidates[0]?.id || 'unknown', candidates },
      protectedTokenRoles: tokenRoles,
    },
    stats: {
      records: records.length,
      paired: records.filter(record => record.translation).length,
      sourceOnly: records.filter(record => !record.translation).length,
      kinds,
      lowConfidence: records.filter(record => record.confidence < 0.8).length,
    },
  };
}

/** 未编辑 document 的严格无损序列化；后续编辑器只允许替换记录 payload span。 */
export function serializeDocument(document){
  if (!document || !Array.isArray(document.lines)) return '';
  return document.lines.map(line => line.raw).join('');
}

function protectedValues(text){
  return tokenizeInline(text).filter(token => token.protected).map(token => token.value);
}

function sameValues(left, right){
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 只替换已解析记录的正文/说话人 span，其余物理字符保持原样。
 * edits: { [recordKey]: { sourceText?, translationText?, sourceSpeaker?, translationSpeaker? } }
 */
export function renderDocument(document, edits = {}){
  if (!document || !Array.isArray(document.lines) || !Array.isArray(document.records)){
    return { ok: false, text: null, errors: [{ code: 'invalid-document', recordKey: '', side: '' }] };
  }
  const records = new Map(document.records.map(record => [record.key, record]));
  const replacements = [];
  const errors = [];

  const addTextEdit = (record, sideName, value) => {
    if (value === undefined) return;
    const side = record[sideName];
    if (!side){
      errors.push({ code: 'missing-side', recordKey: record.key, side: sideName });
      return;
    }
    if (typeof value !== 'string'){
      errors.push({ code: 'invalid-edit', recordKey: record.key, side: sideName });
      return;
    }
    if (!sameValues(protectedValues(side.text), protectedValues(value))){
      errors.push({ code: 'protected-token-mismatch', recordKey: record.key, side: sideName });
      return;
    }
    replacements.push({ line: side.line, start: side.spans.text.start, end: side.spans.text.end, value });
  };

  const addSpeakerEdit = (record, sideName, value) => {
    if (value === undefined) return;
    const side = record[sideName];
    if (!side || !side.spans.speaker){
      errors.push({ code: 'speaker-not-editable', recordKey: record.key, side: sideName });
      return;
    }
    if (typeof value !== 'string'){
      errors.push({ code: 'invalid-edit', recordKey: record.key, side: sideName });
      return;
    }
    replacements.push({ line: side.line, start: side.spans.speaker.start, end: side.spans.speaker.end, value });
  };

  for (const [key, edit] of Object.entries(edits || {})){
    const record = records.get(key);
    if (!record){
      errors.push({ code: 'unknown-record', recordKey: key, side: '' });
      continue;
    }
    if (!edit || typeof edit !== 'object'){
      errors.push({ code: 'invalid-edit', recordKey: key, side: '' });
      continue;
    }
    addTextEdit(record, 'source', edit.sourceText);
    addTextEdit(record, 'translation', edit.translationText);
    addSpeakerEdit(record, 'source', edit.sourceSpeaker);
    addSpeakerEdit(record, 'translation', edit.translationSpeaker);
  }
  if (errors.length) return { ok: false, text: null, errors };

  const contents = document.lines.map(line => line.content);
  const byLine = new Map();
  for (const replacement of replacements){
    const list = byLine.get(replacement.line) || [];
    list.push(replacement);
    byLine.set(replacement.line, list);
  }
  for (const [lineNumber, list] of byLine){
    let content = contents[lineNumber - 1];
    list.sort((a, b) => b.start - a.start);
    for (const replacement of list){
      content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
    }
    contents[lineNumber - 1] = content;
  }
  const text = document.lines.map((line, index) => contents[index] + line.eol).join('');
  return { ok: true, text, errors: [] };
}

function canonicalSide(marker, side){
  const speaker = side.explicitSpeaker || side.bracketSpeaker;
  const hasSpeakerSlot = side.layout === 'segment-speaker' || side.layout === 'bracket-speaker';
  return `${marker}${side.id}${marker}${hasSpeakerSlot ? speaker + marker : ''}${side.text}`;
}

/** 将无损 document 转为编辑器使用的 ☆/★ 文本，并保留 occurrence key 对应关系。 */
export function canonicalizeDocument(document){
  if (!document || !Array.isArray(document.records) || !Array.isArray(document.lines)){
    return { ok: false, text: null, errors: [{ code: 'invalid-document', line: 0 }], map: [] };
  }
  const unsupported = (document.issues || []).filter(issue =>
    ['unmarked-line', 'translation-only', 'orphan-control'].includes(issue.type)
  );
  if (unsupported.length){
    return {
      ok: false,
      text: null,
      errors: unsupported.map(issue => ({ code: 'unsupported-line', line: issue.line, detail: issue.detail })),
      map: [],
    };
  }
  const nl = document.lines.find(line => line.eol)?.eol || '\n';
  const out = [];
  const map = [];
  for (const record of document.records){
    if (record.controls?.length) out.push(...record.controls);
    const sourceLine = out.length + 1;
    out.push(canonicalSide('☆', record.source));
    let translationLine = null;
    if (record.translation){
      translationLine = out.length + 1;
      out.push(canonicalSide('★', record.translation));
    }
    map.push({ key: record.key, sourceLine, translationLine });
    out.push('');
  }
  if (out.length) out.pop();
  const hasTrailingEol = document.lines.length > 0 && document.lines[document.lines.length - 1].eol !== '';
  return { ok: true, text: out.join(nl) + (hasTrailingEol ? nl : ''), errors: [], map };
}

function sideSpeaker(side){
  return side ? (side.explicitSpeaker || side.bracketSpeaker || '') : '';
}

/** 将编辑后的 ☆/★ 文本按 occurrence key 定点写回原 document。 */
export function restoreCanonicalDocument(document, canonicalText){
  if (!document || !Array.isArray(document.records)){
    return { ok: false, text: null, errors: [{ code: 'invalid-document', recordKey: '', side: '' }] };
  }
  const canonical = parseDocument(canonicalText, {
    profile: { marks: { open: '☆', close: '★' }, commentPrefixes: document.format?.commentPrefixes },
    file: document.file,
  });
  const currentByKey = new Map(canonical.records.map(record => [record.key, record]));
  const originalKeys = new Set(document.records.map(record => record.key));
  const errors = [];
  const edits = {};

  for (const current of canonical.records){
    if (!originalKeys.has(current.key)) errors.push({ code: 'unknown-record', recordKey: current.key, side: '' });
  }
  for (const original of document.records){
    const current = currentByKey.get(original.key);
    if (!current){
      errors.push({ code: 'missing-record', recordKey: original.key, side: '' });
      continue;
    }
    if (current.source.id !== original.source.id || current.source.text !== original.source.text ||
        sideSpeaker(current.source) !== sideSpeaker(original.source)){
      errors.push({ code: 'source-modified', recordKey: original.key, side: 'source' });
      continue;
    }
    if (JSON.stringify(current.controls || []) !== JSON.stringify(original.controls || [])){
      errors.push({ code: 'controls-modified', recordKey: original.key, side: '' });
      continue;
    }
    if (!!current.translation !== !!original.translation){
      errors.push({
        code: original.translation ? 'translation-removed' : 'translation-added',
        recordKey: original.key,
        side: 'translation',
      });
      continue;
    }
    if (!original.translation) continue;
    if (current.translation.id !== original.translation.id){
      errors.push({ code: 'translation-id-modified', recordKey: original.key, side: 'translation' });
      continue;
    }
    const edit = { translationText: current.translation.text };
    if (original.translation.spans.speaker){
      edit.translationSpeaker = sideSpeaker(current.translation);
    } else if (sideSpeaker(current.translation)){
      errors.push({ code: 'speaker-added', recordKey: original.key, side: 'translation' });
      continue;
    }
    edits[original.key] = edit;
  }
  if (errors.length) return { ok: false, text: null, errors };
  return renderDocument(document, edits);
}

/** 从 JSON 可序列化的增强 profile 重建无损 document。 */
export function documentFromProfile(profile){
  if (!profile?.lossless || !Array.isArray(profile.lossless.lines) || !Array.isArray(profile.modules?.records)) return null;
  const lines = profile.lossless.lines.map((line, index) => ({
    number: index + 1,
    content: line.content,
    eol: line.eol,
    raw: line.content + line.eol,
  }));
  return {
    version: profile.lossless.version || DOCUMENT_VERSION,
    file: profile.file || '',
    lines,
    records: profile.modules.records,
    issues: profile.lossless.issues || [],
    format: profile.formatProfile,
  };
}

export function canonicalizeProfile(profile){
  const document = documentFromProfile(profile);
  return document ? canonicalizeDocument(document) : {
    ok: false, text: null, errors: [{ code: 'missing-lossless-profile', line: 0 }], map: [],
  };
}

export function restoreProfile(profile, canonicalText){
  const document = documentFromProfile(profile);
  return document ? restoreCanonicalDocument(document, canonicalText) : {
    ok: false, text: null, errors: [{ code: 'missing-lossless-profile', recordKey: '', side: '' }],
  };
}

/** 将新结构以可选字段挂到旧识别档案上，保持 profile v1 与 rows 契约。 */
export function enrichDetectionProfile(text, profile){
  const document = parseDocument(text, { profile, file: profile?.file || '' });
  const detectedMarks = document.format.framing;
  const marks = profile?.marks?.close ? profile.marks : {
    ...(profile?.marks || {}),
    open: detectedMarks.sourceMark,
    close: detectedMarks.targetMark,
    pairs: document.stats.paired,
    confidence: document.stats.paired ? 0.75 : (profile?.marks?.confidence || 0),
  };
  const pairing = document.format.pairing;
  const idOffset = profile?.idOffset?.systematic ? profile.idOffset : {
    offset: pairing.offset,
    matched: pairing.matched,
    total: pairing.total,
    systematic: pairing.systematic,
  };
  return {
    ...profile,
    marks,
    idOffset,
    parseConfig: {
      ...(profile?.parseConfig || {}),
      open: marks.open,
      close: marks.close,
    },
    formatProfile: document.format,
    modules: {
      records: document.records,
      counts: document.stats.kinds,
      lowConfidence: document.stats.lowConfidence,
    },
    lossless: {
      version: document.version,
      lines: document.lines.map(line => ({ content: line.content, eol: line.eol })),
      issues: document.issues,
    },
  };
}
