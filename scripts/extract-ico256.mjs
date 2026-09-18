// 解析 ICO 目录，导出最大尺寸的图像条目（tauri icon 的 256px 条目是 PNG 压缩）
import { readFileSync, writeFileSync } from "node:fs";

const [, , icoPath, outPath] = process.argv;
const buf = readFileSync(icoPath);
const count = buf.readUInt16LE(4);
let best = null;
for (let i = 0; i < count; i++) {
  const e = 6 + i * 16;
  const w = buf[e] || 256;
  const size = buf.readUInt32LE(e + 8);
  const off = buf.readUInt32LE(e + 12);
  if (!best || w > best.w) best = { w, size, off };
}
console.log(`entries=${count} largest=${best.w}px bytes=${best.size}`);
const entry = buf.slice(best.off, best.off + best.size);
writeFileSync(outPath, entry);
console.log(`PNG signature: ${entry.subarray(1, 4).toString("ascii") === "PNG"}`);
