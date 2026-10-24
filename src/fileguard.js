// fileguard.js — 「文件被外部修改」的检测与决策（纯逻辑，无 DOM / 无 IO）
//
// 场景：用户用 Galweave 打开脚本，同时在别处（另一份编辑器、同步盘、游戏自带工具、
// 同事发的更新包）改过同一个文件。此时点「保存原文件」会把外部改动**整体覆盖**掉，
// 而且没有任何提示 —— 这是"成果静默丢失"里最难受的一类，因为丢的不是自己刚打的字，
// 是别人的改动，往往到很后面才发现。
//
// 做法（对齐需求里"第一版无需自动合并"的取舍）：
//   1. 打开文件时记一份指纹（大小 / mtime / 内容散列，见 Rust `file_stat`）；
//   2. 每次真正写盘前重新取指纹，与记下的比；
//   3. 不一致就**不写**，把选择权交给用户：另存为（保留双方）或确认覆盖。
//
// 为什么不自动合并：脚本是结构化文本（编号、控制符、镜像格式的原文/译文成对），
// 一份行级三方合并要同时理解这些结构才能保证不错行；做不彻底的三方合并比不做更危险。
// 所以本模块只判断"变没变"，不猜"该怎么合"。

/**
 * 指纹对象形状（与 Rust `FileStat` 对应）：
 *   { exists:boolean, size:number, mtimeMs:number, hash:string }
 * 任何字段缺失都按"未知"处理，不当作变化 —— 宁可漏报一次，也不要因取不到
 * mtime 就天天弹"文件被改过"，那会让用户直接学会无脑点确认。
 */

/** 归一化外部传入的指纹，字段类型不对就丢掉该字段（返回 null 表示完全无效） */
export function normalizeStat(stat){
  if (!stat || typeof stat !== 'object') return null;
  const out = {};
  if (typeof stat.exists === 'boolean') out.exists = stat.exists;
  if (typeof stat.size === 'number' && Number.isFinite(stat.size)) out.size = stat.size;
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) out.mtimeMs = stat.mtimeMs;
  if (typeof stat.hash === 'string' && stat.hash) out.hash = stat.hash;
  return Object.keys(out).length ? out : null;
}

/** 两个指纹是否可判定为同一份内容。只要有一边无效 → 视为未知（同 changed=false） */
export function sameStat(a, b){
  const x = normalizeStat(a);
  const y = normalizeStat(b);
  if (!x || !y) return false;
  // 存在性不一致就是变了（文件被删/刚创建）
  if (x.exists !== y.exists) return false;
  if (!x.exists) return true; // 两边都不存在 = 没变化
  // 散列是最强判据，双方都有就直接用它
  if (x.hash && y.hash) return x.hash === y.hash;
  // 退而比大小 + 时间（任一缺失则该维度不否决）
  const sizeSame = x.size === undefined || y.size === undefined || x.size === y.size;
  const timeSame = x.mtimeMs === undefined || y.mtimeMs === undefined || x.mtimeMs === y.mtimeMs;
  return sizeSame && timeSame;
}

export const VERDICTS = {
  /** 没变，或无法判定 → 正常保存 */
  SAME: 'same',
  /** 被外部改过 → 交给用户决定 */
  CHANGED: 'changed',
  /** 打开时有、现在没了 → 不能盲目重建（可能是用户自己删的，也可能盘断了） */
  MISSING: 'missing',
  /** 打开时不存在、现在有了 → 可能是别的程序刚创建了这个路径 */
  APPEARED: 'appeared',
  /** 这次没有基线（网页版/未记录）→ 无从比较，如实说明而不是假装没变 */
  UNKNOWN: 'unknown',
};

/**
 * 判断当前指纹相对基线的情形。
 * @param {object|null} baseline 打开（或上次保存）时记下的指纹
 * @param {object|null} current  写盘前重新取的指纹
 * @returns {{verdict:string, changed:boolean, reason:string}}
 */
export function compareStat(baseline, current){
  const base = normalizeStat(baseline);
  const cur = normalizeStat(current);
  if (!base) {
    return { verdict: VERDICTS.UNKNOWN, changed: false, reason: '这次没有基线指纹（浏览器版或未记录），无法判断是否被外部改过。' };
  }
  if (!cur) {
    return { verdict: VERDICTS.UNKNOWN, changed: false, reason: '取不到当前文件状态，无法判断是否被外部改过。' };
  }
  const wasThere = base.exists !== false;
  const isThere = cur.exists !== false;
  if (wasThere && !isThere){
    return { verdict: VERDICTS.MISSING, changed: true, reason: '这个文件现在不存在了（被移动、改名或删除）。' };
  }
  if (!wasThere && isThere){
    return { verdict: VERDICTS.APPEARED, changed: true, reason: '这个路径上出现了新文件（之前不存在）。' };
  }
  if (!wasThere && !isThere){
    return { verdict: VERDICTS.SAME, changed: false, reason: '' };
  }
  if (sameStat(base, cur)) {
    return { verdict: VERDICTS.SAME, changed: false, reason: '' };
  }
  return { verdict: VERDICTS.CHANGED, changed: true, reason: '文件在打开之后被别的程序改过。' };
}

