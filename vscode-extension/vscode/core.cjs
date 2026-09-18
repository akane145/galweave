// vscode/core.cjs — 共享状态与解析缓存
//
// 这里是所有 vscode 层模块的唯一状态源：纯逻辑模块（ESM）的载入、规则库、
// 每个文档的解析结果缓存、术语表、输出面板。
//
// 两个缓存的失效策略不同，别混：
//   ruleCache  —— 按"标记指纹"失效。重选规则要对每条规则各解析一遍，贵，
//                 而文件的标记体系在编辑过程中不会变，所以指纹不变就复用。
//   parseCache —— 按 document.version 失效。解析本身便宜（一次同步遍历），
//                 version 每次编辑都会变，语义精确。

const vscode = require('vscode');

const state = {
  extensionUri: null,
  context: null,
  output: null,
  mods: null,        // 动态载入的 ESM 模块
  ruleLib: [],
  forcedRule: null,
  ruleCache: new Map(),   // uri → { fp, picked }
  parseCache: new Map(),  // uri → { version, result }
  glossCache: new Map(),  // dir → { gloss, path, missing }
};

/** 输出面板（懒创建） */
function out() {
  if (!state.output) state.output = vscode.window.createOutputChannel('Galweave');
  return state.output;
}

function cfg() {
  return vscode.workspace.getConfiguration('galweave');
}

/** 动态载入纯逻辑 ESM 模块（只载一次）。入口是 CJS，见 extension.cjs 顶部说明。 */
async function loadCore() {
  if (!state.mods) {
    // 刻意**不**载入 ../../src/glossary.js —— 它 import 了 fs.js，而 fs.js 会碰 window，
    // 在扩展宿主（Node）里调用即抛错。术语表读写由 src/glossary-file.js 自己做。
    const [lineparse, rules, validate, glossaryFile, exportText, nav, dicttext, encoding, parserMod, exporter, qa] = await Promise.all([
      import('../src/lineparse.js'),
      import('../src/rules.js'),
      import('../src/validate.js'),
      import('../src/glossary-file.js'),
      import('../src/export-text.js'),
      import('../src/nav.js'),
      import('../src/dicttext.js'),
      import('../src/encoding.js'),
      import('../../src/parsers.js'),
      import('../../src/exporter.js'),
      import('../../src/qa.js'),
    ]);
    state.mods = { lineparse, rules, validate, glossaryFile, exportText, nav, dicttext, encoding, parsers: parserMod, exporter, qa };
  }
  return state.mods;
}

/** 把相对路径解析成绝对路径（相对工作区根，无工作区时相对扩展目录）。 */
function resolvePath(rel) {
  if (!rel) return '';
  if (/^([A-Za-z]:[\\/]|\/)/.test(rel)) return rel;
  const ws = vscode.workspace.workspaceFolders?.[0];
  const base = ws ? ws.uri.fsPath : (state.extensionUri ? state.extensionUri.fsPath : '');
  return base ? `${base}/${rel}` : rel;
}

/** 读一个规则文件并归一化；失败返回 null（并提示）。 */
async function readRuleFile(uri, fallbackId) {
  const { rules } = await loadCore();
  let raw;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (e) {
    vscode.window.showWarningMessage(`Galweave: 规则文件读不到 —— ${uri.fsPath}`);
    return null;
  }
  let rule;
  try {
    rule = rules.normalizeRule(JSON.parse(raw), fallbackId);
  } catch (e) {
    vscode.window.showWarningMessage(`Galweave: 规则文件不是合法 JSON（${fallbackId}）—— ${e.message}`);
    return null;
  }
  const invalid = rules.validateRule(rule);
  if (invalid) {
    vscode.window.showWarningMessage(`Galweave: 规则「${rule.label}」无效 —— ${invalid}`);
    return null;
  }
  return rule;
}

