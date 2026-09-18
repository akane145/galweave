// vscode/commands.cjs — 命令与 CodeAction
//
// 所有写入操作**只碰译文行**，原文行从不参与改写。"原文永不修改"这条不变量
// 靠三处保证：这里不提供改原文的命令；导出走 parsers.buildExport（原文行原样 push）；
// 误改由基线比对报进问题面板。VS Code 没有行级只读 API（microsoft/vscode#88885），
// 拦不住用户手改原文，所以只能"不提供工具 + 可检测 + 可回退"。

const vscode = require('vscode');
const path = require('node:path');
const core = require('./core.cjs');
const providers = require('./providers.cjs');
const encoding = require('./encoding.cjs');

const KIND_LABEL = { name: '人名', dialogue: '对话', narration: '旁白' };

/** 取光标所在段落；取不到时给出提示并返回 null */
async function paraAtCursor(what = '这一行') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return null; }
  const result = await core.getParsed(editor.document);
  if (!result) {
    vscode.window.showInformationMessage('Galweave: 当前文件没有识别出段落（用「检查识别结果」看原因）。');
    return null;
  }
  const para = providers.paraAtLine(result.parsed, editor.selection.active.line);
  if (!para) { vscode.window.showInformationMessage(`Galweave: ${what}不在任何段落里。`); return null; }
  return { editor, doc: editor.document, para, result };
}

/** 替换译文行整行内容；返回是否成功 */
async function replaceTransLine(doc, para, newContent) {
  const { parsers } = await core.loadCore();
  const li = para.lineIndices;
  if (li.trans === null || li.trans === undefined) return false;
  const edit = new vscode.WorkspaceEdit();
  const line = doc.lineAt(li.trans);
  // 只替换正文部分，保留前缀（编号/说话人标记原样不动）
  const prefix = line.text.slice(0, para.translationRange.from);
  edit.replace(doc.uri, line.range, prefix + (newContent || ''));
  return vscode.workspace.applyEdit(edit);
}

/**
 * 在原文行后插入一条译文行（用该文件命中的规则构造前缀）。
 *
 * **对"命名捕获组"规则拒绝执行**：`buildStarPrefix` 只会造 ☆/★ 那种"前缀分段"式译文行，
 * 而 `[[名字]]` 这类规则的说话人在正文里、译文行格式完全不同 ——
 * 硬插会造出 `●00001●藍●「あ」` 这种那个引擎根本读不出来的行。
 * 与其写坏文件，不如说清楚让用户手工补。
 */
async function insertTransLine(doc, para) {
  const { parsers, lineparse } = await core.loadCore();
  const parsed = await core.getParsed(doc);
  if (!parsed) return false;

  // 镜像格式(dc4ph)：译文行 = "去掉 // 的那一份原文行"。
  // 用 buildStarPrefix 会写出 ☆/★ 那套前缀（`★001★…`），而这个引擎的译文行没有这些标记 —— 单独走一条。
  if (parsed.parsed.isMirror) {
    const origLine = doc.lineAt(para.lineIndices.orig).text;
    const plain = lineparse.mirrorPlainLineOf(origLine);
    if (!plain) {
      vscode.window.showWarningMessage(
        'Galweave: 这一行不是镜像格式的原文行（缺 // 结构标记），自动补行会写出格式错误的内容。'
        + '请手工复制这一行、去掉 // 后作为译文行。',
      );
      return false;
    }
    const mirrorEol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const mirrorEdit = new vscode.WorkspaceEdit();
    mirrorEdit.insert(doc.uri, new vscode.Position(para.lineIndices.orig, origLine.length), mirrorEol + plain);
    return vscode.workspace.applyEdit(mirrorEdit);
  }

  if (para.rangeSource === 'regex-named') {
    vscode.window.showWarningMessage(
      'Galweave: 这个文件用的是自定义正则规则，译文行的格式不是 ☆/★ 分段式，自动补行会写出引擎读不出来的内容。'
      + '请手动复制原文行，把原文标记改成译文标记后再改正文。',
    );
    return false;
  }

  // buildStarPrefix 读模块级 parseConf.close —— 必须先对齐本文件的规则
  parsers.setParseConf(parsed.rule.conf);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const edit = new vscode.WorkspaceEdit();
  const li = para.lineIndices;
  const at = new vscode.Position(li.orig, doc.lineAt(li.orig).text.length);
  edit.insert(doc.uri, at, eol + parsers.buildStarPrefix(para));
  return vscode.workspace.applyEdit(edit);
}

