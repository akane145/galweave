// mdx.js — MDX 词典适配层
// 桌面版: 走 Tauri 原生命令(mdx_open/lookup/prefix/close),Rust 端内存映射 + 解析,
//         彻底消除 Base64 over JSON IPC 膨胀;@@@LINK 跟随在 Rust 端完成。
// 浏览器单文件版: 保留 js-mdict@6.0.8 + node-shims 路径(与 v5.0 行为一致)。
// 运行: node --test tests/mdx.test.mjs

import * as fsx from './fs.js';

/* ================= 词条交互纯逻辑(可单测) ================= */

/** 扩展名 → MIME(词条 HTML 里 MDD 资源的图片/音频) */
export function mimeFromExt(name){
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}

/** 词条内 img src → MDD 资源 key: 去前导 / 或 \ (MDD key 内部保留反斜杠) */
export function srcToResourceKey(src){
  return String(src || '').replace(/^[\\/]+/, '');
}

/** 是否为需要 MDD 解析的本地资源 src(http/data/blob 等外部资源不需要) */
export function isMddResourceSrc(src){
  return !!String(src || '') && !/^(https?:|data:|blob:|about:)/i.test(src);
}

/** href 是否为词条跳转链接 */
export function isEntryLink(href){
  return String(href || '').startsWith('entry://');
}
/** href 是否为发音链接 */
export function isSoundLink(href){
  return String(href || '').startsWith('sound://');
}
/** 从 entry:// 或 sound:// 提取目标 */
export function linkTarget(href){
  return String(href || '').replace(/^[a-z]+:\/\//, '');
}

/* ================= 词条 HTML 消毒(JS 端安全边界,两种路径共用) ================= */

/**
 * MDX 词条 HTML 消毒: 只保留排版性标签,移除脚本/样式/表单/媒体与事件属性。
 * 词典是第三方内容,Webview 内必须消毒后再渲染。Node(无 DOMParser)环境直接原样返回(供测试)。
 */
export function sanitizeMdxHtml(html){
  if (typeof DOMParser === 'undefined') return String(html);
  let doc;
  try {
    doc = new DOMParser().parseFromString('<div id="mdx-root">' + String(html) + '</div>', 'text/html');
  } catch (e){ return ''; }
  const root = doc.getElementById('mdx-root');
  if (!root) return '';
  root.querySelectorAll('script,style,iframe,frame,object,embed,link,meta,base,form,input,select,textarea,button,video,audio,source').forEach(el => el.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]){
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*(javascript|data|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  return root.innerHTML;
}

/* ================= 结果归一化 ================= */

/** 把一个原始命中(词头+释义HTML)映射为 DictResult(供 renderer 展示) */
function toDictResult(headword, html, sourceName){
  return {
    headword,
    reading: '',
    senses: [{ gloss: '', html: sanitizeMdxHtml(html) }],
    source: sourceName,
  };
}

/* ================= 桌面版: Tauri 原生命令路径 ================= */

/** 取 Tauri invoke(默认动态 import;测试可注入桩)。返回 Promise<invoke> */
function getInvoke(invokeImpl){
  if (invokeImpl) return Promise.resolve(invokeImpl);
  return import('@tauri-apps/api/core').then(m => m.invoke);
}

/**
 * 创建走 Tauri 命令的 MDX Provider。
 * cfg: { id?, name, path, invokeImpl? } — path 为 .mdx 文件绝对路径;invokeImpl 测试注入。
 * 首次查询时惰性 mdx_open(解析文件头,坏文件当场报错);之后 mdx_lookup 走 Rust 端查询
 * (已含 @@@LINK 跟随与大小写兜底);未命中时 mdx_prefix 前缀补全(≤6 条,与浏览器版一致);
 * dispose 释放句柄。
 */
export function createTauriMdxProvider(cfg){
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + (cfg.path || name);
  const invokeImpl = cfg.invokeImpl;
  let handle = null;
  let openErr = null;
  let opening = null;

  async function ensure(){
    if (handle !== null) return handle;
    if (openErr) throw openErr;
    if (!opening){
      opening = (async () => {
        try {
          const invoke = await getInvoke(invokeImpl);
          const h = await invoke('mdx_open', { path: cfg.path });
          if (typeof h !== 'number' || !Number.isFinite(h)) throw new Error('mdx_open 返回非法句柄');
          handle = h;
        } catch (e){
          openErr = new Error('MDX 文件解析失败(' + name + '): ' + ((e && e.message) || e));
          throw openErr;
        } finally {
          opening = null;
        }
      })();
    }
    return opening;
  }

  async function lookupRaw(invoke, word){
    return invoke('mdx_lookup', { handle, word: String(word || '').trim() });
  }

  return {
    id, name,
    isConfigured(){ return true; }, // 路径已知即可配置;解析失败在查询时抛错
    async lookup(word){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      const hit = await lookupRaw(invoke, word);
      if (hit) return [toDictResult(hit.key_text || word, hit.definition || '', name)];
      // 未命中 → 前缀补全(与浏览器版 buildMdxResults 一致: 取前若干个近似词的词条)
      const pref = await invoke('mdx_prefix', { handle, word: String(word || ''), limit: 6 });
      const out = [];
      for (const kw of (Array.isArray(pref) ? pref : []).slice(0, 6)){
        try {
          const h = await lookupRaw(invoke, kw);
          if (h) out.push(toDictResult(h.key_text || kw, h.definition || '', name));
        } catch (e){ /* 单条失败跳过 */ }
      }
      return out;
    },
    async prefix(word, limit){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return invoke('mdx_prefix', { handle, word: String(word || ''), limit: limit || 6 });
    },
    /** 模糊(包含)搜索词头,返回词头数组(Rust 侧遍历词表) */
    async search(word, limit){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return invoke('mdx_search', { handle, word: String(word || ''), limit: limit || 20 });
    },
    isLoaded(){ return handle !== null; },
    dispose(){
      if (handle !== null){
        const h = handle;
        getInvoke(invokeImpl).then(invoke => invoke('mdx_close', { handle: h }).catch(() => {}));
        handle = null;
      }
    },
  };
}

/** 桌面版: MDD 资源包句柄管理(供词条内图片/音频加载)。cfg: { name, path, invokeImpl? } */
export function createTauriMdd(cfg){
  const name = cfg.name || 'MDD 资源包';
  const invokeImpl = cfg.invokeImpl;
  let handle = null;
  let openErr = null;
  let opening = null;
  async function ensure(){
    if (handle !== null) return handle;
    if (openErr) throw openErr;
    if (!opening){
      opening = (async () => {
        try {
          const invoke = await getInvoke(invokeImpl);
          handle = await invoke('mdd_open', { path: cfg.path });
        } catch (e){
          openErr = e;
          throw e;
        } finally { opening = null; }
      })();
    }
    return opening;
  }
  return {
    name,
    /** 取资源原始字节(ArrayBuffer;供 Audio/Blob 用) */
    async resource(key){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      const b64 = await invoke('mdd_resource', { handle, key });
      return b64 ? fsx.base64ToArrayBuffer(b64) : null;
    },
    /** 取资源 base64(直接拼 data URL,避免往返转换) */
    async resourceB64(key){
      await ensure();
      const invoke = await getInvoke(invokeImpl);
      return await invoke('mdd_resource', { handle, key });
    },
    dispose(){
      if (handle !== null){
        const h = handle;
        getInvoke(invokeImpl).then(invoke => invoke('mdd_close', { handle: h }).catch(() => {}));
        handle = null;
      }
    },
  };
}

/* ================= 浏览器版: js-mdict + node-shims 路径(保持 v5.0 行为) ================= */

/** 清除 MDX 记录块尾部的填充字符(\r\n 与 NUL) */
function cleanDefinition(def){
  return String(def == null ? '' : def).replace(/\x00/g, '').replace(/\s+$/g, '');
}

/** 跟随 MDict 的 @@@LINK 跨词条引用(变体词 → 主词条),防循环,最多 3 跳 */
function resolveLink(inst, definition, sourceName, depth){
  const m = /^@@@LINK=(.+)$/.exec(String(definition || '').trim());
  if (!m) return null;
  if (depth <= 0) return null;
  const target = m[1].trim();
  try {
    const hit = inst.lookup(target);
    if (!hit || !hit.definition) return null;
    const def2 = cleanDefinition(hit.definition);
    if (/^@@@LINK=/.test(def2)) return resolveLink(inst, def2, sourceName, depth - 1);
    return {
      headword: hit.keyText || target,
      reading: '',
      senses: [{ gloss: '', html: sanitizeMdxHtml(def2) }],
      source: sourceName,
    };
  } catch (e){ return null; }
}

/** 把一个 MDX 实例(或测试桩)的查询映射为 DictResult[](纯逻辑,可单测) */
export async function buildMdxResults(inst, word, sourceName){
  const norm = String(word || '').trim();
  if (!norm || !inst) return [];
  const out = [];
  // 精确命中(词典键不区分大小写时 js-mdict 内部已归一;再兜底小写一次)
  let hit = null;
  try { hit = inst.lookup(norm); } catch (e){ /* 查询失败按未命中处理 */ }
  if (!hit || hit.definition == null || hit.definition === ''){
    try { hit = inst.lookup(norm.toLowerCase()); } catch (e){ hit = null; }
  }
  if (hit && hit.definition){
    const def = cleanDefinition(hit.definition);
    if (/^@@@LINK=/.test(def)){
      // @@@LINK 变体词 → 跟随到主词条;解析失败(目标缺失/循环)视为未命中
      const linked = resolveLink(inst, def, sourceName, 3);
      if (linked){
        // 目标词头是内部 ID(如 @jitendex-123456 / 38658)时直接显示查询词,避免出现 "@…" 字样
        linked.headword = /^@|^\d+$/.test(linked.headword) ? (hit.keyText || norm) : ((hit.keyText || norm) + ' → ' + linked.headword);
        out.push(linked);
      }
    } else if (def){
      out.push({
        headword: hit.keyText || norm,
        reading: '',
        senses: [{ gloss: '', html: sanitizeMdxHtml(def) }],
        source: sourceName,
      });
    }
    if (out.length) return out;
  }
  // 无精确命中 → 前缀补全(取前若干个近似词的词条)
  let pref = [];
  try { pref = inst.prefix(norm.toLowerCase()) || []; } catch (e){ pref = []; }
  for (const item of pref.slice(0, 6)){
    try {
      const d = inst.fetch(item);
      if (d && d.definition){
        const def = cleanDefinition(d.definition);
        if (/^@@@LINK=/.test(def)){
          const linked = resolveLink(inst, def, sourceName, 3);
          if (linked){
            linked.headword = /^@|^\d+$/.test(linked.headword) ? (d.keyText || item.keyText || norm) : ((d.keyText || item.keyText || norm) + ' → ' + linked.headword);
            out.push(linked);
          }
        } else if (def){
          out.push({
            headword: d.keyText || item.keyText || norm,
            reading: '',
            senses: [{ gloss: '', html: sanitizeMdxHtml(def) }],
            source: sourceName,
          });
        }
      }
    } catch (e){ /* 单条失败跳过 */ }
  }
  return out;
}

/** 异步实例化: 补 Buffer polyfill → 注册内存文件 → 构造 MDX(解析文件头,坏文件当场报错) */
async function instantiateMdx(fakePath, buffer){
  // js-mdict 内部直接使用 Node 的 Buffer 全局,浏览器环境先补 polyfill
  if (typeof globalThis.Buffer === 'undefined'){
    const { Buffer } = await import('buffer');
    globalThis.Buffer = Buffer;
  }
  const { registerBuffer } = await import('./node-shims/fs.js');
  registerBuffer(fakePath, buffer);
  const mod = await import('js-mdict');
  return new mod.MDX(fakePath);
}

/**
 * 创建 MDX 词典 Provider(异步: 构造时即解析文件头,坏文件当场报错)。
 * cfg: { id?, name, buffer: ArrayBuffer }
 */
export async function createMdxProvider(cfg){
  if (!(cfg.buffer instanceof ArrayBuffer)) throw new Error('MDX 词典需要 ArrayBuffer 内容');
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + name;
  const fakePath = 'mdx-virtual://' + id;
  let inst;
  try {
    inst = await instantiateMdx(fakePath, cfg.buffer);
  } catch (e){
    const { unregisterBuffer } = await import('./node-shims/fs.js');
    unregisterBuffer(fakePath);
    throw new Error('MDX 文件解析失败(' + name + '): ' + (e && e.message ? e.message : e));
  }
  return {
    id, name,
    isConfigured(){ return !!inst; },
    async lookup(word){
      if (!inst) return [];
      return buildMdxResults(inst, word, name);
    },
    dispose(){
      import('./node-shims/fs.js').then(({ unregisterBuffer }) => unregisterBuffer(fakePath));
    },
  };
}

/**
 * 创建懒加载 MDX Provider(浏览器版 fetch 路径): 首次查询时才经 loadBuffer 读文件,
 * 之后缓存实例;loadBuffer 失败每次查询都会重试(文件可能临时不可用)。
 * cfg: { id?, name, loadBuffer: () => Promise<ArrayBuffer> }
 */
export function createPathMdxProvider(cfg){
  const name = cfg.name || 'MDX 词典';
  const id = cfg.id || 'mdx:' + name;
  const fakePath = 'mdx-virtual://' + id;
  let inst = null;
  let loading = null; // 并发去重: 同一时刻只有一次加载
  async function ensure(){
    if (inst) return inst;
    if (!loading){
      loading = (async () => {
        try {
          const buffer = await cfg.loadBuffer();
          if (!(buffer instanceof ArrayBuffer)) throw new Error('loadBuffer 未返回 ArrayBuffer');
          try {
            inst = await instantiateMdx(fakePath, buffer);
          } catch (e){
            const { unregisterBuffer } = await import('./node-shims/fs.js');
            unregisterBuffer(fakePath);
            throw new Error('MDX 文件解析失败(' + name + '): ' + (e && e.message ? e.message : e));
          }
        } finally {
          loading = null;
        }
      })();
    }
    return loading;
  }
  return {
    id, name,
    isConfigured(){ return true; }, // 路径已知即视为可配置;加载失败在查询结果里报错
    async lookup(word){
      await ensure();
      if (!inst) return [];
      return buildMdxResults(inst, word, name);
    },
    isLoaded(){ return !!inst; },
    dispose(){
      import('./node-shims/fs.js').then(({ unregisterBuffer }) => unregisterBuffer(fakePath));
      inst = null;
    },
  };
}
