// 启动图标生成（纯 Node，无第三方依赖）：48x48 蓝底白圆 PNG
// 产物：res/mipmap-mdpi/ic_launcher.png 与 ic_launcher_round.png（同一张图，Android 按密度自适应缩放）
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 48, H = 48;
const BG = [0x0a, 0x6f, 0xe0]; // --accent-strong
const FG = [0xff, 0xff, 0xff];

// CRC32（PNG chunk 校验要求）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, pixels /* Uint8Array w*h*3 RGB */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前置 filter byte 0（None）
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    pixels.copy(row, 1, y * w * 3, (y + 1) * w * 3);
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const pixels = Buffer.alloc(W * H * 3);
const cx = (W - 1) / 2, cy = (H - 1) / 2;
const rOuter = 16.5, rInner = 8.0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    const col = (d2 <= rInner * rInner) ? BG : (d2 <= rOuter * rOuter ? FG : BG); // 白色环带 + 蓝心
    const o = (y * W + x) * 3;
    pixels[o] = col[0]; pixels[o + 1] = col[1]; pixels[o + 2] = col[2];
  }
}

const outDir = path.resolve(__dirname, '..', 'res', 'mipmap-mdpi');
fs.mkdirSync(outDir, { recursive: true });
for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, makePng(W, H, pixels));
  console.log(name + ' ' + fs.statSync(p).size + ' bytes');
}
