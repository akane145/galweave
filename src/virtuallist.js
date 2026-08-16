// virtuallist.js — 变高行虚拟滚动的高度模型(纯逻辑,零 DOM 依赖,可单测)
// 行高来源: 已实测行用实测值,未实测行用统一估算值 estimate;
// 隐藏行(如校对过滤)高度记 0,不参与可见范围,也不占滚动高度。
// 运行: node --test tests/virtual.test.mjs

/** 创建行高模型。count 为总行数,estimate 为未实测行的估算高度(px)。 */
export function createRowHeightModel(count = 0, opts = {}){
  let n = Math.max(0, count >>> 0);
  let estimate = opts.estimate && opts.estimate > 0 ? opts.estimate : 80;

  const measured = new Map(); // i -> 实测高度(四舍五入整数)
  const hiddenSet = new Set(); // 隐藏行下标集合
  let prefix = null;           // 惰性前缀和: prefix[i] = 前 i 行累计高度
  let totalCache = 0;

  function invalidate(){ prefix = null; }

  function ensure(){
    if (prefix) return;
    prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++){
      prefix[i + 1] = prefix[i] + heightOf(i);
    }
    totalCache = prefix[n];
  }

  function heightOf(i){
    if (hiddenSet.has(i)) return 0;
    const m = measured.get(i);
    return m !== undefined ? m : estimate;
  }

  function isHidden(i){ return hiddenSet.has(i); }

  /** offset 落在哪个可见行上(返回行下标;含 offset 正好落在隐藏行/边界时向后取第一个可见行)。offset >= 总高度时返回 n。 */
  function indexAt(offset){
    if (n === 0) return 0;
    ensure();
    if (offset >= totalCache) return n;
    let a = 0, b = n;
    // 不变量: prefix[a] <= offset < prefix[b];结束时 a 是最大的 prefix[a] <= offset 的下标
    while (a < b - 1){
      const mid = (a + b) >> 1;
      if (prefix[mid] <= offset) a = mid; else b = mid;
    }
    while (a < n && hiddenSet.has(a)) a++;
    return a;
  }

  return {
    get count(){ return n; },
    get estimate(){ return estimate; },

    /** 换文件/重置: 清空实测与隐藏状态 */
    reset(count2){
      n = Math.max(0, count2 >>> 0);
      measured.clear();
      hiddenSet.clear();
      invalidate();
    },

    /** 调整未实测行的估算高度 */
    setEstimate(h){ if (h > 0){ estimate = h; invalidate(); } },

    /** 记录实测高度(隐藏行也可记录,计算时按 0 处理) */
    setMeasured(i, h){
      if (i < 0 || i >= n || !(h >= 0)) return;
      measured.set(i, Math.round(h));
      invalidate();
    },

    /** 放弃全部实测(容器宽度变化导致换行改变时),回退估算 */
    clearMeasured(){ measured.clear(); invalidate(); },

    /** 标记/取消隐藏行(隐藏行高度记 0) */
    setHidden(i, v){
      if (i < 0 || i >= n) return;
      if (v) hiddenSet.add(i); else hiddenSet.delete(i);
      invalidate();
    },

    isHidden, heightOf,
    measuredCount(){ return measured.size; },

    /** 已实测行的平均高度(用于校准估算);无实测返回 0 */
    avgMeasured(){
      if (!measured.size) return 0;
      let sum = 0;
      for (const h of measured.values()) sum += h;
      return sum / measured.size;
    },

    /** 内容总高度(所有行累计) */
    total(){ ensure(); return totalCache; },

    /** 第 i 行顶部距第一行顶部的偏移(夹取 [0, total]) */
    offsetOf(i){
      if (n === 0 || i <= 0) return 0;
      ensure();
      if (i >= n) return totalCache;
      return prefix[i];
    },

    indexAt,

    /**
     * 可见行范围 [start, end): 覆盖 [scrollTop, scrollTop+viewportH] 的可见行,
     * 两侧各扩 buffer 个可见行;隐藏行不进入范围但范围下标连续(挂载方自行跳过隐藏行)。
     */
    visibleRange(scrollTop, viewportH, buffer = 0){
      if (n === 0) return { start: 0, end: 0 };
      ensure();
      const top = Math.max(0, scrollTop);
      const bottom = top + Math.max(viewportH, 1);
      let start = indexAt(top);
      let end = indexAt(bottom);
      if (end < n && prefix[end] < bottom) end += 1; // 底部恰好跨界的行也算可见
      let s = start, cnt = 0;
      while (s > 0 && cnt < buffer){ s--; if (!hiddenSet.has(s)) cnt++; }
      start = s;
      let e = end, cnt2 = 0;
      while (e < n && cnt2 < buffer){ if (!hiddenSet.has(e)) cnt2++; e++; }
      end = e;
      if (end < start) end = start;
      return { start, end };
    },
  };
}
