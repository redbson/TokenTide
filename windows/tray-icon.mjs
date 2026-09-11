import { deflateSync } from "node:zlib";

// The Windows tray icon, drawn as PNG without a canvas. Tray icons are 16 px (at 100% scale),
// too small for the macOS readout's text, so each shown tool gets a bar filled to its
// remaining quota (amber when low); the tooltip carries the exact numbers. Before the first
// reading it shows the TokenTide mark: a "T" built from two quota bars.

export const LOW_PERCENT = 20;
const AMBER = [240, 167, 58];

// Shapes in a 16-unit square as [x, y, width, height].
const MARK = [
  { track: [1, 2, 14, 4], fill: [1, 2, 9, 4] },
  { track: [6, 7, 4, 8], fill: [6, 10, 4, 5] },
];
const BAR_LAYOUT = {
  1: { height: 6, gap: 0 },
  2: { height: 5, gap: 2 },
  3: { height: 4, gap: 2 },
};

/** RGBA pixels for the icon at `size` px; `light` is a light taskbar (dark glyph). */
export function drawTrayIcon({ items = null, size = 16, light = false } = {}) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const scale = size / 16;
  const ink = light ? [26, 26, 26] : [255, 255, 255];

  // Paints a rectangle given in 16-unit coordinates, with partial coverage at its edges.
  const rect = ([x, y, width, height], color, alpha) => {
    const [left, top, right, bottom] = [x * scale, y * scale, (x + width) * scale, (y + height) * scale];
    for (let row = Math.floor(top); row < Math.min(size, Math.ceil(bottom)); row += 1) {
      const coverY = Math.min(bottom, row + 1) - Math.max(top, row);
      for (let column = Math.floor(left); column < Math.min(size, Math.ceil(right)); column += 1) {
        const coverX = Math.min(right, column + 1) - Math.max(left, column);
        const a = alpha * coverX * coverY;
        if (a <= 0) continue;
        const index = (row * size + column) * 4;
        const under = rgba[index + 3] / 255;
        const out = a + under * (1 - a);
        for (let channel = 0; channel < 3; channel += 1) {
          rgba[index + channel] = (color[channel] * a + rgba[index + channel] * under * (1 - a)) / out;
        }
        rgba[index + 3] = out * 255;
      }
    }
  };

  const shown = (items ?? []).slice(0, 3);
  if (!shown.length) {
    for (const part of MARK) {
      rect(part.track, ink, 0.35);
      rect(part.fill, ink, 1);
    }
    return rgba;
  }

  const { height, gap } = BAR_LAYOUT[shown.length];
  let y = (16 - (height * shown.length + gap * (shown.length - 1))) / 2;
  for (const item of shown) {
    const remaining = Number.isFinite(item?.remaining) ? Math.min(100, Math.max(0, item.remaining)) : null;
    rect([0, y, 16, height], ink, 0.3);
    if (remaining !== null) {
      // An empty quota keeps an amber sliver, so it differs from a tool without a reading.
      rect([0, y, Math.max(1, (16 * remaining) / 100), height], remaining < LOW_PERCENT ? AMBER : ink, 1);
    }
    y += height + gap;
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixels as a PNG. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    rows[row * (width * 4 + 1)] = 0; // filter: none
    rows.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderTrayIcon(options = {}) {
  const size = options.size ?? 16;
  return encodePng(size, size, drawTrayIcon({ ...options, size }));
}
