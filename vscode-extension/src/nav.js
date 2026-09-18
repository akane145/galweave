// nav.js — 逐行导航的落点计算（纯逻辑，无 DOM、无 vscode 依赖）
//
// 复刻 Galweave 的逐行翻译交互：`Enter` 进下一行、`Tab` 下一行、`Shift+Tab` 上一行。
// 桌面版每行都有输入框，所以"下一行"总有落点；原生编辑器里没译文行的段落没有可编辑处，
// 因此这里额外返回 `needCreate`，由调用方决定是补一行还是只把光标放过去。

/** 光标所在行属于第几段；不在任何段落里（空行、注释行、段间多余行）返回 -1 */
export function paraIndexAtLine(parsed, line) {
  const ln = parsed?.lines?.[line];
  if (!ln || ln.paraIndex === null || ln.paraIndex === undefined) return -1;
  return ln.paraIndex;
}

/** 段落覆盖的行区间 [start, end]（0 基，含两端） */
export function paraSpan(para) {
  const lines = [para.lineIndices.orig];
  if (para.lineIndices.trans !== null && para.lineIndices.trans !== undefined) lines.push(para.lineIndices.trans);
  if (para.lineIndices.extra?.length) lines.push(para.lineIndices.extra[para.lineIndices.extra.length - 1]);
  return [Math.min(...lines), Math.max(...lines)];
}

/** 一段的翻译落点：有译文行就用它，没有则落在原文行并标记需要补行 */
function targetOf(para) {
  const t = para.lineIndices.trans;
  const has = t !== null && t !== undefined;
  return {
    para,
    line: has ? t : para.lineIndices.orig,
    needCreate: !has,
  };
}

/**
 * 从当前行出发，找上/下一段的翻译落点。
 *
 * @param {object} parsed parseLines 的结果
 * @param {number} currentLine 光标所在行
 * @param {1|-1} dir 1 = 下一段，-1 = 上一段
 * @returns {{para:object, line:number, needCreate:boolean}|null} null = 已经在头/尾
 */
export function navTarget(parsed, currentLine, dir) {
  const paras = parsed?.paras || [];
  if (!paras.length) return null;
  const step = dir >= 0 ? 1 : -1;
  const idx = paraIndexAtLine(parsed, currentLine);

  if (idx >= 0) {
    const next = paras[idx + step];
    return next ? targetOf(next) : null;
  }

  // 光标不在任何段落上（空行、注释行、段内多余行）：
  // 取位置上"在其后/其前"最近的那一段，方向按 step 走
  if (step > 0) {
    const hit = paras.find(p => p.lineIndices.orig > currentLine);
    return hit ? targetOf(hit) : null;
  }
  let hit = null;
  for (const p of paras) {
    if (p.lineIndices.orig >= currentLine) break;
    hit = p;
  }
  return hit ? targetOf(hit) : null;
}

/**
 * 选区是否触及原文行 —— 用于锁定：只要选区覆盖到原文行，就要拦住这次编辑
 * （否则可以选中原文行再输入/粘贴，绕开"光标在原文行上"的判断）。
 */
export function selectionTouchesOrig(parsed, startLine, endLine) {
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  for (let i = lo; i <= hi; i++) {
    if (parsed?.lines?.[i]?.role === 'orig') return true;
  }
  return false;
}

/* ---------------- 译文行的可编辑区（前后缀与括号也锁） ----------------
 *
 * 桌面版里译文行是「只读前缀 + 输入框 + 只读后缀」：`★0001★藍★` 前缀不可编辑，
 * 「」被外置成锁定括号。原生编辑器只有一整行文本，所以这里算出**可编辑的字符区间**，
 * 由 vscode 层把区间外的按键拦掉，等价还原那个结构。
 */

/** 该行的译文内容是否被「」完整包裹 */
function transBracketed(lineText, range) {
  const s = lineText.slice(range.from, range.to);
  return s.length >= 2 && s.startsWith('「') && s.endsWith('」');
}

/**
 * 译文行内**允许编辑**的插入位置区间 [from, to]（闭区间，char 即插入位置）。
 * `para.translationRange` 是译文正文的区间；带「」时向内各收一格。
 * 非译文行或拿不到区间时返回 null（表示不限制）。
 */
