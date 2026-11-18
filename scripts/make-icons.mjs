// Draws the app icon (a white house on navy) and writes the PNGs into public/icons.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BG = [0x1d, 0x4e, 0x89], FG = [0xff, 0xff, 0xff], DOOR = [0xf2, 0xa6, 0x3b];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = ~0; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/* Shapes in a 0..1 square, kept inside the middle 60% so maskable crops don't clip them. */
function colourAt(x, y) {
  const inRoof = y >= 0.24 && y <= 0.47 && Math.abs(x - 0.5) <= (y - 0.24) * (0.29 / 0.23);
  const inBody = x >= 0.3 && x <= 0.7 && y >= 0.45 && y <= 0.76;
  const inChimney = x >= 0.6 && x <= 0.66 && y >= 0.27 && y <= 0.4;
  const inDoor = x >= 0.45 && x <= 0.55 && y >= 0.6 && y <= 0.76;
  if (inDoor) return DOOR;
  if (inRoof || inBody || inChimney) return FG;
  return BG;
}

function png(size) {
  const ss = 4, rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = colourAt((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
        sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
      }
      for (let i = 0; i < 3; i++) row[1 + px * 3 + i] = Math.round(sum[i] / (ss * ss));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(`public/icons/${name}`, png(size));
}
console.log("Icons written to public/icons");
