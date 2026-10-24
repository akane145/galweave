// mt-task.js — 批量机翻的任务状态、失败清单与重试（纯逻辑，无 DOM / 无 IO）
//
// 为什么单独成模块：批量机翻原来的实现是一个裸 for 循环 + 三个闭包变量，
// 于是三件事都做不到 ——
//   1. **停不下来**：循环一路跑到底，用户只能等（或杀进程）；
//   2. **失败只有第一条**：`failed.push` 攒着，最后只报 `failed[0].err`，
//      其余行为什么失败、是哪几行，用户无从知道，更没法只重试它们；
//   3. **迟到的结果会覆盖人工修改**：请求发出后用户在等待期间自己敲了译文，
//      返回的机翻结果照写不误，把人工输入顶掉（体感是"我刚打的字没了"）。
//
// 这三件事全是状态判定，与 DOM/网络无关，所以放进纯逻辑模块用单测锁住。
// main.js 只负责驱动它 + 渲染。

/** 每行的状态。'stopped' 与 'failed' 刻意分开：停止是用户意图，失败是意外。 */
export const ROW_STATE = {
  PENDING: 'pending',
  DONE: 'done',
  FAILED: 'failed',
  /** 用户停止时还没轮到的行 */
  STOPPED: 'stopped',
  /** 请求期间该行被人工改过 → 不写入，但要如实告诉用户 */
  EDITED: 'edited',
};

/**
 * 建一个任务。
 * @param {number[]} indexes 要翻译的行号（升序）
 * @param {object} [opts] { label } 显示用标签
 */
export function createTask(indexes, opts = {}){
  const list = (Array.isArray(indexes) ? indexes : []).filter(n => Number.isInteger(n));
  return {
    label: String(opts.label || ''),
    /** 全部目标行（含已处理的） */
    all: list.slice(),
    /** 行号 → 状态 */
    state: new Map(list.map(i => [i, ROW_STATE.PENDING])),
    /** 行号 → 错误信息 */
    errors: new Map(),
    /** 已完成的行（按完成顺序） */
    done: [],
    stopped: false,
    startedAt: Number.isFinite(Number(opts.now)) ? Number(opts.now) : 0,
  };
}

/** 任务是否已停止（含"全部做完"以外的中止状态） */
export function isStopped(task){
  return !!(task && task.stopped);
}

/**
 * 请求某行前调用：记下该行当时的"编辑版本号"，用于识别迟到的结果。
 * @returns {number} 传给 settleStale 的版本号
 */
export function beginRow(task, i, editVersion){
  if (!task || !task.state.has(i)) return 0;
  task.pendingVersion = task.pendingVersion || new Map();
  task.pendingVersion.set(i, Number.isFinite(Number(editVersion)) ? Number(editVersion) : 0);
  return task.pendingVersion.get(i);
}

/** 标完成（结果可安全写入时调用） */
export function markDone(task, i){
  if (!task || !task.state.has(i)) return false;
  task.state.set(i, ROW_STATE.DONE);
  task.errors.delete(i);
  if (!task.done.includes(i)) task.done.push(i);
  return true;
}

/** 标失败，带原因（原因进清单，用户能逐行看/逐行重试） */
export function markFailed(task, i, err){
  if (!task || !task.state.has(i)) return false;
  task.state.set(i, ROW_STATE.FAILED);
  task.errors.set(i, String(err == null ? '' : (err.message || err)));
  return true;
}

/** 标"等待期间被人工改过，机翻结果已丢弃" */
export function markEdited(task, i){
  if (!task || !task.state.has(i)) return false;
  task.state.set(i, ROW_STATE.EDITED);
  task.errors.delete(i);
  return true;
}

/**
 * 请求返回后**先问该不该写** —— 这是防"迟到结果覆盖人工修改"的唯一闸门。
 *
 * @param {object} task
 * @param {number} i 行号
 * @param {number} currentEditVersion 该行**现在**的编辑版本号
 * @returns {boolean} true = 可以写入；false = 用户在等待期间改过这一行，别动它
 */
export function settleStale(task, i, currentEditVersion){
  if (!task) return true;
  const pending = task.pendingVersion ? task.pendingVersion.get(i) : undefined;
  if (pending === undefined) return true;   // 没记录过版本 → 不阻断（保守放行）
  const now = Number.isFinite(Number(currentEditVersion)) ? Number(currentEditVersion) : 0;
  return now === pending;
}

/** 用户停止：还没轮到的行标为 STOPPED（不是失败，不该出现在重试清单里） */
export function requestStop(task){
  if (!task) return;
  task.stopped = true;
  for (const [i, st] of task.state){
    if (st === ROW_STATE.PENDING) task.state.set(i, ROW_STATE.STOPPED);
  }
}

