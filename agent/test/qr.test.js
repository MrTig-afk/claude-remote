// agent/public/qr.js - the zero-dependency QR encoder behind the phone screen.
//
// REFERENCE VECTORS, all from ZXing's own encoder test suite (Apache-2.0),
// github.com/zxing/zxing, core/src/test/java/com/google/zxing/qrcode/encoder/:
//   - EncoderTestCase.testGenerateECBytes: three Reed-Solomon examples,
//     which ZXing takes from swetake.com/qr/qr3.html and qr9.html.
//   - EncoderTestCase.testInterleaveWithECBytes: version 5-Q, four blocks of
//     two lengths (swetake.com/qr/qr8.html).
//   - MatrixUtilTestCase.testBuildMatrix: a whole 1-H symbol with mask 3
//     from given codewords (swetake.com/qr/qr7.html) - placement, finder,
//     timing, format bits and masking, with no mask choice involved.
//   - EncoderTestCase.testEncode ("ABCDEF", 1-H, ZXing chose mask 0),
//     testSimpleUTF8ECI ("hello", 1-H, byte mode, mask 3) and
//     testEncodeShiftjisNumeric ("0123", 1-M, mask 0): whole symbols where
//     the MASK IS CHOSEN by penalty, so they pin the penalty rules too.
// The data codewords for those three are built here from the standard's
// mode rules; the encoder's own byte-mode path is what the phone uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  rsRemainder, interleave, buildMatrix, bestMatrix, byteSegmentBits, padToCodewords,
  dataCodewordCount, formatBits, versionBits, qrMatrix, qrSvg,
} from '../public/qr.js';

const grid = (s) => s.trim().split('\n').map((line) => line.trim().split(' ').map((c) => c === '1'));
const bitsOf = (value, len) => Array.from({ length: len }, (_, i) => (value >>> (len - 1 - i)) & 1);

test('Reed-Solomon: the three ZXing/swetake examples', () => {
  assert.deepEqual(rsRemainder([32, 65, 205, 69, 41, 220, 46, 128, 236], 17),
    [42, 159, 74, 221, 244, 169, 239, 150, 138, 70, 237, 85, 224, 96, 74, 219, 61]);
  assert.deepEqual(rsRemainder([67, 70, 22, 38, 54, 70, 86, 102, 118, 134, 150, 166, 182, 198, 214], 18),
    [175, 80, 155, 64, 178, 45, 214, 233, 65, 209, 12, 155, 117, 31, 140, 214, 27, 187]);
  // The high-order zero coefficient case.
  assert.deepEqual(rsRemainder([32, 49, 205, 69, 42, 20, 0, 236, 17], 17),
    [0, 3, 130, 179, 194, 0, 55, 211, 110, 79, 98, 72, 170, 96, 211, 137, 213]);
});

test('interleaving: version 5-Q, two short and two long blocks', () => {
  const data = [
    67, 70, 22, 38, 54, 70, 86, 102, 118, 134, 150, 166, 182, 198, 214, 230, 247, 7, 23, 39, 55, 71, 87, 103, 119, 135,
    151, 166, 22, 38, 54, 70, 86, 102, 118, 134, 150, 166, 182, 198, 214, 230, 247, 7, 23, 39, 55, 71, 87, 103, 119,
    135, 151, 160, 236, 17, 236, 17, 236, 17, 236, 17,
  ];
  assert.equal(dataCodewordCount(5, 'Q'), data.length);
  assert.deepEqual(interleave(data, 5, 'Q'), [
    67, 230, 54, 55, 70, 247, 70, 71, 22, 7, 86, 87, 38, 23, 102, 103, 54, 39, 118, 119, 70, 55, 134, 135, 86, 71, 150,
    151, 102, 87, 166, 160, 118, 103, 182, 236, 134, 119, 198, 17, 150, 135, 214, 236, 166, 151, 230, 17, 182, 166, 247,
    236, 198, 22, 7, 17, 214, 38, 23, 236, 39, 17,
    175, 155, 245, 236, 80, 146, 56, 74, 155, 165, 133, 142, 64, 183, 132, 13, 178, 54, 132, 108, 45, 113, 53, 50, 214,
    98, 193, 152, 233, 147, 50, 71, 65, 190, 82, 51, 209, 199, 171, 54, 12, 112, 57, 113, 155, 117, 211, 164, 117, 30,
    158, 225, 31, 190, 242, 38, 140, 61, 179, 154, 214, 138, 147, 87, 27, 96, 77, 47, 187, 49, 156, 214,
  ]);
});

