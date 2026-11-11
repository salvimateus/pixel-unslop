/** One file of a ZIP archive. */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the first DOS date: a fixed time, so the same files always give the same archive bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 11: the file names are UTF-8. */
const UTF8_FLAG = 0x0800;
const VERSION = 20;

/**
 * A ZIP archive with stored (uncompressed) entries. PNG data is already compressed, so storing costs little,
 * and the writer needs no dependency. Entries keep their order.
 */
export function zipStored(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map((entry) => encoder.encode(entry.name));
  const crcs = entries.map((entry) => crc32(entry.bytes));
  let localSize = 0;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    localSize += 30 + names[i].length + entries[i].bytes.length;
    centralSize += 46 + names[i].length;
  }
  if (localSize + centralSize + 22 > 0xffffffff || entries.length > 0xffff) throw new Error('The archive is too large for a ZIP without ZIP64.');

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (let i = 0; i < entries.length; i++) {
    const { bytes } = entries[i];
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, UTF8_FLAG, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, DOS_TIME, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crcs[i], true);
    view.setUint32(at + 18, bytes.length, true);
    view.setUint32(at + 22, bytes.length, true);
    view.setUint16(at + 26, names[i].length, true);
    view.setUint16(at + 28, 0, true);
    out.set(names[i], at + 30);
    out.set(bytes, at + 30 + names[i].length);
    at += 30 + names[i].length + bytes.length;
  }
  const centralStart = at;
  for (let i = 0; i < entries.length; i++) {
    const size = entries[i].bytes.length;
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, VERSION, true);
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, size, true);
    view.setUint32(at + 24, size, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true);
  return out;
}
