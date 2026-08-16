// debounce.js — 通用防抖工具(纯逻辑,可单测)
// 运行: node --test tests/worker.test.mjs

/** 末次防抖: wait 期内重复调用只执行最后一次,停顿 wait 后触发。 */
export function debounce(fn, wait = 0){
  if (typeof fn !== 'function') throw new TypeError('debounce: 参数必须是函数');
  let timer = null;
  let lastThis = undefined;
  let lastArgs = null;
  function wrapped(...args){
    lastThis = this;
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const t = lastThis, a = lastArgs;
      lastArgs = null;
      fn.apply(t, a);
    }, Math.max(0, wait));
  }
  wrapped.cancel = () => {
    if (timer !== null){ clearTimeout(timer); timer = null; lastArgs = null; }
  };
  wrapped.flush = () => {
    if (timer !== null){
      clearTimeout(timer);
      timer = null;
      const t = lastThis, a = lastArgs;
      lastArgs = null;
      fn.apply(t, a);
    }
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

/** 首次防抖: 立即首次触发,wait 内静默,wait 后可再次触发。 */
export function throttle(fn, wait = 0){
  if (typeof fn !== 'function') throw new TypeError('throttle: 参数必须是函数');
  let last = 0;
  let timer = null;
  let trailingArgs = null;
  return function (...args){
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0 || remaining > wait){
      if (timer){ clearTimeout(timer); timer = null; }
      last = now;
      fn.apply(this, args);
    } else {
      trailingArgs = args;
      const self = this;
      if (timer === null){
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          const a = trailingArgs;
          trailingArgs = null;
          if (a) fn.apply(self, a);
        }, remaining);
      }
    }
  };
}