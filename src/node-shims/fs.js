// fs shim — js-mdict@6(MIT) 是 Node 库(文件路径 + openSync/readSync)。
// 浏览器/webview 里没有 fs:把用户选择的 .mdx 文件读成 ArrayBuffer 注册进来,
// 用虚拟路径模拟它用到的最小 fs 接口。仅实现 js-mdict FileScanner 用到的方法。
// 运行: node --test tests/mdx.test.mjs

// 注册表挂在 globalThis: vite 依赖预打包可能让本模块产生多实例,
// 全局唯一注册表保证"注册文件的实例"与"js-mdict 用的实例"看到同一份数据。
const G = typeof globalThis !== 'undefined' ? globalThis : {};
if (!G.__mdictFsShimRegistry){
  G.__mdictFsShimRegistry = { buffers: new Map(), fds: new Map(), nextFd: 1 };
}
const buffers = G.__mdictFsShimRegistry.buffers; // 虚拟路径 -> ArrayBuffer
const fds = G.__mdictFsShimRegistry.fds;          // fd -> ArrayBuffer

/** 注册内存文件(词典加载时调用);返回虚拟路径 */
export function registerBuffer(fakePath, arrayBuffer){
  if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error('registerBuffer 需要 ArrayBuffer');
  buffers.set(fakePath, arrayBuffer);
  return fakePath;
}

export function unregisterBuffer(fakePath){ buffers.delete(fakePath); }

export function openSync(path){
  const buf = buffers.get(path);
  if (!buf) throw new Error('fs shim: 未注册的文件路径 ' + path);
  const fd = G.__mdictFsShimRegistry.nextFd++;
  fds.set(fd, buf);
  return fd;
}

export function closeSync(fd){ fds.delete(fd); }

/** 读到 Uint8Array 或 DataView(js-mdict 两种都用) */
export function readSync(fd, target, opts){
  const rec = fds.get(fd);
  if (!rec) throw new Error('fs shim: 无效 fd ' + fd);
  const o = opts || {};
  const start = o.position == null ? 0 : Number(o.position); // 可能是 BigInt → Number
  let out, off, len;
  if (target instanceof Uint8Array){
    out = target;
    off = o.offset || 0;
    len = o.length;
  } else if (target && typeof target === 'object' && target.buffer instanceof ArrayBuffer){
    out = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    off = 0;
    len = o.length == null ? target.byteLength : o.length;
  } else {
    throw new Error('fs shim: readSync 不支持的目标类型');
  }
  if (len == null) len = out.length - off;
  const avail = Math.max(0, Math.min(len, rec.byteLength - start));
  if (avail > 0) out.set(new Uint8Array(rec, start, avail), off);
  return avail;
}

export default { openSync, readSync, closeSync };
