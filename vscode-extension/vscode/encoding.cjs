// vscode/encoding.cjs — 文件的真实编码：检测、解码、写回编码，以及那一次必要的提醒
//
// 为什么需要这一层：VS Code 的 TextDocument 是按 `files.encoding` 解出来的字符串，
// 扩展**改不了**它（没有编码 API，microsoft/vscode#8242 至今开着）。所以这里做三件事：
//   1. 从磁盘上的**原始字节**判断真实编码（`src/encoding.js`，纯逻辑 + 注入解码器）；
//   2. 文件其实不是 UTF-8 时，提示一次，并把两条可执行的路摆出来（改工作区默认编码 / 打开 VS Code 的编码选择器）；
//   3. 导出时按源文件编码**写回字节** —— 这一半完全在我们手里，也是"引擎读不读得懂"的关键。
//
// 提醒只发一次，而且要"真的需要"才发：
//   · 按检测结果，这个文件不是 UTF-8；且
//   · 当前文档解出来的文本**不像正常日语**（成片 U+FFFD / 半角片假名汤）—— 也就是确实在乱码。
// 用户已经把 files.encoding 调对时，第 2 条不成立，就不会打扰他（状态栏仍会标出编码）。

const fs = require('node:fs');
const vscode = require('vscode');
const core = require('./core.cjs');

/** 探测时最多读这么多字节：256KB 足够判定编码，且不会把大文件整个读进内存 */
const SNIFF_BYTES = 256 * 1024;
/** workspaceState 里记"这个文件别再提醒我" */
const IGNORE_KEY = 'galweave.encoding.ignored';
/** 解码结果"像日语"的门槛：低于它才认为当前显示是乱码 */
const TEXT_OK_SCORE = 0.85;

const detectCache = new Map();   // fsPath → { mtimeMs, size, info }
const encodeTables = new Map();  // encoding → Map<char, number[]>
const sessionWarned = new Set(); // 本次会话已提醒过的文件

function invalidate(fsPath) {
  if (fsPath) detectCache.delete(fsPath);
  else detectCache.clear();
}

/* ---------------- 字节 → 编码 ---------------- */

