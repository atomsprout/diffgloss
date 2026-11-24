import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderDiffglossIcon(size: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  const half = size / 2;
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      // Rounded square SDF
      const dx = Math.max(Math.abs(x - half) - (half - radius - size * 0.04), 0);
      const dy = Math.max(Math.abs(y - half) - (half - radius - size * 0.04), 0);
      const dist = Math.hypot(dx, dy) - radius;
      if (dist > 0.5) {
        rgba[idx + 3] = 0;
        continue;
      }

      // Warm charcoal background (#141312 -> #1f1c19)
      const gradT = y / size;
      let r = Math.round(20 + gradT * 14);
      let g = Math.round(19 + gradT * 11);
      let b = Math.round(18 + gradT * 9);

      // Subtle amber rim highlight
      if (dist > -size * 0.022) {
        r = 180;
        g = 105;
        b = 32;
      }

      // Centered Diffgloss Prism Diamond (Amber top-left / Emerald bottom-right)
      const nx = (x - half) / (size * 0.29);
      const ny = (y - half) / (size * 0.29);
      const manhattan = Math.abs(nx) + Math.abs(ny);
      if (manhattan <= 1.0) {
        if (nx + ny < 0.05) {
          // Warm amber-copper facet
          r = Math.round(245 - Math.abs(nx) * 30);
          g = Math.round(158 - Math.abs(ny) * 35);
          b = 18;
        } else {
          // Forest emerald facet
          r = 22;
          g = Math.round(185 - Math.abs(ny) * 28);
          b = 110;
        }
        // Inner dark ledger notch
        if (manhattan <= 0.34) {
          r = 22;
          g = 21;
          b = 20;
        }
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  return encodePngRgba(size, size, rgba);
}

function wrapPngAsIco(pngBuf: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(1, 4); // 1 image

  const dir = Buffer.alloc(16);
  dir[0] = size >= 256 ? 0 : size;
  dir[1] = size >= 256 ? 0 : size;
  dir[2] = 0;
  dir[3] = 0;
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(pngBuf.length, 8);
  dir.writeUInt32LE(22, 12);

  return Buffer.concat([header, dir, pngBuf]);
}

const iconsDir = path.resolve(import.meta.dirname, "../src-tauri/icons");
mkdirSync(iconsDir, { recursive: true });

const png512 = renderDiffglossIcon(512);
const png256 = renderDiffglossIcon(256);
writeFileSync(path.join(iconsDir, "icon.png"), png512);
writeFileSync(path.join(iconsDir, "icon.ico"), wrapPngAsIco(png256, 256));

// Build macOS .icns via iconutil if on macOS
if (process.platform === "darwin") {
  const iconset = path.join(iconsDir, "Diffgloss.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const sizes: Array<[string, number]> = [
    ["icon_16x16.png", 16],
    ["icon_32x32.png", 32],
    ["icon_128x128.png", 128],
    ["icon_256x256.png", 256],
    ["icon_512x512.png", 512],
  ];
  for (const [name, sz] of sizes) {
    writeFileSync(path.join(iconset, name), renderDiffglossIcon(sz));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(iconsDir, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
}

console.log(`Generated Diffgloss icons in ${iconsDir}`);
