// A QR code encoder, byte mode only, error correction level M, versions 1-10
// (up to 213 bytes - a tailnet URL is about 45). Zero dependencies, because
// the agent has none and a QR library is not a reason to start.
//
// ISO/IEC 18004 throughout. Layout and zigzag follow the standard; the mask
// penalty rules are the standard's four, scored the way ZXing's MaskUtil
// scores them (for rule 3, a light run may not extend past the edge), and
// agent/test/qr.test.js checks whole symbols against ZXing's own published
// test matrices. The layout helpers take any level so those vectors, which
// are level H, can be run through the same code the page uses.
//
// Pure functions of their input: importable under node for the tests, and in
// the browser by phone.js.

const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // format-information encoding (Table 12)
// Table 9, versions 1-10: EC codewords per block, and number of blocks.
const EC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
export const MAX_VERSION = 10;

// --- Reed-Solomon over GF(256), polynomial 0x11D -------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** The `degree` error correction codewords for `data`. */
export function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// --- Capacity and codewords ----------------------------------------------

function rawModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function dataCodewordCount(ver, level) {
  return Math.floor(rawModules(ver) / 8) - EC_PER_BLOCK[level][ver - 1] * BLOCKS[level][ver - 1];
}

/** Mode indicator, count and bytes, as an array of 0/1. */
export function byteSegmentBits(bytes, ver) {
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  return bits;
}

/** Terminator, pad to a byte, pad codewords 0xEC 0x11 - to exactly `capacity` codewords. */
export function padToCodewords(bits, capacity) {
  const out = bits.slice();
  const cap = capacity * 8;
  for (let i = 0; i < 4 && out.length < cap; i += 1) out.push(0);
  while (out.length % 8) out.push(0);
  const words = [];
  for (let i = 0; i < out.length; i += 8) words.push(out.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; words.length < capacity; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Data codewords -> the final interleaved sequence of data then EC codewords. */
export function interleave(data, ver, level) {
  const numBlocks = BLOCKS[level][ver - 1];
  const ecLen = EC_PER_BLOCK[level][ver - 1];
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks) - ecLen;
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    blocks.push({ dat, ec: rsRemainder(dat, ecLen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i += 1) for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- The matrix ------------------------------------------------------------

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 17 - 7; result.length < num; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 15 format bits for a level and mask: BCH(15,5), then the 0x5412 XOR. */
export function formatBits(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits, BCH(18,6), for version 7 and up. */
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Every module of the symbol for these final codewords and this mask, as
 * rows of booleans (true = dark), [y][x].
 */
export function buildMatrix(codewords, ver, level, mask) {
  const size = ver * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));

  const drawFormat = () => {
    const bits = formatBits(level, mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);   // the dark module
  };
  drawFormat();   // reserves the cells before the data goes in
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i += 1) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, on); set(b, a, on);
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
      }
    }
  }
  const m = MASKS[mask];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y][x] && m(x, y)) dark[y][x] = !dark[y][x];
  return dark;
}

/** The standard's four penalty rules, summed. Lower is better. */
export function penalty(dark) {
  const size = dark.length;
  let score = 0;
  const at = (x, y) => dark[y][x];
  // Rule 1: runs of five or more of one colour, in rows and columns.
  for (const byCol of [false, true]) {
    for (let a = 0; a < size; a += 1) {
      let run = 0; let prev = null;
      for (let b = 0; b < size; b += 1) {
        const v = byCol ? at(a, b) : at(b, a);
        if (v === prev) run += 1; else { if (run >= 5) score += 3 + run - 5; run = 1; prev = v; }
      }
      if (run >= 5) score += 3 + run - 5;
    }
  }
  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }
  // Rule 3: 1:1:3:1:1 finder-like runs with four light modules on either side.
  const PATTERN = [true, false, true, true, true, false, true];
  // A run that would leave the symbol does not count as light (ZXing's reading).
  const lightRun = (get, from, to) => {
    if (from < 0 || to > size) return false;
    for (let k = from; k < to; k += 1) if (get(k)) return false;
    return true;
  };
  for (const byCol of [false, true]) {
    for (let a = 0; a < size; a += 1) {
      const get = byCol ? (k) => at(a, k) : (k) => at(k, a);
      for (let b = 0; b + 6 < size; b += 1) {
        if (PATTERN.every((p, k) => get(b + k) === p) && (lightRun(get, b - 4, b) || lightRun(get, b + 7, b + 11))) score += 40;
      }
    }
  }
  // Rule 4: distance of the dark share from 50%, in whole 5% steps.
  let darkCount = 0;
  for (const row of dark) for (const v of row) if (v) darkCount += 1;
  const total = size * size;
  score += Math.floor((Math.abs(darkCount * 2 - total) * 10) / total) * 10;
  return score;
}

/** Final codewords -> the lowest-penalty symbol (first mask wins a tie). */
export function bestMatrix(codewords, ver, level) {
  let best = null; let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = buildMatrix(codewords, ver, level, mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

/** `text` as UTF-8 in byte mode, level M, smallest version that fits. Throws past version 10. */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  for (let ver = 1; ver <= MAX_VERSION; ver += 1) {
    const cap = dataCodewordCount(ver, 'M');
    const bits = byteSegmentBits(bytes, ver);
    if (bits.length <= cap * 8) return bestMatrix(interleave(padToCodewords(bits, cap), ver, 'M'), ver, 'M');
  }
  throw new RangeError('too long for a version 10 QR code');
}

/**
 * The symbol as SVG markup: a light square with a 4-module quiet zone and
 * one path of dark modules. Only numbers go into it, never `text`, so it is
 * safe for innerHTML - and `label` is always a constant written in this
 * repo, never anything the agent or a user sent. No xmlns: inline SVG in HTML needs none, and a
 * namespace URL in a shipped asset would trip the no-egress test.
 */
export function qrSvg(text, label = 'QR code of the address') {
  const dark = qrMatrix(text);
  const n = dark.length + 8;
  let d = '';
  dark.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg class="qr-svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect class="qr-bg" width="${n}" height="${n}"/><path class="qr-fg" d="${d}"/></svg>`;
}
