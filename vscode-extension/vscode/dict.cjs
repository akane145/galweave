// vscode/dict.cjs — MDX 词典查询
//
// 用 js-mdict（已有依赖）在扩展宿主里直接读 .mdx：Node 有真 fs，
// 不需要桌面版浏览器路径里那套 Buffer polyfill + node-shims。
//
// 结果不落在 Webview 里 —— 用**只读虚拟文档**开一个标签页。
// 这是原生能力（TextDocumentContentProvider），没有自绘界面，
// 而且反复查询复用同一个标签，可以一边看释义一边改译文。
//
// 只做 MDX，不做 MDD：MDD 是词条内嵌的图片/音频资源，需要额外一套资源水化，
// 按需求确认暂不支持。

const vscode = require('vscode');
const path = require('node:path');
const fsp = require('node:fs/promises');
const core = require('./core.cjs');

const SCHEME = 'galweave-dict';
// URI 惰性构造：模块顶层就别碰 vscode API —— 否则任何 mock/宿主差异都会让整个扩展 require 失败
let _uri = null;
function docUri() {
  if (!_uri) _uri = vscode.Uri.parse(`${SCHEME}:/词典查询.txt`);
  return _uri;
}

let provider = null;
const dicts = new Map();   // fsPath -> { mdx, name, error, size }
let lastText = '尚未查询。\n\n在原文或译文里选中一个词后执行「Galweave: 查词典」（Ctrl+Alt+D），\n或把光标放在词上直接执行。';
let loading = null;

/* ---------------- 载入词典 ---------------- */

/**
 * 递归收集目录下的 .mdx。
 * 有界（文件数与深度都封顶）—— 万一有人把路径指到 C:\ 也不会把扩展卡死。
 */
