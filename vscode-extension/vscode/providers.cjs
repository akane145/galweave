// vscode/providers.cjs — 原生呈现：hover / 折叠 / 大纲 / 诊断
//
// 全部从 core.getParsed 取解析结果（带缓存），不各自解析一遍。

const vscode = require('vscode');
const path = require('node:path');
const core = require('./core.cjs');

const KIND_LABEL = { name: '人名', dialogue: '对话', narration: '旁白' };
const SYMBOL_KIND = {
  name: vscode.SymbolKind.Constant,
  dialogue: vscode.SymbolKind.String,
  narration: vscode.SymbolKind.Variable,
};

const preview = (s, n = 46) => {
  const x = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n) + '…' : x;
};

/** 段落落在第 line 行时，它覆盖的行范围（供 hover / 折叠共用） */
function paraAtLine(parsed, line) {
  const ln = parsed.lines[line];
  if (!ln || ln.paraIndex === null || ln.paraIndex === undefined) return null;
  return parsed.paras[ln.paraIndex] || null;
}

/** 段落覆盖的行区间 [start, end]（0 基，含两端） */
function paraSpan(para) {
  const lines = [para.lineIndices.orig];
  if (para.lineIndices.trans !== null && para.lineIndices.trans !== undefined) lines.push(para.lineIndices.trans);
  if (para.lineIndices.extra?.length) lines.push(para.lineIndices.extra[para.lineIndices.extra.length - 1]);
  return [Math.min(...lines), Math.max(...lines)];
}

/* ---------------- hover：原文⇄译文对照 ---------------- */

