/** TomDown-green PNG icons for TubeBox. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([t, data]));
  crc.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const cx = x + 0.5 - size / 2;
      const cy = y + 0.5 - size / 2;
      const r = Math.sqrt(cx * cx + cy * cy);
      const rad = size * 0.42;
      const inside = r <= rad;
      const m = size * 0.18;
      const inSq = x >= m && x < size - m && y >= m && y < size - m;
      if (inside || inSq) {
        raw[i] = rgba[0];
        raw[i + 1] = rgba[1];
        raw[i + 2] = rgba[2];
        raw[i + 3] = 255;
        if (x > size * 0.38 && x < size * 0.72 && Math.abs(cy) < (x - size * 0.35) * 0.9) {
          raw[i] = 236;
          raw[i + 1] = 253;
          raw[i + 2] = 245;
        }
      } else {
        raw[i] = 0;
        raw[i + 1] = 0;
        raw[i + 2] = 0;
        raw[i + 3] = 0;
      }
    }
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// TomDown primary #10B981
const green = [16, 185, 129];
for (const s of [16, 48, 128]) {
  const file = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(file, png(s, green));
  console.log('wrote', file);
}