async function collectMdxInDir(dir, maxFiles = 100, maxDepth = 4) {
  const out = [];
  const walk = async (d, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.mdx')) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

// 路径问题只报一次 —— 每次查词都刷一遍输出面板就成了噪音
let lastProblems = '';

function reportProblems(problems) {
  const key = problems.join('|');
  if (key === lastProblems) return;
  lastProblems = key;
  if (!problems.length) return;
  for (const p of problems) core.out().appendLine(`[词典] ${p}`);
  // 只有一条问题时把原因直接写进提示 —— 泛泛的"有 N 条问题"对用户没用
  const head = problems.length === 1
    ? problems[0]
    : `${problems[0]} 等 ${problems.length} 条`;
  vscode.window.showWarningMessage(`Galweave: 词典路径 —— ${head}（详见「输出」面板）`);
}

/**
 * 解析要用的 .mdx 路径：设置优先，没设置就在工作区里找（限深度，避免卡住）。
 *
 * 设置项**可以是目录**（会递归扫出里面的 .mdx）也可以是单个 .mdx 文件。
 * 指向文件夹是很自然的用法，之前只当文件处理，结果 `new MDX(目录)` 抛
 * `EISDIR: illegal operation on a directory` —— 用户看到的是一句看不懂的错。
 */
async function resolvePaths() {
  const configured = core.cfg().get('mdxPaths', []);
  const out = [];
  const problems = [];

  for (const raw of configured) {
    const p = path.isAbsolute(raw) ? raw : core.resolvePath(raw);
    let st = null;
    try { st = await fsp.stat(p); } catch (e) {
      problems.push(`${p} —— 路径不存在`);
      continue;
    }
    if (st.isDirectory()) {
      const found = await collectMdxInDir(p);
      if (!found.length) problems.push(`${p} —— 目录里没有找到 .mdx 文件`);
      out.push(...found);
    } else if (st.isFile()) {
      if (!p.toLowerCase().endsWith('.mdx')) problems.push(`${p} —— 不是 .mdx 文件`);
      else out.push(p);
    }
  }

  if (out.length) {
    reportProblems(problems);
    return out;
  }

  // 一条都没配上（或配的都没用）→ 自动在工作区里找
  if (!configured.length) {
    const found = await vscode.workspace.findFiles('**/*.mdx', '**/node_modules/**', 20);
    reportProblems(problems);
    return found.map(u => u.fsPath).sort();
  }
  reportProblems(problems);
  return out;
}

/** 载入（带缓存）。失败按词典记 error，不影响其他词典。 */
async function loadDicts() {
  if (loading) return loading;
  loading = (async () => {
    const paths = await resolvePaths();
    let mod;
    try {
      mod = await import('js-mdict');
    } catch (e) {
      core.out().appendLine(`[词典] js-mdict 载入失败：${e.message}`);
      return { paths, error: `js-mdict 载入失败：${e.message}` };
    }
    for (const p of paths) {
      if (dicts.has(p)) continue;
      try {
        dicts.set(p, { mdx: new mod.MDX(p), name: path.basename(p), error: null });
      } catch (e) {
        dicts.set(p, { mdx: null, name: path.basename(p), error: e.message });
        core.out().appendLine(`[词典] ${p} 打开失败：${e.message}`);
      }
    }
    return { paths, error: null };
  })();
  const r = await loading;
  loading = null;
  return r;
}

/** 设置变了就丢弃已载入的词典（路径可能变了） */
function invalidate() {
  dicts.clear();
}

/* ---------------- 查询 ---------------- */

/**
 * 查一个词，**跟随 @@@LINK 重定向**。
 *
 * MDX 里大量词条只是指向另一条的重定向（「天気」→「てんき【天気】」，
 * 明鏡那种指向内部编号），不跟随的话用户看到的就是一串 `@@@LINK=...`。
 * 桌面版的 Rust 侧有 lookup_follow（mdict.rs:514）做这件事，这里补上等价逻辑。
 *
 * @returns {{keyText:string, definition:string, hops:string[]}|null}
 */
function resolveEntry(mdx, word, maxHops = 5) {
  const { dicttext } = core.state.mods;
  const seen = new Set();
  let key = word;
  const hops = [];

  for (let i = 0; i < maxHops; i++) {
    if (seen.has(key)) return null;        // 成环，放弃
    seen.add(key);

    let r = null;
    try { r = mdx.lookup(key); } catch (e) { return null; }
    if (!r || !r.definition) return null;

    const target = dicttext.followTarget(r.definition);
    if (!target) return { keyText: r.keyText || key, definition: r.definition, hops };
    if (target === key) return null;       // 自指
    hops.push(target);
    key = target;
  }
  return null;                             // 跳太多次
}

/**
 * 查一个词。返回 [{ dict, key, via, text }]；精确命中优先，其次给词头联想。
 * 只查前 `maxHits` 条，避免一部大辞典刷出几百条把标签页淹了。
 */
function lookupWord(word, maxHits = 8) {
  const { dicttext } = core.state.mods || {};
  const hits = [];
  const suggestions = [];

  for (const [, d] of dicts) {
    if (!d.mdx) continue;
    const r = resolveEntry(d.mdx, word);
    if (r && r.definition) {
      // 跟随过重定向时标注原词，方便对照"我查的词"和"实际读的词条"
      const via = r.hops.length && r.keyText !== word ? `（原词「${word}」）` : '';
      hits.push({ dict: d.name, key: r.keyText, via, text: dicttext.htmlToText(r.definition) });
      if (hits.length >= maxHits) break;
      continue;
    }
    // 没精确命中就收词头联想（去重）
    try {
      const list = d.mdx.prefix(word) || [];
      for (const item of list) {
        const k = item.keyText || item.key;
        if (k && k !== word && !suggestions.includes(k)) suggestions.push(k);
        if (suggestions.length >= 20) break;
      }
    } catch (e) { /* 联想失败不影响精确命中 */ }
  }
  return { hits, suggestions };
}

/** 按候选顺序查，命中即止（候选由调用方按"长的在前"排好） */
function queryCandidates(candidates) {
  const tried = [];
  for (const cand of candidates) {
    const q = String(cand || '').trim();
    if (!q || tried.includes(q)) continue;
    tried.push(q);
    const { hits, suggestions } = lookupWord(q);
    if (hits.length) return { query: q, hits, suggestions, tried };
  }
  return { query: tried[0] || '', hits: [], suggestions: [], tried };
}

/**
 * 决定查什么词：
 * - 有非空选区 → 查选中文本（原样先试，再试它内部的日语连续串）
 * - 否则 → 在光标所在行取日语连续串，逐级缩短生成候选
 */
function buildQuery(editor) {
  const doc = editor.document;
  const sel = editor.selection;
  const selText = doc.getText(sel).trim();

  if (selText && !selText.includes('\n')) {
    const { dicttext } = core.state.mods;
    const extra = dicttext.candidatesAt(selText, 0).filter(c => c !== selText);
    return { candidates: [selText, ...extra], source: `选中文本`, display: selText };
  }

  const line = sel.active.line;
  const lineText = doc.lineAt(line).text;
  const { dicttext } = core.state.mods;
  const cands = dicttext.candidatesAt(lineText, sel.active.character);
  return {
    candidates: cands,
    source: `光标所在行（第 ${line + 1} 行）`,
    display: cands[0] || lineText.trim(),
  };
}

/** 把查询结果排成纯文本报告 */
function render(result, source) {
  const lines = [];
  lines.push(`查询：${result.query}`);
  lines.push(`来源：${source}`);
  lines.push(`词典：${[...dicts.values()].map(d => d.error ? `${d.name}（打不开：${d.error}）` : d.name).join('　') || '（未载入）'}`);
  lines.push('');
  if (!result.hits.length) {
    lines.push('没有精确命中。');
    if (result.suggestions.length) {
      lines.push('');
      lines.push('词头联想：');
      for (const s of result.suggestions.slice(0, 20)) lines.push(`  ${s}`);
    }
    return lines.join('\n');
  }
  for (const h of result.hits) {
    lines.push(`${'─'.repeat(60)}`);
    lines.push(`【${h.dict}】${h.key}${h.via || ''}`);
    lines.push(`${'─'.repeat(60)}`);
    lines.push(h.text);
    lines.push('');
  }
  if (result.suggestions.length) {
    lines.push(`${'─'.repeat(60)}`);
    lines.push('相关词头：');
    for (const s of result.suggestions.slice(0, 20)) lines.push(`  ${s}`);
  }
  return lines.join('\n');
}

/* ---------------- 虚拟文档 ---------------- */

function ensureProvider() {
  if (provider) return provider;
  provider = {
    onDidChange: null,
    provideTextDocumentContent: () => lastText,
  };
  const emitter = new vscode.EventEmitter();
  provider.onDidChange = emitter.event;
  const disposable = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  provider.emitter = emitter;
  provider.disposable = disposable;
  return provider;
}

async function showReport(text) {
  lastText = text;
  ensureProvider();
  provider.emitter.fire(docUri());
  const doc = await vscode.workspace.openTextDocument(docUri());
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
}

/* ---------------- 命令 ---------------- */

async function cmdLookupDict() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return; }

  const loaded = await loadDicts();
  if (loaded.error) {
    vscode.window.showErrorMessage(`Galweave: ${loaded.error}。词典查询需要 js-mdict。`);
    return;
  }
  if (!loaded.paths.length) {
    vscode.window.showWarningMessage(
      'Galweave: 没找到 .mdx 词典。用设置 galweave.mdxPaths 指定词典文件路径（可用多个）。',
    );
    return;
  }

  const { candidates, source, display } = buildQuery(editor);
  if (!candidates.length) {
    vscode.window.setStatusBarMessage('Galweave: 光标处没有可查的日语词（可先选中要查的词）', 2500);
    return;
  }
  const result = queryCandidates(candidates);
  await showReport(render(result, source));
  if (!result.hits.length) {
    vscode.window.setStatusBarMessage(`Galweave: 「${display}」没有精确命中`, 2500);
  }
}

function disposeAll() {
  provider?.emitter?.dispose?.();
  provider?.disposable?.dispose?.();
  provider = null;
  dicts.clear();
}

module.exports = { cmdLookupDict, loadDicts, invalidate, disposeAll, render, lookupWord, _dicts: dicts };
