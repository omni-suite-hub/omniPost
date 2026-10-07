/**
 * 零依赖 MD5 实现（Service Worker 环境）。
 *
 * 知乎图床上传需要 image_hash = 图片字节的 MD5；Web Crypto 不提供 MD5，
 * 故内置经典 MD5（RFC 1321 算法，标准的 64 轮循环 + 小端字节序）。
 *
 * 正确性由单元测试锚定（空串 / "abc" / 长文本等已知向量）。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 * |sin(i+1)|)，标准常量表
const K: number[] = [];
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** 计算 Uint8Array 的 MD5，返回 32 位小写十六进制串 */
export function md5Hex(bytes: Uint8Array): string {
  const bitLenLo = (bytes.length * 8) >>> 0;
  const bitLenHi = Math.floor(bytes.length / 0x20000000); // bytes*8 的高 32 位

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，再补 8 字节长度
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenLo, true);
  dv.setUint32(paddedLen - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < paddedLen; off += 64) {
    const M: number[] = new Array(16);
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      M[i] = (padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24)) >>> 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const words = [a0, b0, c0, d0];
  let hex = '';
  for (const w of words) {
    hex +=
      (w & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 8) & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 16) & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 24) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** 便捷：字符串 → MD5（utf-8 编码） */
export function md5HexOfString(str: string): string {
  return md5Hex(new TextEncoder().encode(str));
}