async function provideHover(doc, position) {
  const result = await core.getParsed(doc);
  if (!result) return null;
  const para = paraAtLine(result.parsed, position.line);
  if (!para) return null;

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  const who = para.name ? ` · ${para.name}${para.nameTr && para.nameTr !== para.name ? `（${para.nameTr}）` : ''}` : '';
  md.appendMarkdown(`**${KIND_LABEL[para.kind] || para.kind}**${who}${para.id ? `　\`${para.id}\`` : ''}\n\n`);
  md.appendMarkdown(`原文：${para.content || '（空）'}\n\n`);

  if (para.isName) {
    md.appendMarkdown(`译名：${para.nameTr || '（未填）'}\n\n`);
  } else if (para.mirror && !para.done) {
    // 镜像格式未翻译时译文行预填原文：直接显示会让人以为"已经有译文了"
    md.appendMarkdown('译文：$(circle-slash) 未翻译（这一行按镜像格式预填了原文）\n\n');
  } else if (String(para.translation || '').trim()) {
    md.appendMarkdown(`译文：${para.translation}\n\n`);
  } else {
    md.appendMarkdown(`译文：$(circle-slash) 未翻译\n\n`);
  }

  // 术语命中：直接列出对应译词，省得再开词典
  const { gloss } = await core.getGlossary(doc);
  const terms = gloss?.terms || {};
  if (Object.keys(terms).length) {
    const { parsers } = await core.loadCore();
    const hits = parsers.scanTerms(para.content || '', terms);
    if (hits.length) {
      md.appendMarkdown(`---\n\n**术语**\n\n`);
      const seen = new Set();
      for (const h of hits) {
        if (seen.has(h.src)) continue;
        seen.add(h.src);
        md.appendMarkdown(`- ${h.src} → ${h.dst}\n`);
      }
    }
  }

  const line = doc.lineAt(position.line);
  return new vscode.Hover(md, line.range);
}

/* ---------------- 折叠：每段一个区域，折起来只剩原文行 ---------------- */

async function provideFoldingRanges(doc) {
  const result = await core.getParsed(doc);
  if (!result) return [];
  const out = [];
  for (const para of result.parsed.paras) {
    const [start, end] = paraSpan(para);
    if (end > start) out.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
  }
  return out;
}

/* ---------------- 大纲：按段落列出说话人与内容 ---------------- */

async function provideDocumentSymbols(doc) {
  const result = await core.getParsed(doc);
  if (!result) return [];
  const out = [];
  for (const para of result.parsed.paras) {
    const [start, end] = paraSpan(para);
    const label = para.name
      ? `${para.name}：${preview(para.content, 40)}`
      : `${preview(para.content, 44)}`;
    const full = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    // selectionRange 必须在 range 内 —— 大纲点击后光标落在这里
    const sel = new vscode.Range(para.lineIndices.orig, 0, para.lineIndices.orig, doc.lineAt(para.lineIndices.orig).text.length);
    const sym = new vscode.DocumentSymbol(
      label,
      para.done ? '' : '未翻译',
      SYMBOL_KIND[para.kind] || vscode.SymbolKind.String,
      full,
      sel,
    );
    out.push(sym);
  }
  return out;
}

/* ---------------- 诊断 ---------------- */

const SEVERITY_MAP = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

let collection = null;
const timers = new Map();

function ensureCollection() {
  if (!collection) collection = vscode.languages.createDiagnosticCollection('galweave');
  return collection;
}

/** 段落索引 → 该段原文行的诊断范围 */
function rangeForPara(doc, para) {
  const line = para.lineIndices.orig;
  const end = paraSpan(para)[1];
  const lastLine = doc.lineAt(end);
  return new vscode.Range(line, 0, end, lastLine.text.length);
}

/**
 * 计算一个文档的全部诊断。
 * 三个来源：结构校验、原文基线比对、术语/一致性检查（复用桌面版 src/qa.js 的四类规则）。
 */
async function computeDiagnostics(doc) {
  const result = await core.getParsed(doc);
  if (!result) return [];

  const { validate, qa } = await core.loadCore();
  const out = [];

  // ① 结构校验
  const structural = validate.validateStructure(result.parsed, {
    reportUntranslated: core.cfg().get('diagnostics.untranslated', false),
  });
  for (const f of structural) {
    const line = doc.lineAt(Math.min(f.line, doc.lineCount - 1));
    out.push({
      range: new vscode.Range(line.range.start, line.range.end),
      severity: SEVERITY_MAP[f.severity] ?? vscode.DiagnosticSeverity.Warning,
      code: f.code,
      message: f.message,
    });
  }

  // ② 原文基线比对（只在与基线不一致时才有输出）
  const baseline = core.getBaseline(doc);
  if (Array.isArray(baseline) && baseline.length) {
    for (const f of validate.diffBaseline(result.parsed, baseline)) {
      const line = doc.lineAt(Math.min(Math.max(f.line, 0), doc.lineCount - 1));
      out.push({
        range: new vscode.Range(line.range.start, line.range.end),
        severity: SEVERITY_MAP[f.severity] ?? vscode.DiagnosticSeverity.Warning,
        code: f.code,
        message: f.message,
      });
    }
  }

  // ③ 术语 / 一致性（qa.js 四类：术语未应用、译名冲突、占位符丢失、标点异常）
  if (core.cfg().get('diagnostics.consistency', true)) {
    const { gloss } = await core.getGlossary(doc);
    let report;
    try {
      report = qa.analyzeQA(result.parsed.paras, gloss);
    } catch (e) {
      core.out().appendLine(`[一致性检查失败] ${doc.uri.fsPath}: ${e.message}`);
      report = null;
    }
    if (report) {
      const paraOf = (i) => result.parsed.paras[i];
      const add = (items, severity, code, message) => {
        for (const item of items) {
          const para = paraOf(item.i);
          if (!para) continue;
          out.push({ range: rangeForPara(doc, para), severity, code, message: message(item) });
        }
      };
      add(report.term, vscode.DiagnosticSeverity.Warning, 'qa-term',
        (x) => `术语未按约定译出：「${x.term}」应为「${x.expect}」（当前译文：${x.transPreview || '空'}）`);
      add(report['name-conflict'], vscode.DiagnosticSeverity.Warning, 'qa-name',
        (x) => `译名不统一：「${x.name}」在本篇出现多种译法 —— ${x.values.join(' / ')}`);
      add(report.token, vscode.DiagnosticSeverity.Warning, 'qa-token',
        (x) => `译文里缺少原文的${x.tokenType === 'number' ? '数字' : '占位符'}「${x.value}」`);
      add(report.punct, vscode.DiagnosticSeverity.Information, 'qa-punct',
        (x) => x.unbalanced
          ? `「」引号不配对（当前译文：${x.transPreview}）`
          : `半角标点「${x.ch}」紧贴中日文字符，建议改成「${x.suggest}」（当前译文：${x.transPreview}）`);
    }
  }

  return out;
}

/** 立即重算并发布某文档的诊断。 */
async function refresh(doc) {
  if (!doc) return [];
  const col = ensureCollection();
  if (!core.cfg().get('diagnostics.enable', true)) {
    col.delete(doc.uri);
    return [];
  }
  const items = await computeDiagnostics(doc);
  col.set(doc.uri, items.map(d => new vscode.Diagnostic(d.range, d.message, d.severity)));
  return items;
}

/** 防抖版：解析与一致性检查不便宜，不值得每次按键都算。 */
function schedule(doc, delay = 500) {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    refresh(doc).catch(e => core.out().appendLine(`[诊断刷新失败] ${e.message}`));
  }, delay));
}

function clear(doc) {
  const key = doc?.uri?.toString();
  if (key) clearTimeout(timers.get(key));
  timers.delete(key);
  if (doc) collection?.delete(doc.uri);
}

function disposeAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  collection?.dispose();
  collection = null;
}

module.exports = {
  provideHover, provideFoldingRanges, provideDocumentSymbols,
  refresh, schedule, clear, disposeAll, computeDiagnostics, paraAtLine, paraSpan,
  _basename: (p) => path.basename(p),
};