function sniffBytes(fsPath) {
  const st = fs.statSync(fsPath);
  const len = Math.min(st.size, SNIFF_BYTES);
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(fsPath, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/** 宿主有没有这个解码器（Electron 全量 ICU，正常都有；没有也不能装作能写回） */
function makeDecoder(label, fatal) {
  try {
    const d = new TextDecoder(label, fatal ? { fatal: true } : undefined);
    if (!fatal) d.decode(new Uint8Array(0)); // 触发一次，编解码器缺失这里就会抛
    return d;
  } catch (e) {
    return null;
  }
}

/** 一次"单序列解码"用于建反向表：认不出来的序列交给 fatal 抛错，调用方跳过 */
function sequenceDecoder(label) {
  const d = makeDecoder(label, true);
  if (!d) return null;
  return (bytes) => d.decode(bytes);
}

/**
 * 某个文件的编码信息（按 mtime + size 缓存；保存后文件变了自然失效）。
 * @returns {{path:string, encoding:string, label:string, vscodeId:string|null,
 *            confidence:string, evidence:string[], attention:boolean, usable:boolean}|null}
 */
async function infoForPath(fsPath) {
  if (!fsPath) return null;
  let st;
  try { st = fs.statSync(fsPath); } catch (e) { return null; }
  if (!st.isFile()) return null;

  const hit = detectCache.get(fsPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;

  const { encoding } = await core.loadCore();
  const bytes = sniffBytes(fsPath);
  const info = encoding.detectEncoding(bytes, {
    decode: (label, buf) => {
      const d = makeDecoder(label, false);
      return d ? d.decode(buf) : '';
    },
  });

  const canDecode = !!makeDecoder(encoding.DECODER_LABEL[info.encoding] || 'utf-8', false);
  const usable = canDecode && encoding.vsCodeEncodingId(info.encoding) !== null
    && info.encoding !== encoding.ENC.UTF8_BOM; // BOM 只影响读，不影响写回
  const full = {
    path: fsPath,
    encoding: info.encoding,
    label: encoding.encodingLabel(info.encoding),
    vscodeId: encoding.vsCodeEncodingId(info.encoding),
    confidence: info.confidence,
    evidence: info.evidence || [],
    // 需要提醒：确实不是 UTF-8、判得不算含糊、且宿主能处理
    attention: encoding.needsUtf8Attention(info.encoding) && info.confidence !== 'low' && canDecode,
    // 能被我们写回原编码（导出用）
    usable: usable && encoding.needsUtf8Attention(info.encoding) && info.confidence !== 'low',
  };
  detectCache.set(fsPath, { mtimeMs: st.mtimeMs, size: st.size, info: full });
  return full;
}

/** 文档的编码信息；非 file: 文档 / 文件不在磁盘上 → null */
async function infoForDocument(doc) {
  if (!doc || doc.uri?.scheme !== 'file') return null;
  return infoForPath(doc.uri.fsPath);
}

/* ---------------- 编码 → 字节（导出写回） ---------------- */

/** 反向表（字符 → 字节）；建表约 20-40ms，按编码缓存一次 */
async function tableFor(enc) {
  const cached = encodeTables.get(enc);
  if (cached) return cached;
  const { encoding } = await core.loadCore();
  const label = encoding.DECODER_LABEL[enc];
  const decode = sequenceDecoder(label);
  if (!decode) return null;
  const table = encoding.buildReverseTable(enc, decode);
  encodeTables.set(enc, table);
  return table;
}

/**
 * 把文本编成要写盘的字节。
 * @returns {Promise<{bytes:Buffer, encoding:string, missing:string[]}|null>} null = 这个编码不支持写回
 */
async function encodeForWrite(text, enc) {
  const { encoding } = await core.loadCore();
  const s = String(text == null ? '' : text);
  switch (enc) {
    case encoding.ENC.UTF8:
      return { bytes: Buffer.from(s, 'utf8'), encoding: enc, missing: [] };
    case encoding.ENC.UTF8_BOM:
      return { bytes: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(s, 'utf8')]), encoding: enc, missing: [] };
    case encoding.ENC.UTF16LE:
      return { bytes: Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(s, 'utf16le')]), encoding: enc, missing: [] };
    case encoding.ENC.UTF16BE: {
      const le = Buffer.from(s, 'utf16le');
      const be = Buffer.allocUnsafe(le.length);
      for (let i = 0; i + 1 < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
      return { bytes: Buffer.concat([Buffer.from([0xFE, 0xFF]), be]), encoding: enc, missing: [] };
    }
    case encoding.ENC.SJIS:
    case encoding.ENC.EUCJP: {
      const table = await tableFor(enc);
      if (!table) return null;
      const { bytes, missing } = encoding.encodeWithTable(s, table);
      return { bytes: Buffer.from(bytes), encoding: enc, missing };
    }
    default:
      return null;
  }
}

/* ---------------- 与用户的那一次交互 ---------------- */

function ignoredList() {
  return core.state.context?.workspaceState?.get(IGNORE_KEY, []) || [];
}

async function ignorePath(fsPath) {
  const list = ignoredList();
  if (!list.includes(fsPath)) {
    await core.state.context?.workspaceState?.update(IGNORE_KEY, list.concat([fsPath]));
  }
}

/**
 * 把工作区（没有工作区时退回全局）的 `files.encoding` 设为检测到的编码。
 * 这是 VS Code 自己的设置项，取值来自它的编码注册表 —— 见 src/encoding.js 的 vsCodeEncodingId。
 */
