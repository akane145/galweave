import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// js-mdict@6(MIT) 是 Node 库,浏览器里用 shims 顶替它依赖的 node:fs / zlib / assert
const shim = (p) => fileURLToPath(new URL(p, import.meta.url));

// Tauri v2 官方推荐配置: 固定端口、关闭 clearScreen、忽略 src-tauri 的 rust 文件变化
// build:html (--mode single) → 单文件 HTML(浏览器版,免安装),输出到 dist-single/ 避免与普通构建互相覆盖
export default defineConfig(({ mode }) => ({
  plugins: mode === "single" ? [viteSingleFile()] : [],
  resolve: {
    alias: [
      { find: /^(node:)?fs$/, replacement: shim("./src/node-shims/fs.js") },
      { find: /^(node:)?zlib$/, replacement: shim("./src/node-shims/zlib.js") },
      { find: /^(node:)?assert$/, replacement: shim("./src/node-shims/assert.js") },
    ],
  },
  // Worker 配置: 确保 search/recognize worker 在 dev 与 build:html 下都用 ESM 打包
  worker: { format: 'es' },
  // js-mdict 不预打包: 预打包会把它依赖的 node:fs 内联成独立 shim 副本,
  // 与源码里的 shim 实例分离,导致虚拟路径注册表对不上
  optimizeDeps: {
    exclude: ["js-mdict"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 2048,
    outDir: mode === "single" ? "dist-single" : "dist",
  },
}));