test('a whole 1-H symbol, mask 3 given: ZXing MatrixUtilTestCase.testBuildMatrix', () => {
  const codewords = [32, 65, 205, 69, 41, 220, 46, 128, 236,
    42, 159, 74, 221, 244, 169, 239, 150, 138, 70, 237, 85, 224, 96, 74, 219, 61];
  assert.deepEqual(buildMatrix(codewords, 1, 'H', 3), grid(`
1 1 1 1 1 1 1 0 0 1 1 0 0 0 1 1 1 1 1 1 1
1 0 0 0 0 0 1 0 0 0 0 0 0 0 1 0 0 0 0 0 1
1 0 1 1 1 0 1 0 0 0 0 1 0 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 0 1 1 0 0 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 1 1 0 0 1 0 1 0 1 1 1 0 1
1 0 0 0 0 0 1 0 0 0 1 1 1 0 1 0 0 0 0 0 1
1 1 1 1 1 1 1 0 1 0 1 0 1 0 1 1 1 1 1 1 1
0 0 0 0 0 0 0 0 1 1 0 1 1 0 0 0 0 0 0 0 0
0 0 1 1 0 0 1 1 1 0 0 1 1 1 1 0 1 0 0 0 0
1 0 1 0 1 0 0 0 0 0 1 1 1 0 0 1 0 1 1 1 0
1 1 1 1 0 1 1 0 1 0 1 1 1 0 0 1 1 1 0 1 0
1 0 1 0 1 1 0 1 1 1 0 0 1 1 1 0 0 1 0 1 0
0 0 1 0 0 1 1 1 0 0 0 0 0 0 1 0 1 1 1 1 1
0 0 0 0 0 0 0 0 1 1 0 1 0 0 0 0 0 1 0 1 1
1 1 1 1 1 1 1 0 1 1 1 1 0 0 0 0 1 0 1 1 0
1 0 0 0 0 0 1 0 0 0 0 1 0 1 1 1 0 0 0 0 0
1 0 1 1 1 0 1 0 0 1 0 0 1 1 0 0 1 0 0 1 1
1 0 1 1 1 0 1 0 1 1 0 1 0 0 0 0 0 1 1 1 0
1 0 1 1 1 0 1 0 1 1 1 1 0 0 0 0 1 1 1 0 0
1 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 1 0 1 0 0
1 1 1 1 1 1 1 0 0 0 1 1 1 1 1 0 1 0 0 1 0`));
});

test('mask chosen by penalty: "ABCDEF", 1-H (ZXing testEncode, mask 0)', () => {
  // Alphanumeric: 0010, count 6, AB CD EF as 11-bit pairs, terminator, pad.
  const data = [32, 49, 205, 69, 42, 20, 0, 236, 17];
  assert.deepEqual(bestMatrix(interleave(data, 1, 'H'), 1, 'H'), grid(`
1 1 1 1 1 1 1 0 1 1 1 1 0 0 1 1 1 1 1 1 1
1 0 0 0 0 0 1 0 0 1 1 1 0 0 1 0 0 0 0 0 1
1 0 1 1 1 0 1 0 0 1 0 1 1 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 1 1 1 0 1 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 0 1 1 1 0 0 1 0 1 1 1 0 1
1 0 0 0 0 0 1 0 0 1 0 0 0 0 1 0 0 0 0 0 1
1 1 1 1 1 1 1 0 1 0 1 0 1 0 1 1 1 1 1 1 1
0 0 0 0 0 0 0 0 0 0 1 0 1 0 0 0 0 0 0 0 0
0 0 1 0 1 1 1 0 1 1 0 0 1 1 0 0 0 1 0 0 1
1 0 1 1 1 0 0 1 0 0 0 1 0 1 0 0 0 0 0 0 0
0 0 1 1 0 0 1 0 1 0 0 0 1 0 1 0 1 0 1 1 0
1 1 0 1 0 1 0 1 1 1 0 1 0 1 0 0 0 0 0 1 0
0 0 1 1 0 1 1 1 1 0 0 0 1 0 1 0 1 1 1 1 0
0 0 0 0 0 0 0 0 1 0 0 1 1 1 0 1 0 1 0 0 0
1 1 1 1 1 1 1 0 0 0 1 0 1 0 1 1 0 0 0 0 1
1 0 0 0 0 0 1 0 1 1 1 1 0 1 0 1 1 1 1 0 1
1 0 1 1 1 0 1 0 1 0 1 1 0 1 0 1 0 0 0 0 1
1 0 1 1 1 0 1 0 0 1 1 0 1 1 1 1 0 1 0 1 0
1 0 1 1 1 0 1 0 1 0 0 0 1 0 1 0 1 1 1 0 1
1 0 0 0 0 0 1 0 0 1 1 0 1 1 0 1 0 0 0 1 1
1 1 1 1 1 1 1 0 0 0 0 0 0 0 0 0 1 0 1 0 1`));
});