export function transEditRange(para, lineText) {
  const tr = para?.translationRange;
  if (!tr) return null;
  const text = String(lineText || '');
  if (transBracketed(text, tr)) return { from: tr.from + 1, to: tr.to - 1 };
  return { from: tr.from, to: tr.to };
}

/**
 * 位置 char 落在哪一类锁定区里。
 * @returns {'orig'|'trans-prefix'|'trans-suffix'|null} null = 可编辑
 */
export function lockedZoneAt(parsed, line, char, lineText) {
  const ln = parsed?.lines?.[line];
  if (!ln) return null;
  if (ln.role === 'orig') return 'orig';
  if (ln.role !== 'trans') return null;

  const para = parsed.paras[ln.paraIndex];
  const range = transEditRange(para, lineText);
  if (!range) return null;
  if (char < range.from) return 'trans-prefix';
  if (char > range.to) return 'trans-suffix';
  return null;
}

/**
 * 光标在某个位置时，各类编辑操作是否该被拦。
 *
 * 分三种键分别判定，因为**边界的性质不同**：
 * 光标停在可编辑区起点时，退格会吃掉前缀的最后一个字符；停在终点时，删除会吃掉收尾的「」。
 * 只按"位置是否在可编辑区内"一刀切会放过这两种破坏。
 *
 * @returns {{editBlocked:boolean, blockBackspace:boolean, blockDelete:boolean}}
 */
export function blockStateAt(parsed, line, char, lineText) {
  const role = parsed?.lines?.[line]?.role;

  if (role === 'orig') {
    // 原文行整行锁定：输入、退格、删除全拦
    return { editBlocked: true, blockBackspace: true, blockDelete: true };
  }
  if (role !== 'trans') {
    return { editBlocked: false, blockBackspace: false, blockDelete: false };
  }

  const text = String(lineText || '');
  const range = transEditRange(parsed.paras[parsed.lines[line].paraIndex], text);
  if (!range) return { editBlocked: false, blockBackspace: false, blockDelete: false };

  return {
    // 输入/粘贴/剪切：插入位置必须在可编辑区闭区间内
    editBlocked: !(char >= range.from && char <= range.to),
    // 退格删的是光标前一个字符：位置上必须严格大于起点
    blockBackspace: !(char > range.from && char <= range.to),
    // 删除删的是光标后一个字符：位置上必须严格小于终点
    blockDelete: !(char >= range.from && char < range.to),
  };
}

/** 非空选区：只要碰到锁定区就全拦 */
export function blockStateForSelection(parsed, sel, lineTextOf) {
  const touches = selectionTouchesLocked(parsed, sel, lineTextOf);
  return { editBlocked: touches, blockBackspace: touches, blockDelete: touches };
}

/**
 * 选区是否碰到任何锁定区（原文行整行、译文行的前后缀/括号）。
 *
 * 逐行精确判定：区间内的原文行一律算碰到；译文行则看被选中的那一段字符
 * 是否越出了该行的可编辑区。`lineTextOf(line)` 由调用方提供，本模块不碰文档对象。
 *
 * @param {{startLine:number,startChar:number,endLine:number,endChar:number}} sel
 */
export function selectionTouchesLocked(parsed, sel, lineTextOf) {
  const fromLine = Math.min(sel.startLine, sel.endLine);
  const toLine = Math.max(sel.startLine, sel.endLine);
  // 归一化方向：起点在前时用 startChar 作为首行起点，反之用 endChar
  const forward = sel.startLine <= sel.endLine;
  const fromChar = forward ? sel.startChar : sel.endChar;
  const toChar = forward ? sel.endChar : sel.startChar;

  for (let i = fromLine; i <= toLine; i++) {
    const role = parsed?.lines?.[i]?.role;
    if (role === 'orig') return true;
    if (role !== 'trans') continue;

    const text = lineTextOf(i);
    const range = transEditRange(parsed.paras[parsed.lines[i].paraIndex], text);
    if (!range) continue;
    const a = i === fromLine ? fromChar : 0;
    const b = i === toLine ? toChar : text.length;
    if (a < range.from || b > range.to) return true;
  }
  return false;
}