/** 重载规则库与强制规则（激活时、配置变化时调用）。 */
async function reloadRules() {
  const { rules, validate } = await loadCore();
  const lib = rules.BUILTIN_RULES.slice();

  // ① 扩展自带 rules/*.json —— 随扩展分发，开箱即可识别常见引擎格式
  if (state.extensionUri) {
    const dir = vscode.Uri.joinPath(state.extensionUri, 'rules');
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
        const rule = await readRuleFile(vscode.Uri.joinPath(dir, name), name.replace(/\.json$/, ''));
        if (rule) lib.push(rule);
      }
    } catch (e) { /* 没有 rules 目录是正常的 */ }
  }

  // ② 用户追加的规则文件
  for (const rel of cfg().get('rules', [])) {
    const rule = await readRuleFile(
      vscode.Uri.file(resolvePath(rel)),
      String(rel).replace(/^.*[\\/]|\.json$/g, ''),
    );
    if (rule) lib.push(rule);
  }

  // ③ 强制规则（非空时跳过自动选择）
  const force = cfg().get('rulesFile', '');
  state.forcedRule = force
    ? await readRuleFile(vscode.Uri.file(resolvePath(force)), String(force).replace(/^.*[\\/]|\.json$/g, ''))
    : null;

  state.ruleLib = lib.filter(r => !rules.validateRule(r));
  state.ruleCache.clear();
  state.parseCache.clear();
}

/**
 * 决定一个文档用哪条规则。指纹没变就复用上次的选择。
 * 未命中时不缓存 —— 否则新建的空文件会永远停在"未识别"。
 */
async function resolveRule(doc) {
  if (state.forcedRule) return { rule: state.forcedRule, forced: true };
  const { rules } = await loadCore();
  const text = doc.getText();
  const key = doc.uri.toString();
  const fp = rules.fingerprint(text, state.ruleLib);
  const hit = state.ruleCache.get(key);
  if (hit && hit.fp === fp) return hit.picked;

  const picked = rules.pickRule(text, state.ruleLib);
  if (picked) state.ruleCache.set(key, { fp, picked });
  return picked;
}

/**
 * 镜像格式(dc4ph)不是"规则"，但下游（检查 / 导出 / 状态栏）统一从 result.rule 读 label 与 conf。
 * conf 借标准规则那一份：镜像分支根本不看标记字符，只是别让下游拿到 undefined。
 */
function mirrorRule(rules) {
  const base = rules.BUILTIN_RULES.find(r => r.id === 'default-star') || rules.BUILTIN_RULES[0];
  return {
    id: 'mirror-dc4ph',
    label: '镜像格式（dc4ph：// 原文行 + 普通译文行）',
    conf: base ? base.conf : undefined,
  };
}

/**
 * 规则是否真的解释了这份文档 —— 至少有一行的正文被"吃掉"了前缀。
 * 必须查：对话/旁白按"正文是否含「」"判定，与前缀匹不匹配无关，
 * 所以一条完全不匹配的规则照样能产出一堆"段落"。
 */
function ruleExplains(parsed) {
  return parsed.paras.some(p => p.orig.length > p.content.length);
}

/**
 * 取文档的解析结果（带缓存）。
 * @returns {Promise<{parsed:object, rule:object, forced:boolean}|null>}
 */
async function getParsed(doc) {
  if (!doc) return null;
  const key = doc.uri.toString();
  const hit = state.parseCache.get(key);
  if (hit && hit.version === doc.version) return hit.result;

  const { lineparse, rules } = await loadCore();
  let result = null;

  try {
    const text = doc.getText();
    // 镜像格式(dc4ph)结构自证，先分流：文件里没有 ☆/★ 标记，规则库里的规则一条都解释不了它，
    // 交给规则库只会白跑一遍"没命中"的慢路径（文档每次变化都要重选一次）。
    const isMirror = lineparse.isMirrorDoc(text);
    const picked = isMirror ? null : await resolveRule(doc);
    // 没命中规则又不是镜像格式 → 不解析。否则打开任意大文件都会白白多跑一遍全文解析。
    if (isMirror || picked) {
      const parsed = lineparse.parseLines(text, { conf: picked?.rule?.conf });
      if (parsed.isMirror) {
        if (parsed.summary.total) result = { parsed, rule: mirrorRule(rules), forced: false };
      } else if (picked && parsed.summary.total && ruleExplains(parsed)) {
        result = { parsed, rule: picked.rule, forced: picked.forced };
      }
    }
  } catch (e) {
    out().appendLine(`[解析失败] ${doc.uri.fsPath}: ${e.message}`);
  }

  state.parseCache.set(key, { version: doc.version, result });
  return result;
}