export function stateOf(task, i){
  return (task && task.state.get(i)) || '';
}

/** 还没处理的行（停止后为 0） */
export function pendingIndexes(task){
  if (!task) return [];
  const out = [];
  for (const i of task.all) if (task.state.get(i) === ROW_STATE.PENDING) out.push(i);
  return out;
}

/**
 * 需要重试的行：**只含失败行**。
 * 被人工改过（EDITED）的不重试 —— 用户已经自己写了，重试等于再覆盖一次。
 * 停止（STOPPED）也不重试 —— 那是用户主动放弃的，要重来应该走"继续翻译"。
 */
export function retryIndexes(task){
  if (!task) return [];
  return task.all.filter(i => task.state.get(i) === ROW_STATE.FAILED);
}

/** 失败清单（带原因），供面板逐条显示 */
export function failureList(task){
  if (!task) return [];
  return retryIndexes(task).map(i => ({ i, err: task.errors.get(i) || '' }));
}

/**
 * 取各状态计数。UI 面板与完成提示共用这一份口径，
 * 避免"面板说 3 条失败、提示说 2 条"这种两套说法。
 */
export function summarize(task){
  const out = { total: 0, pending: 0, done: 0, failed: 0, stopped: 0, edited: 0 };
  if (!task) return out;
  out.total = task.all.length;
  for (const [, st] of task.state){
    if (st === ROW_STATE.DONE) out.done++;
    else if (st === ROW_STATE.FAILED) out.failed++;
    else if (st === ROW_STATE.STOPPED) out.stopped++;
    else if (st === ROW_STATE.EDITED) out.edited++;
    else out.pending++;
  }
  return out;
}

/** 面板进度文案（"12 / 40 完成 · 2 失败"），空任务返回空串 */
export function progressLabel(task){
  if (!task || !task.all.length) return '';
  const s = summarize(task);
  const parts = [(s.done + s.edited) + ' / ' + s.total];
  if (s.failed) parts.push(s.failed + ' 失败');
  if (s.stopped) parts.push(s.stopped + ' 未处理');
  if (s.edited) parts.push(s.edited + ' 已跳过（你改过）');
  return parts.join(' · ');
}

/**
 * 完成/停止后的总结文案。
 * @param {object} task
 * @param {number} memApplied 翻译记忆直接套用的行数（不在 task 里，由调用方另行统计）
 */
export function summaryText(task, memApplied = 0){
  const s = summarize(task);
  const msgs = [];
  if (memApplied) msgs.push('翻译记忆 ' + memApplied + ' 行');
  if (s.done) msgs.push('机翻 ' + s.done + ' 行');
  if (s.edited) msgs.push('跳过 ' + s.edited + ' 行（等待期间你改过）');
  if (s.failed) msgs.push('失败 ' + s.failed + ' 行');
  if (s.stopped) msgs.push('未处理 ' + s.stopped + ' 行');
  const head = task && task.stopped ? '已停止机翻' : '批量翻译完成';
  if (!msgs.length) return head + '：没有需要处理的行。';
  let text = head + '：' + msgs.join(' · ') + '。';
  if (s.failed) text += '\n失败的行已列出，可只重试这些行。';
  if (s.stopped) text += '\n已完成的部分已保留，未处理的行可以继续机翻。';
  return text;
}

/**
 * 失败重试任务的构造：从原任务里摘出失败行，作为一次新任务。
 * 沿用同一套状态机，于是"重试里又失败的行"还能再重试 —— 不需要第二套机制。
 */
export function retryTask(task, opts = {}){
  const list = retryIndexes(task);
  const label = (task && task.label ? task.label + ' · ' : '') + '重试';
  return createTask(list, { ...opts, label });
}

/**
 * 行编辑版本号台账。
 *
 * 每一行有个递增的版本号，**任何人工写入都 +1**。机翻发请求前记下版本号，
 * 结果回来时比对：号码变了说明这行在等待期间被人改过，结果就丢弃。
 * 用版本号而不是"译文是否为空"判断，是因为前者能识别"改了又改回原样"，
 * 也能识别"用户故意清空"——那些都仍属于人工介入，不该被机翻顶掉。
 */
export function createEditTracker(){
  const versions = new Map();
  return {
    /** 取当前版本号（未记录过 = 0） */
    get(i){ return versions.get(i) || 0; },
    /** 记一次人工编辑 */
    bump(i){ versions.set(i, (versions.get(i) || 0) + 1); return versions.get(i); },
    /** 重置某行（换文档/批量套用等场景） */
    reset(i){ versions.delete(i); },
    clear(){ versions.clear(); },
  };
}