async function setDefaultEncoding(vscodeId) {
  if (!vscodeId) return false;
  const folders = vscode.workspace.workspaceFolders;
  const hasFolder = !!(folders && folders.length);
  const target = hasFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  try {
    await vscode.workspace.getConfiguration('files').update('encoding', vscodeId, target);
    vscode.window.showInformationMessage(
      hasFolder
        ? `Galweave: 已把本工作区的 files.encoding 设为 ${vscodeId}。新打开的文件会用它解码（已打开的标签页若仍是乱码，执行「Galweave: 按检测到的编码打开」或 VS Code 的「重新打开并选择编码」）。`
        : `Galweave: 已把全局 files.encoding 设为 ${vscodeId}（当前没有打开工作区）。`,
    );
    return true;
  } catch (e) {
    vscode.window.showWarningMessage(`Galweave: 写入 files.encoding 失败 —— ${e.message}`);
    return false;
  }
}

/** 打开 VS Code 自己的编码选择器（命令 id 取自 VS Code 状态栏的编码项） */
async function openEncodingPicker() {
  try {
    await vscode.commands.executeCommand('workbench.action.editor.changeEncoding');
  } catch (e) {
    /* 命令不存在时忽略：提示里已经写明了手工路径 */
  }
}

/** 当前显示是否已经正常（用于决定要不要打扰用户） */
async function looksFine(doc) {
  const { encoding } = await core.loadCore();
  const text = doc.getText();
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  return encoding.scoreJapanese(sample) >= TEXT_OK_SCORE;
}

/**
 * 打开/刷新一个文档时的编码检查。返回 info（供状态栏显示）。
 * 只有"确实不是 UTF-8"且"当前显示像乱码"时才弹一次提示。
 */
async function checkDocument(doc) {
  const info = await infoForDocument(doc);
  if (!info) return null;
  if (!info.attention) return info;
  if (sessionWarned.has(info.path) || ignoredList().includes(info.path)) return info;

  if (await looksFine(doc)) return info; // 用户已经把编码调对了
  sessionWarned.add(info.path);

  const setLabel = info.vscodeId ? '设为工作区默认编码' : '';
  const buttons = [setLabel, '打开编码选择器', '忽略此文件'].filter(Boolean);
  const choice = await vscode.window.showWarningMessage(
    `Galweave: 这个文件的真实编码是 ${info.label}，但 VS Code 现在按 UTF-8 显示（所以是乱码）。`
    + '识别结果与着色都会因此失效。',
    ...buttons,
  );
  if (choice === '设为工作区默认编码') await setDefaultEncoding(info.vscodeId);
  else if (choice === '打开编码选择器') await openEncodingPicker();
  else if (choice === '忽略此文件') await ignorePath(info.path);
  return info;
}

/** 「检查文件编码」命令用：把判定依据摊开给人看 */
async function report(doc) {
  const info = await infoForDocument(doc);
  const ch = core.out();
  ch.clear();
  if (!info) {
    ch.appendLine('Galweave: 拿不到这个文件的编码信息（不是本地文件，或文件不在磁盘上）。');
    ch.show(true);
    return null;
  }
  const { encoding } = await core.loadCore();
  ch.appendLine(`文件：${info.path}`);
  ch.appendLine(`编码：${info.label}（${info.encoding}）`);
  ch.appendLine(`置信度：${info.confidence}${info.attention ? '' : '（无需处理）'}`);
  if (info.vscodeId) ch.appendLine(`VS Code 设置值：files.encoding = ${info.vscodeId}`);
  else ch.appendLine('VS Code 的编码注册表里没有这一项（ISO-2022-JP），只能用「重新打开并选择编码」。');
  ch.appendLine('');
  ch.appendLine('判定依据：');
  for (const e of info.evidence) ch.appendLine(`  · ${e}`);
  ch.appendLine('');
  ch.appendLine(`当前显示：${await looksFine(doc) ? '正常' : '像是乱码（建议改用上面的编码重新打开）'}`);
  ch.appendLine(`导出写回：${info.usable ? '会按这个编码写盘' : '不支持写回这个编码，导出会用 UTF-8'}`);
  ch.show(true);
  return info;
}

module.exports = {
  infoForPath, infoForDocument, checkDocument, report, encodeForWrite,
  setDefaultEncoding, openEncodingPicker, invalidate,
  _looksFine: looksFine, _sniffBytes: sniffBytes, _clearSession: () => sessionWarned.clear(),
};