test('byte mode, mask chosen: "hello" behind a UTF-8 ECI, 1-H (ZXing testSimpleUTF8ECI, mask 3)', () => {
  const bytes = Array.from(new TextEncoder().encode('hello'));
  // ECI 0111 + designator 26 (UTF-8), then this encoder's own byte segment.
  const bits = [...bitsOf(0b0111, 4), ...bitsOf(26, 8), ...byteSegmentBits(bytes, 1)];
  const data = padToCodewords(bits, dataCodewordCount(1, 'H'));
  assert.deepEqual(bestMatrix(interleave(data, 1, 'H'), 1, 'H'), grid(`
1 1 1 1 1 1 1 0 0 0 0 0 0 0 1 1 1 1 1 1 1
1 0 0 0 0 0 1 0 0 0 1 0 1 0 1 0 0 0 0 0 1
1 0 1 1 1 0 1 0 0 1 0 1 0 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 0 1 1 0 1 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 1 0 1 0 1 0 1 0 1 1 1 0 1
1 0 0 0 0 0 1 0 0 0 0 0 1 0 1 0 0 0 0 0 1
1 1 1 1 1 1 1 0 1 0 1 0 1 0 1 1 1 1 1 1 1
0 0 0 0 0 0 0 0 1 1 1 0 0 0 0 0 0 0 0 0 0
0 0 1 1 0 0 1 1 1 1 0 0 0 1 1 0 1 0 0 0 0
0 0 1 1 1 0 0 0 0 0 1 1 0 0 0 1 0 1 1 1 0
0 1 0 1 0 1 1 1 0 1 0 1 0 0 0 0 0 1 1 1 1
1 1 0 0 1 0 0 1 1 0 0 1 1 1 1 0 1 0 1 1 0
0 0 0 0 1 0 1 1 1 1 0 0 0 0 0 1 0 0 1 0 0
0 0 0 0 0 0 0 0 1 1 1 1 0 0 1 1 1 0 0 0 1
1 1 1 1 1 1 1 0 1 1 1 0 1 0 1 1 0 0 1 0 0
1 0 0 0 0 0 1 0 0 0 1 0 0 1 1 1 1 1 1 0 1
1 0 1 1 1 0 1 0 0 1 0 0 0 0 1 1 0 0 0 0 0
1 0 1 1 1 0 1 0 1 1 1 0 1 0 0 0 1 1 0 0 0
1 0 1 1 1 0 1 0 1 1 0 0 0 1 0 0 1 0 0 0 0
1 0 0 0 0 0 1 0 0 0 0 1 1 0 1 0 1 0 1 1 0
1 1 1 1 1 1 1 0 0 1 0 1 1 1 0 1 1 0 0 0 0`));
});

