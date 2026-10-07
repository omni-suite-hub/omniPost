/**
 * 零依赖 ZIP 写入器（Service Worker 可用）。
 *
 * 对齐"文章同步助手"的 zip-download 能力，但不引入 JSZip：
 * - STORE 方式（不压缩）：实现简单可靠，图片本身已是压缩格式，体积差异可忽略；
 * - CRC-32 复用 aws4.ts 的 crc32；
 * - 文件名 UTF-8 编码（general purpose bit 11 置位），中文文件名兼容主流解压工具；
 * - 输出完整 ZIP：Local File Header + 数据 + Central Directory + EOCD。
 */

import { crc32 } from './aws4';

export interface ZipEntry {
  /** 包内路径，如 'article.md' / 'images/image_001.png'（UTF-8） */
  name: string;
  /** 文件原始字节（STORE 不压缩） */
  data: Uint8Array;
  /** 可选 unix 权限（默认 0o100644）；目录项请用 buildZipDirectoryEntry */
  unixMode?: number;
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
/** UTF-8 文件名标志位 */
const FLAG_UTF8 = 0x0800;
/** STORE（不压缩） */
const METHOD_STORE = 0;

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 目录条目（zip 工具按文件夹展示） */
export function buildZipDirectoryEntry(name: string): ZipEntry {
  const dir = name.endsWith('/') ? name : name + '/';
  return { name: dir, data: new Uint8Array(0), unixMode: 0o40755 };
}

/**
 * 将条目列表序列化为完整 ZIP 字节流。
 * 顺序：每个条目的 local header + 数据 → 中央目录 → EOCD。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = parseInt(crc32(data), 16) >>> 0;

    // ---- Local File Header（30 字节 + 文件名）----
    const localView = new DataView(new ArrayBuffer(30 + nameBytes.length));
    localView.setUint32(0, ZIP_LOCAL_SIG, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true); // compressed size（STORE = 原长）
    localView.setUint32(22, data.length, true); // uncompressed size
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // extra field length
    const localBytes = new Uint8Array(localView.buffer);
    localBytes.set(nameBytes, 30);
    locals.push(localBytes, data);

    // ---- Central Directory File Header（46 字节 + 文件名）----
    const centralView = new DataView(new ArrayBuffer(46 + nameBytes.length));
    centralView.setUint32(0, ZIP_CENTRAL_SIG, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, FLAG_UTF8, true);
    centralView.setUint16(10, METHOD_STORE, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // extra length
    centralView.setUint16(32, 0, true); // comment length
    centralView.setUint16(34, 0, true); // disk number start
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, (entry.unixMode ?? 0o100644) << 16, true); // external attrs
    centralView.setUint32(42, offset, true); // local header offset
    const centralBytes = new Uint8Array(centralView.buffer);
    centralBytes.set(nameBytes, 46);
    centrals.push(centralBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  // ---- End of Central Directory（22 字节）----
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocdView = new DataView(new ArrayBuffer(22));
  eocdView.setUint32(0, ZIP_EOCD_SIG, true);
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // disk with central dir
  eocdView.setUint16(8, entries.length, true); // entries on this disk
  eocdView.setUint16(10, entries.length, true); // total entries
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true); // central dir offset
  eocdView.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...locals, ...centrals, new Uint8Array(eocdView.buffer)]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