/* ---------------- 编辑命令 ---------------- */

async function cmdCopyOrigToTrans() {
  const ctx = await paraAtCursor();
  if (!ctx) return;
  const { doc, para } = ctx;
  if (para.isName) { vscode.window.showInformationMessage('Galweave: 人名条目的原名已在名字栏，无需复制。'); return; }
  if (para.lineIndices.trans === null || para.lineIndices.trans === undefined) {
    if (!await insertTransLine(doc, para)) return;
    const fresh = await core.getParsed(doc);
    const again = fresh ? providers.paraAtLine(fresh.parsed, para.lineIndices.orig) : null;
    if (!again) return;
    await replaceTransLine(doc, again, para.content);
    return;
  }
  await replaceTransLine(doc, para, para.content);
}

async function cmdInsertTransLine() {
  const ctx = await paraAtCursor();
  if (!ctx) return;
  const { doc, para } = ctx;
  if (para.lineIndices.trans !== null && para.lineIndices.trans !== undefined) {
    vscode.window.showInformationMessage('Galweave: 这一段已经有译文行了。');
    return;
  }
  await insertTransLine(doc, para);
}

async function cmdClearTrans() {
  const ctx = await paraAtCursor();
  if (!ctx) return;
  const { doc, para } = ctx;
  if (String(para.translation || '').trim() === '') {
    vscode.window.showInformationMessage('Galweave: 这一段本来就没有译文。');
    return;
  }
  await replaceTransLine(doc, para, '');
}

/** 在原文行与译文行之间来回跳 */
async function cmdGotoCounterpart() {
  const ctx = await paraAtCursor();
  if (!ctx) return;
  const { editor, doc, para } = ctx;
  const cur = editor.selection.active.line;
  const li = para.lineIndices;
  const target = (li.trans !== null && li.trans !== undefined && cur === li.orig) ? li.trans : li.orig;
  const line = doc.lineAt(target);
  editor.selection = new vscode.Selection(line.range.start, line.range.start);
  editor.revealRange(line.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/* ---------------- 基线 ---------------- */

async function cmdRecordBaseline() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return; }
  const doc = editor.document;
  const result = await core.getParsed(doc);
  if (!result) { vscode.window.showInformationMessage('Galweave: 当前文件没有识别出段落。'); return; }

  const { validate } = await core.loadCore();
  const lines = validate.baselineFrom(result.parsed);
  await core.saveBaseline(doc, lines);
  providers.schedule(doc, 0);
  vscode.window.showInformationMessage(
    `Galweave: 已记录 ${lines.length} 行原文基线。之后原文若被改动会出现在「问题」面板里。`,
  );
}

async function cmdClearBaseline() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await core.clearBaseline(editor.document);
  providers.schedule(editor.document, 0);
  vscode.window.showInformationMessage('Galweave: 已清除原文基线。');
}

/* ---------------- 逐行导航（复刻 Galweave 的 Enter / Tab 换行） ---------------- */

/**
 * 跳到上/下一段的翻译落点。
 *
 * - 目标段落有译文行 → 光标落在译文行行尾。若译文是「」包裹的，落在收尾括号**之前** ——
 *   这复刻了桌面版的"锁定括号"：你只编辑中间内容，括号不用管。
 * - 目标段落没有译文行 → 默认按本文件规则补一条（`galweave.autoInsertTransLine`），
 *   这样"下一行"永远有可编辑的落点，与桌面版"每行都有输入框"的体验一致。
 */
