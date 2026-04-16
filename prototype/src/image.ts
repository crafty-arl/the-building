/**
 * Minimal PNG renderer — no deps. Exists to prove `sight.scry`: we can
 * synthesize a tiny image from scene state and hand it to Kimi's vision
 * input for actual visual interpretation.
 *
 * The image is intentionally small (64×64, flat palette) so the scan
 * is cheap and the content is describable. Scene state drives pixels —
 * doorBolted adds a bright horizontal bolt on the door; candleLit adds
 * a warm halo in the center.
 */

import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (table[(crc ^ b) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export interface SceneImageState {
  candleLit: boolean;
  doorBolted: boolean;
}

export function renderTavernScenePng(state: SceneImageState): string {
  const W = 64;
  const H = 64;
  const row = 1 + W * 3;
  const buf = Buffer.alloc(row * H);

  for (let y = 0; y < H; y++) {
    buf[y * row] = 0; // PNG filter: None
    for (let x = 0; x < W; x++) {
      let r = 28;
      let g = 22;
      let b = 32; // dusk tavern interior

      // floor — warmer, lower half
      if (y > H * 0.72) {
        r = 52;
        g = 36;
        b = 28;
      }

      // candle on a table, left-of-center
      const cx = W * 0.32;
      const cy = H * 0.55;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (state.candleLit) {
        if (d < 3) {
          r = 255;
          g = 240;
          b = 140;
        } else if (d < 7) {
          r = 230;
          g = 170;
          b = 70;
        } else if (d < 14) {
          const t = (14 - d) / 7;
          r = Math.min(255, Math.round(r + 140 * t));
          g = Math.min(255, Math.round(g + 90 * t));
          b = Math.min(255, Math.round(b + 30 * t));
        }
      } else {
        // unlit stub
        if (d < 2) {
          r = 60;
          g = 55;
          b = 48;
        }
      }

      // door on right side of frame
      if (x > W * 0.72 && x < W * 0.93 && y > H * 0.18 && y < H * 0.9) {
        r = 66;
        g = 44;
        b = 30;
        // door frame shadow
        if (x < W * 0.74 || x > W * 0.91 || y < H * 0.2 || y > H * 0.88) {
          r = 38;
          g = 22;
          b = 16;
        }
      }

      // bolt — bright horizontal bar across door, only if bolted
      if (
        state.doorBolted &&
        x > W * 0.72 &&
        x < W * 0.93 &&
        Math.abs(y - H * 0.56) < 1.2
      ) {
        r = 180;
        g = 180;
        b = 195;
      }

      buf[y * row + 1 + x * 3] = r;
      buf[y * row + 2 + x * 3] = g;
      buf[y * row + 3 + x * 3] = b;
    }
  }

  const idat = deflateSync(buf);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}