/**
 * 保存前冲突的用户可见说明。文案要点：**说清会丢什么、给两个出路**，
 * 不写"是否继续？"这种让人看不懂后果的干问。
 */
export function conflictMessage(filename, verdict, detail){
  const name = String(filename || '当前文件');
  const tail = detail ? '\n' + detail : '';
  if (verdict === VERDICTS.MISSING){
    return name + ' 已经不在原路径上了。\n'
      + '直接保存会在原路径**重新创建一个文件**，而不是更新原来那份。' + tail;
  }
  if (verdict === VERDICTS.APPEARED){
    return '原路径上出现了另一个文件（打开时那里还是空的）。\n'
      + '直接保存会把它**覆盖掉**。' + tail;
  }
  return name + ' 在你打开之后被**别的程序改过**。\n'
    + '现在保存会用工作台里的译文**整份覆盖**那份改动，对方新加的原文或译文会丢。' + tail;
}

/**
 * 冲突选项 → 该做什么。UI 只负责把这三个选项摆出来。
 * 放在纯逻辑里是为了让单测锁住"默认不覆盖"这条安全属性。
 */
export const CONFLICT_ACTIONS = {
  /** 另存为新文件（默认、最安全） */
  SAVE_AS: 'saveAs',
  /** 用户明确知情后覆盖 */
  OVERWRITE: 'overwrite',
  /** 放弃本次保存 */
  CANCEL: 'cancel',
};

/** 冲突对话框的选项顺序：默认项在最前，且在 UI 上获得初始焦点 */
export function conflictChoices(){
  // 顺序即优先级：另存为永远第一（默认焦点），覆盖必须让用户多走一步才够得着。
  // 这条"默认不覆盖"是安全属性，改动顺序前先看 tests/fileguard.test.mjs。
  //
  // ⚠️ 字段名必须是 `id` —— 这里返回的对象直接喂给 modals.showChoice()，
  //    它按 `c.id` 认选项。曾用 `action` 而没对齐，结果是**弹出三个按钮的对话框
  //    一个按钮都没有**（showChoice 静默过滤掉了没有 id 的项），
  //    用户在"文件被外部改过"这个最需要选择的时刻看到空对话框。
  //    tests/fileguard.test.mjs 有一条测试专门锁这个字段名。
  return [
    { id: CONFLICT_ACTIONS.SAVE_AS, label: '另存为新文件', hint: '保留对方的改动，你的译文存到新文件里' },
    { id: CONFLICT_ACTIONS.OVERWRITE, label: '仍然覆盖原文件', hint: '对方的改动会丢失', danger: true },
    { id: CONFLICT_ACTIONS.CANCEL, label: '取消保存', hint: '先自己看看原文件变成了什么样' },
  ];
}

/* ---------------- 保存结果 → 用户提示 ---------------- */

/**
 * 写盘结果的可读摘要。
 * @param {object} res Rust `write_file` 的返回 { atomic, atomicReason, encoding, backup, backupError }
 * @param {string} path 目标路径
 * @returns {{text:string, warning:boolean}} warning=true 时调用方应显著提示（toastError 而非 toast）
 */
export function describeWriteResult(res, path){
  const r = res && typeof res === 'object' ? res : {};
  const lines = ['✅ 已保存到：' + (path || '')];
  if (r.encoding && normalizeEnc(r.encoding) !== 'utf-8') lines.push('编码：' + r.encoding);
  let warning = false;
  if (r.backup === 'failed'){
    warning = true;
    lines.push('⚠️ 备份失败（' + (r.backupError || '未知原因') + '）：原文件已被新内容替换，'
      + '但 .galweave 下没有留下备份。可用侧栏「历史」找回旧版本。');
  }
  if (r.atomic === false){
    warning = true;
    lines.push('⚠️ 本次不是原子替换（' + (r.atomicReason || '未知原因') + '）。'
      + '写入中途出错可能留下不完整的文件，建议检查一遍。');
  }
  return { text: lines.join('\n'), warning };
}

function normalizeEnc(name){
  return String(name == null ? '' : name).trim().toLowerCase();
}