async function moveLine(dir) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const result = await core.getParsed(doc);
  if (!result) return;

  const { nav } = await core.loadCore();
  const target = nav.navTarget(result.parsed, editor.selection.active.line, dir);
  if (!target) {
    vscode.window.setStatusBarMessage(
      dir > 0 ? 'Galweave: 已经是最后一段' : 'Galweave: 已经是第一段', 2000,
    );
    return;
  }

  let lineNo = target.line;
  let para = target.para;

  if (target.needCreate) {
    if (core.cfg().get('autoInsertTransLine', true)) {
      const created = await insertTransLine(doc, para);
      if (created) {
        // 新行插在该段原文行之后；本段 orig 行号不变
        lineNo = para.lineIndices.orig + 1;
        const fresh = await core.getParsed(doc);
        if (fresh) {
          const t2 = nav.navTarget(fresh.parsed, para.lineIndices.orig - 1, 1);
          if (t2) para = t2.para;
        }
      } else {
        lineNo = para.lineIndices.orig;
      }
    } else {
      lineNo = para.lineIndices.orig;
    }
  }

  const line = doc.lineAt(lineNo);
  // 落点由 src/nav.js 的规则决定：带「」的译文停在收尾括号之前（与桌面版"括号外置"一致）
  const range = nav.transEditRange(para, line.text);
  const col = range ? range.to : line.text.length;
  const pos = new vscode.Position(lineNo, col);
  editor.selection = new vscode.Selection(pos, pos);
  // 默认把目标行滚到**视口正中**：逐行翻译时当前行始终在同一高度，不用来回扫
  const reveal = core.cfg().get('centerOnNavigate', true)
    ? vscode.TextEditorRevealType.InCenter
    : vscode.TextEditorRevealType.InCenterIfOutsideViewport;
  editor.revealRange(line.range, reveal);
}

const cmdNextLine = () => moveLine(1);
const cmdPrevLine = () => moveLine(-1);

/**
 * 原文行的输入拦截。
 *
 * VS Code 没有行级只读 API（microsoft/vscode#88885 至今 Backlog），
 * 也没有 pre-edit veto —— 只能**接管输入命令**：把 type / 粘贴 / 剪切 / 删除
 * 绑到这个空命令上（见 package.json 的 keybindings `when`），键就落不到文档里。
 * 这是 VSCodeVim 一类扩展的通行做法。
 *
 * 覆盖不到的：拖拽文本、其他扩展写入、WorkspaceEdit。所以还有第二层 ——
 * 原文基线比对，改动会出现在问题面板。
 */
function cmdBlockEdit() {
  vscode.window.setStatusBarMessage(
    'Galweave: 原文已锁定 —— 在译文行上编辑，或执行「Galweave: 开关原文锁定」临时解锁', 2500,
  );
}

async function cmdLookupDict() {
  return require('./dict.cjs').cmdLookupDict();
}