test('level M, mask chosen: "0123" numeric, 1-M (ZXing testEncodeShiftjisNumeric, mask 0)', () => {
  // Numeric: 0001, count 4 (10 bits), "012" in 10 bits, "3" in 4.
  const bits = [...bitsOf(1, 4), ...bitsOf(4, 10), ...bitsOf(12, 10), ...bitsOf(3, 4)];
  const data = padToCodewords(bits, dataCodewordCount(1, 'M'));
  assert.deepEqual(bestMatrix(interleave(data, 1, 'M'), 1, 'M'), grid(`
1 1 1 1 1 1 1 0 0 0 0 0 1 0 1 1 1 1 1 1 1
1 0 0 0 0 0 1 0 1 1 0 1 0 0 1 0 0 0 0 0 1
1 0 1 1 1 0 1 0 0 1 1 0 0 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 0 0 1 0 0 0 1 0 1 1 1 0 1
1 0 1 1 1 0 1 0 1 0 1 1 1 0 1 0 1 1 1 0 1
1 0 0 0 0 0 1 0 0 1 0 1 0 0 1 0 0 0 0 0 1
1 1 1 1 1 1 1 0 1 0 1 0 1 0 1 1 1 1 1 1 1
0 0 0 0 0 0 0 0 0 1 1 0 0 0 0 0 0 0 0 0 0
1 0 1 0 1 0 1 0 0 0 0 0 1 0 0 0 1 0 0 1 0
0 0 0 0 0 0 0 1 1 0 1 1 0 1 0 1 0 1 0 1 0
0 1 0 1 0 1 1 1 1 0 0 1 0 1 1 1 0 1 0 1 0
0 1 1 1 0 0 0 0 0 0 1 1 1 1 0 1 1 1 0 1 0
0 0 0 1 1 1 1 1 1 1 1 1 0 1 1 1 0 0 1 0 1
0 0 0 0 0 0 0 0 1 1 0 0 0 0 1 0 0 0 1 1 0
1 1 1 1 1 1 1 0 0 1 0 0 1 0 0 0 1 0 0 0 1
1 0 0 0 0 0 1 0 0 1 0 0 0 0 1 0 0 0 1 0 0
1 0 1 1 1 0 1 0 1 1 0 0 1 0 1 0 1 0 1 0 1
1 0 1 1 1 0 1 0 0 1 1 1 0 1 0 1 0 1 0 1 0
1 0 1 1 1 0 1 0 1 0 1 1 0 1 1 1 0 1 1 0 1
1 0 0 0 0 0 1 0 0 0 1 1 1 1 0 1 1 1 0 0 0
1 1 1 1 1 1 1 0 1 0 1 1 0 1 1 1 0 1 1 0 1`));
});

test('format and version information: ISO/IEC 18004 Annex C and D examples', () => {
  // Annex C: level M, mask 101 -> 100000011001110 after masking.
  assert.equal(formatBits('M', 5), 0b100000011001110);
  // Annex D: version 7 -> 000111110010010100.
  assert.equal(versionBits(7), 0b000111110010010100);
});

test('capacity at level M matches the standard for versions 1-10', () => {
  // Table 7, level M, byte mode: 14 26 42 62 84 106 122 152 180 213 characters.
  const bytes = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  bytes.forEach((n, i) => {
    const ver = i + 1;
    assert.ok(byteSegmentBits(new Array(n).fill(0x61), ver).length <= dataCodewordCount(ver, 'M') * 8, `v${ver} fits ${n}`);
    assert.ok(byteSegmentBits(new Array(n + 1).fill(0x61), ver).length > dataCodewordCount(ver, 'M') * 8, `v${ver} not ${n + 1}`);
  });
});

test('qrMatrix picks the smallest version, and refuses past version 10', () => {
  assert.equal(qrMatrix('a'.repeat(14)).length, 21);
  assert.equal(qrMatrix('a'.repeat(15)).length, 25);
  // A realistic tailnet URL: 46 bytes -> version 4 (33 modules).
  assert.equal(qrMatrix('https://desktop-abc1234.tail1a2b3c.ts.net:8790').length, 33);
  assert.equal(qrMatrix('a'.repeat(213)).length, 57);
  assert.throws(() => qrMatrix('a'.repeat(214)), RangeError);
});

test('a version 7+ symbol carries the version blocks in both corners', () => {
  const m = qrMatrix('a'.repeat(130));   // version 8
  const size = m.length;
  assert.equal(size, 49);
  const bits = versionBits(8);
  for (let i = 0; i < 18; i += 1) {
    const on = ((bits >>> i) & 1) === 1;
    assert.equal(m[Math.floor(i / 3)][size - 11 + (i % 3)], on);
    assert.equal(m[size - 11 + (i % 3)][Math.floor(i / 3)], on);
  }
});

test('qrSvg: numbers only, a quiet zone, and one dark square per dark module', () => {
  const url = 'https://desktop-abc1234.tail1a2b3c.ts.net:8790';
  const svg = qrSvg(url);
  const m = qrMatrix(url);
  const n = m.length + 8;
  assert.ok(svg.startsWith(`<svg class="qr-svg" viewBox="0 0 ${n} ${n}"`));
  assert.ok(!svg.includes(url) && !svg.includes('http'), 'the text itself never reaches the markup');
  const darkCount = m.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, darkCount);
  assert.ok(svg.includes(`M${4} ${4}h1v1h-1z`), 'the top-left finder starts at the quiet-zone offset');
});
