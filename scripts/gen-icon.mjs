// 生成一个简单的 512x512 纯色 PNG 作为 tauri icon 的源图
// 颜色: 渐变底 + 中央白色星形(近似), 用纯 Node(zlib) 手写 PNG,无第三方依赖
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 512, H = 512;

function crc32(buf){
  let c, table = [];
  for (let n = 0; n < 256; n++){
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 逐行构造 RGB 像素(无 alpha),filter byte = 0
const raw = Buffer.alloc(H * (1 + W * 3));
let o = 0;
const bg = [0x2a, 0x2c, 0x36];   // 面板色
const fg = [0x4f, 0x8c, 0xff];   // 主题蓝
for (let y = 0; y < H; y++){
  raw[o++] = 0; // filter: None
  for (let x = 0; x < W; x++){
    // 中心向四周的径向渐变
    const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    // 五角星区域(简单实现: 用 |sin| 近似五角)填充白色
    const star = Math.pow(Math.max(0, 1 - d), 2.5) > 0.35;
    let r = Math.round(bg[0] + (fg[0] - bg[0]) * (1 - d));
    let g = Math.round(bg[1] + (fg[1] - bg[1]) * (1 - d));
    let b = Math.round(bg[2] + (fg[2] - bg[2]) * (1 - d));
    if (star){ r = 255; g = 255; b = 255; }
    raw[o++] = Math.max(0, Math.min(255, r));
    raw[o++] = Math.max(0, Math.min(255, g));
    raw[o++] = Math.max(0, Math.min(255, b));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(new URL('../src-tauri/icons/icon-source.png', import.meta.url), png);
console.log('icon-source.png 生成完成:', png.length, 'bytes');