async function cmdToggleLock() {
  const locked = require('./cursor.cjs').toggleLock();
  await require('./cursor.cjs').update(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(`Galweave: 原文锁定已${locked ? '开启' : '关闭'}（仅本次会话）。`);
}

/**
 * 首次识别到脚本时自动记一次原文基线。
 * 让"原文被改动"这条检查默认就生效，不必用户先手动执行命令。
 */
async function maybeAutoBaseline(doc, result) {
  if (!result || !core.cfg().get('autoBaseline', true)) return;
  if (core.getBaseline(doc)) return; // 已有基线，不覆盖
  const { validate } = await core.loadCore();
  const lines = validate.baselineFrom(result.parsed);
  if (!lines.length) return;
  await core.saveBaseline(doc, lines);
  core.out().appendLine(`[基线] 已为 ${doc.uri.fsPath} 记录 ${lines.length} 行原文基线`);
}

/* ---------------- 检查 ---------------- */

async function cmdInspect() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return; }
  const doc = editor.document;
  const result = await core.getParsed(doc);
  if (!result) {
    vscode.window.showInformationMessage(
      `Galweave: 没有规则能解释这个文件。可用规则：${core.ruleLib.map(r => r.label).join('、')}。用「查看规则库」看详情。`,
    );
    return;
  }
  const conf = result.rule.conf;
  const s = result.parsed.summary;

  const ch = core.out();
  ch.clear();
  ch.appendLine(`文件：${doc.uri.fsPath}`);
  ch.appendLine(`规则：${result.rule.label}（${result.forced ? '强制指定' : '自动选择'}）  id=${result.rule.id}`);
  ch.appendLine(result.parsed.isMirror
    ? '标记：镜像格式（#0x 地址头 + ★◎ 编号 ◎★// 原文行 + ★◎ 编号 ◎★ 译文行）'
    : `标记：原文=${conf.open || '(空)'}  译文=${conf.close || '(空)'}  自定义正则=${conf.regex ? '有' : '无'}`);
  ch.appendLine(`换行：${result.parsed.nl === '\r\n' ? 'CRLF' : 'LF'}   段尾空行：${result.parsed.trailingBlank ? '有' : '无'}   末尾换行：${result.parsed.endsWithNewline ? '有' : '无'}`);
  ch.appendLine('');
  ch.appendLine(`段落 ${s.total}    人名 ${s.name}    对话 ${s.dialogue}    旁白 ${s.narration}    已翻译 ${s.done}    未翻译 ${s.untranslated}`);
  if (result.parsed.paras[0]) ch.appendLine(`区间来源：${result.parsed.paras[0].rangeSource}`);

  const roleCount = {};
  for (const l of result.parsed.lines) roleCount[l.role] = (roleCount[l.role] || 0) + 1;
  ch.appendLine(`行角色：原文 ${roleCount.orig || 0}  译文 ${roleCount.trans || 0}  注释 ${roleCount.comment || 0}  空行 ${roleCount.blank || 0}  多余 ${roleCount.other || 0}`);

  const speakers = [...new Set(result.parsed.paras.filter(p => p.name).map(p => p.name))];
  if (speakers.length) {
    ch.appendLine('');
    ch.appendLine(`说话人 ${speakers.length} 位：${speakers.join('  ')}`);
  }

  const glossInfo = await core.getGlossary(doc);
  ch.appendLine('');
  ch.appendLine(glossInfo.missing
    ? `术语表：${glossInfo.path}（不存在）`
    : `术语表：${glossInfo.path}（人名 ${Object.keys(glossInfo.gloss.names).length} · 词条 ${Object.keys(glossInfo.gloss.terms).length}）`);

  const diagnoses = await providers.computeDiagnostics(doc);
  ch.appendLine(`诊断：${diagnoses.length} 条`);
  for (const d of diagnoses.slice(0, 100)) ch.appendLine(`  第 ${d.range.start.line + 1} 行  ${d.message}`);

  const miss = result.parsed.paras.filter(p => !p.done);
  if (miss.length) {
    ch.appendLine('');
    ch.appendLine(`未翻译 ${miss.length} 段：`);
    for (const p of miss.slice(0, 100)) {
      ch.appendLine(`  第 ${p.lineIndices.orig + 1} 行  [${KIND_LABEL[p.kind]}]  ${p.content.slice(0, 60)}`);
    }
    if (miss.length > 100) ch.appendLine(`  …（另有 ${miss.length - 100} 段）`);
  }

  ch.show(true);
  vscode.window.showInformationMessage(
    `Galweave：${result.rule.label} · ${s.total} 段（人名 ${s.name} / 对话 ${s.dialogue} / 旁白 ${s.narration}），未翻译 ${s.untranslated}。详见输出面板。`,
  );
}

