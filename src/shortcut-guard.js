// shortcut-guard.js — 全局命令键的判定（纯逻辑，无 DOM）
//
// 用途：模态浮层显示期间，文档级命令（保存 / 撤销 / 重做 / 搜索 / 行导航）
// 不得作用于背景稿件，也不能把焦点抢出对话框。main.js 用本模块判定
// "这个按键是不是全局命令"，DOM 归属判断（是否在模态内、是否可编辑控件）
// 由调用方完成 —— 这样按键集合可以单测，且不引入 DOM 依赖。

/**
 * 该按键事件是否属于**文档级全局命令**。
 *
 * 覆盖主流程 keydown 里实际绑定的命令集合：
 *   Ctrl+S 保存 / Ctrl+F 搜索 / Ctrl+G 跳转 / Ctrl+Z 撤销 / Ctrl+Y 重做 /
 *   F2 下一未翻译 / F3 下一个匹配 / Ctrl+Enter 替换当前或机翻当前行。
 *
 * 校对组合键（Alt+Enter 等可自定义）不在这里枚举：调用方在模态打开时
 * 一律不派发校对动作，见 main.js 的隔离分支。
 *
 * @param {{key?:string, ctrlKey?:boolean, metaKey?:boolean, shiftKey?:boolean, altKey?:boolean}} e
 */
export function isGlobalCommandKey(e){
  if (!e) return false;
  const key = String(e.key || '').toLowerCase();
  const mod = !!(e.ctrlKey || e.metaKey);
  if (mod && (key === 's' || key === 'f' || key === 'g' || key === 'z' || key === 'y')) return true;
  if (e.key === 'F2' || e.key === 'F3') return true;
  if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') return true;
  return false;
}

/**
 * 事件目标是否是可编辑控件（输入框 / 文本域 / 下拉 / contenteditable）。
 *
 * 模态内的可编辑控件必须保留浏览器原生行为（包括控件自己的 Ctrl+Z 文本撤销），
 * 因此它们即便命中全局命令键也不拦截。
 */
export function isEditableElement(el){
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT'){
    const type = String(el.type || 'text').toLowerCase();
    // 按钮/勾选/文件等没有文本编辑语义，Ctrl+Z 不会作用于它们
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'hidden'].includes(type);
  }
  if (tag === 'SELECT') return true;
  return el.isContentEditable === true;
}