/** 清掉某个文档（或全部）的缓存。文档关闭、配置变化时调用。 */
function invalidate(doc) {
  if (doc) {
    const key = doc.uri.toString();
    state.parseCache.delete(key);
    state.ruleCache.delete(key);
    return;
  }
  state.parseCache.clear();
  state.ruleCache.clear();
  state.glossCache.clear();
}

/* ---------------- 术语表 ---------------- */

/**
 * 取文档所在目录的术语表（带缓存）。
 * 桌面版把术语表存在"项目目录"= 当前文件所在目录，这里沿用同一约定，
 * 这样 VS Code 里改的术语表和 Galweave 里用的是同一份文件。
 */
async function getGlossary(doc) {
  const { glossaryFile } = await loadCore();
  const dir = doc?.uri ? require('node:path').dirname(doc.uri.fsPath) : '';
  if (!dir) return { gloss: glossaryFile.emptyGlossary(), path: '', missing: true };

  const hit = state.glossCache.get(dir);
  if (hit) return hit;

  const p = glossaryFile.glossaryPathFor(dir);
  let entry;
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(p))).toString('utf8');
    const { gloss, error } = glossaryFile.parseGlossaryText(raw);
    if (error) out().appendLine(`[术语表] ${p} 解析失败：${error}`);
    entry = { gloss, path: p, missing: false, error };
  } catch (e) {
    entry = { gloss: glossaryFile.emptyGlossary(), path: p, missing: true };
  }
  state.glossCache.set(dir, entry);
  return entry;
}

/** 写回术语表文件。 */
async function saveGlossary(doc, gloss) {
  const { glossaryFile } = await loadCore();
  const dir = doc?.uri ? require('node:path').dirname(doc.uri.fsPath) : '';
  if (!dir) return false;
  const p = glossaryFile.glossaryPathFor(dir);
  const text = JSON.stringify(glossaryFile.normalizeGlossary(gloss), null, 2) + '\n';
  await vscode.workspace.fs.writeFile(vscode.Uri.file(p), Buffer.from(text, 'utf8'));
  state.glossCache.set(dir, { gloss: glossaryFile.normalizeGlossary(gloss), path: p, missing: false });
  return true;
}

/* ---------------- 基线（原文快照，用于"原文是否被改动"的检测） ---------------- */

function baselineKey(doc) {
  const ws = vscode.workspace.getWorkspaceFolder?.(doc.uri);
  const rel = ws ? require('node:path').relative(ws.uri.fsPath, doc.uri.fsPath) : doc.uri.fsPath;
  return `baseline:${String(rel).replace(/\\/g, '/')}`;
}

function getBaseline(doc) {
  return state.context?.workspaceState?.get(baselineKey(doc), null) || null;
}

async function saveBaseline(doc, lines) {
  await state.context?.workspaceState?.update(baselineKey(doc), lines);
}

async function clearBaseline(doc) {
  await state.context?.workspaceState?.update(baselineKey(doc), undefined);
}

function init(context) {
  state.context = context;
  state.extensionUri = context.extensionUri || null;
}

module.exports = {
  init, out, cfg, loadCore, resolvePath,
  reloadRules, resolveRule, getParsed, invalidate, ruleExplains,
  getGlossary, saveGlossary,
  getBaseline, saveBaseline, clearBaseline,
  get ruleLib() { return state.ruleLib; },
  get forcedRule() { return state.forcedRule; },
  state,
};