/** 检查文件编码：把检测依据、能否写回、当前显示是否正常一次说清 */
async function cmdCheckEncoding() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return; }
  const info = await encoding.report(editor.document);
  if (!info) return;
  if (!info.attention) {
    // 三种情况都会走到这里：本来就是 UTF-8 / 判定置信度低 / 本宿主缺少该解码器。
    // 具体是哪一种，输出面板里写了 —— 这里不替它下结论。
    vscode.window.showInformationMessage(`Galweave: 编码 ${info.label} —— 不需要扩展做处理（详情见输出面板）。`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Galweave: 这个文件的真实编码是 ${info.label}。`,
    ...(info.vscodeId ? ['设为工作区默认编码'] : []), '打开编码选择器',
  );
  if (choice === '设为工作区默认编码') await encoding.setDefaultEncoding(info.vscodeId);
  else if (choice === '打开编码选择器') await encoding.openEncodingPicker();
}

async function cmdShowRules() {
  const ch = core.out();
  ch.clear();
  ch.appendLine(`规则库共 ${core.ruleLib.length} 条${core.forcedRule ? '（已设置强制规则）' : '（按文档自动选择）'}：`);
  ch.appendLine('');
  for (const r of core.ruleLib) {
    ch.appendLine(`  ${r.id.padEnd(28)} ${r.label}${core.forcedRule && core.forcedRule.id === r.id ? '   ← 当前强制使用' : ''}`);
  }
  ch.appendLine('');
  ch.appendLine('追加规则文件：设置 galweave.rules（字符串数组）');
  ch.appendLine('强制单条规则：设置 galweave.rulesFile');
  ch.show(true);
}

async function cmdToggleHighlight() {
  const on = require('./decorations.cjs').toggleSession();
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const result = await core.getParsed(editor.document);
    require('./decorations.cjs').apply(editor, result);
  }
  vscode.window.showInformationMessage(`Galweave: 语义着色已${on ? '开启' : '关闭'}（仅本次会话）。`);
}

/* ---------------- 导出 ---------------- */

async function cmdExport() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Galweave: 先打开一个脚本文件。'); return; }
  const doc = editor.document;
  const result = await core.getParsed(doc);
  if (!result) { vscode.window.showInformationMessage('Galweave: 当前文件没有识别出段落。'); return; }

  const { exporter } = await core.loadCore();
  const pick = await vscode.window.showQuickPick(
    exporter.EXPORT_FORMATS.map(f => ({ label: f.label, id: f.id })),
    { title: 'Galweave: 导出译文', placeHolder: '选择导出格式' },
  );
  if (!pick) return;

  // 传完整文件名（含扩展名）：suggestExportName 对 original 是原样返回，
  // 对 bilingual/target/csv 才加后缀。剥掉扩展名会让原格式导出建议出没有后缀的文件名。
  const suggested = exporter.suggestExportName(path.basename(doc.uri.fsPath), pick.id);
  let text;

  if (pick.id === 'original') {
    const { exportText, parsers: p } = await core.loadCore();
    const check = exportText.verifyRoundTrip(result.parsed, doc.getText(), p.buildExport, result.rule.conf);
    if (!check.ok) {
      // 重建结果与原文不一致 —— 与其写出一份损坏的引擎文本，不如拒绝并说清楚
      const reasons = exportText.explainRoundTripFailure(result.parsed);
      const ch = core.out();
      ch.clear();
      ch.appendLine('原格式导出已拒绝：按原文行重建的结果与当前文件不一致。');
      ch.appendLine('');
      ch.appendLine(`第一处差异在第 ${check.line} 行：`);
      ch.appendLine(`  原文：${JSON.stringify(check.expected)}`);
      ch.appendLine(`  重建：${JSON.stringify(check.actual)}`);
      if (reasons.length) {
        ch.appendLine('');
        ch.appendLine('可能的原因：');
        for (const r of reasons) ch.appendLine(`  · ${r}`);
      }
      ch.appendLine('');
      ch.appendLine('可以改用「双语对照 / 纯译文 / CSV」这类单向产物，它们不受影响。');
      ch.show(true);
      vscode.window.showWarningMessage('Galweave: 原格式导出已拒绝 —— 重建会改坏这个文件，详见输出面板。');
      return;
    }
    text = check.rebuilt;
  } else {
    text = exporter.buildExportText(pick.id, result.parsed.paras);
    if (text == null) { vscode.window.showErrorMessage(`Galweave: 不支持的导出格式 ${pick.id}`); return; }
  }

  // 写盘用哪种编码：CSV 固定 UTF-8（它带 BOM，本来就是给 Excel 的），
  // 其余默认**跟源文件同编码** —— 源文件编码就是引擎期望的编码，导出物按同一编码最容易被直接读走。
  // 拿不准（未知编码 / 宿主没有这个编解码器）就退回 UTF-8，绝不按猜测重写。
  const { encoding: encMod } = await core.loadCore();
  const encInfo = await encoding.infoForDocument(doc);
  const wantSource = core.cfg().get('exportEncoding', 'utf8') === 'source'
    && pick.id !== 'csv' && !!(encInfo && encInfo.usable);

  let targetEnc = wantSource ? encInfo.encoding : encMod.ENC.UTF8;
  let payload = await encoding.encodeForWrite(text, targetEnc);
  if (!payload) { // 这个编码不支持写回 → 退回 UTF-8
    targetEnc = encMod.ENC.UTF8;
    payload = await encoding.encodeForWrite(text, targetEnc);
  }

  if (payload.missing.length) {
    // 编不出来的字符：日语脚本翻成简体中文后很常见（简体字大多不在 JIS X 0208 里）。
    // 与其写出一堆问号/乱码，不如明说，并给一条"改用 UTF-8 导出"的路。
    const sample = payload.missing.slice(0, 8).join('、');
    const more = payload.missing.length > 8 ? ` 等 ${payload.missing.length} 个字符` : '';
    const choice = await vscode.window.showWarningMessage(
      `Galweave: 有 ${payload.missing.length} 个字符不在 ${encInfo ? encInfo.label : targetEnc} 里（例如 ${sample}${more}），`
      + '按原编码写出去会变成乱码或问号。',
      '以 UTF-8 导出', '取消',
    );
    if (choice !== '以 UTF-8 导出') {
      core.out().appendLine(`[导出] 已取消：${payload.missing.length} 个字符不在 ${encInfo ? encInfo.label : targetEnc} 里`);
      core.out().appendLine(`  编不出来的字符：${payload.missing.slice(0, 80).join('')}`);
      return;
    }
    targetEnc = encMod.ENC.UTF8;
    payload = await encoding.encodeForWrite(text, targetEnc);
  }

  const dir = path.dirname(doc.uri.fsPath);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, suggested)),
    filters: pick.id === 'csv' ? { 'CSV': ['csv'] } : { '文本文件': ['txt'] },
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, payload.bytes);
  vscode.window.showInformationMessage(
    `Galweave: 已导出 ${path.basename(target.fsPath)}（${encMod.encodingLabel(targetEnc)}）`,
  );
}

/* ---------------- CodeAction ---------------- */

/**
 * 针对光标所在段落给出可执行动作。
 * 只做"确实有用且安全"的几个：补译文行、复制原文到译文、跳到对应行、清空译文。
 */
const ACTIONS = [
  {
    id: 'galweave.insertTransLine',
    title: 'Galweave: 补上译文行',
    when: (p) => p.lineIndices.trans === null || p.lineIndices.trans === undefined,
  },
  {
    id: 'galweave.copyOrigToTrans',
    title: 'Galweave: 复制原文到译文',
    when: (p) => !p.isName,
  },
  {
    id: 'galweave.gotoCounterpart',
    title: 'Galweave: 跳到对应原文/译文行',
    when: (p) => p.lineIndices.trans !== null && p.lineIndices.trans !== undefined,
  },
  {
    id: 'galweave.clearTrans',
    title: 'Galweave: 清空本行译文',
    when: (p) => !p.isName && String(p.translation || '').trim() !== '',
  },
];

async function provideCodeActions(doc, range) {
  const result = await core.getParsed(doc);
  if (!result) return [];
  const para = providers.paraAtLine(result.parsed, range.start.line);
  if (!para) return [];
  return ACTIONS.filter(a => a.when(para)).map(a => {
    const action = new vscode.CodeAction(a.title, vscode.CodeActionKind.QuickFix);
    action.command = { command: a.id, title: a.title };
    return action;
  });
}

module.exports = {
  cmdInspect, cmdShowRules, cmdToggleHighlight, cmdExport, cmdCheckEncoding,
  cmdCopyOrigToTrans, cmdInsertTransLine, cmdClearTrans, cmdGotoCounterpart,
  cmdRecordBaseline, cmdClearBaseline,
  cmdNextLine, cmdPrevLine, cmdBlockEdit, cmdToggleLock, cmdLookupDict,
  maybeAutoBaseline,
  provideCodeActions,
  // 供测试直接驱动
  _replaceTransLine: replaceTransLine,
  _insertTransLine: insertTransLine,
  _moveLine: moveLine,
};
