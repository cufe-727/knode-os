import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Reading entries out of a zip archive (an EPUB is one), without a library
 * and without loading the archive: the central directory says where each
 * entry is, and only the entries asked for are read and inflated. A 170 MB
 * photo book costs the few hundred kilobytes of its text.
 *
 * Stored and deflated entries are read, ZIP64 sizes and offsets included;
 * an encrypted entry, or another compression method, is refused by name. An
 * archive whose directory is missing or cut short — a download that stopped
 * before the end — is read from its local headers in order instead, and says
 * so (`recovered`): every entry written in full is still there.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;

/** One entry is never inflated past this, whatever its header claims (a zip bomb stops here). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
  /** Where its data starts, when the local header has already been read (a recovered archive). */
  dataOffset?: number;
}

export interface ZipArchive {
  /** By name, in the order the archive lists them. */
  readonly entries: Map<string, ZipEntry>;
  /** The central directory was missing or damaged: the entries come from the local headers. */
  readonly recovered: boolean;
  /** An entry by its exact name, else by the same name in another case (a package that spells a path differently from the archive). */
  find(name: string): ZipEntry | undefined;
  /** The entry's bytes, inflated. */
  read(entry: string | ZipEntry, maxBytes?: number): Buffer;
  close(): void;
}

function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // an archive made on a Chinese Windows names its entries in GBK, without saying so
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  }
}

class Reader {
  constructor(private readonly fd: number, readonly size: number) {}

  bytes(at: number, length: number): Buffer {
    if (at < 0 || length < 0 || at + length > this.size) throw new ZipError('the archive ends before an entry it lists');
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(this.fd, buf, done, length - done, at + done);
      if (n <= 0) throw new ZipError('the archive ends before an entry it lists');
      done += n;
    }
    return buf;
  }
}

/** The end-of-central-directory record: where the directory is and how many entries it holds. Null when there is none. */
function findDirectory(reader: Reader): { offset: number; size: number; count: number } | null {
  const tail = Math.min(reader.size, 22 + 0xffff);
  if (tail < 22) return null;
  const buf = reader.bytes(reader.size - tail, tail);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== END) continue;
    const at = reader.size - tail + i;
    let count = buf.readUInt16LE(i + 10);
    let size = buf.readUInt32LE(i + 12);
    let offset = buf.readUInt32LE(i + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      if (i < 20 || buf.readUInt32LE(i - 20) !== END64_LOCATOR) return null;
      const end64At = Number(buf.readBigUInt64LE(i - 20 + 8));
      const end64 = reader.bytes(end64At, 56);
      if (end64.readUInt32LE(0) !== END64) return null;
      count = Number(end64.readBigUInt64LE(32));
      size = Number(end64.readBigUInt64LE(40));
      offset = Number(end64.readBigUInt64LE(48));
    }
    if (offset + size > at) return null;
    return { offset, size, count };
  }
  return null;
}

function readDirectory(reader: Reader, dir: { offset: number; size: number; count: number }): ZipEntry[] {
  const buf = reader.bytes(dir.offset, dir.size);
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= buf.length && out.length < dir.count) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('damaged central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLength), (flags & 0x800) !== 0);
    // ZIP64: the sizes and offset that did not fit are in extra field 0x0001, in this order
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const next = (): number | null => {
          if (q + 8 > e + 4 + len) return null;
          const value = Number(buf.readBigUInt64LE(q));
          q += 8;
          return value;
        };
        if (size === 0xffffffff) size = next() ?? size;
        if (compressedSize === 0xffffffff) compressedSize = next() ?? compressedSize;
        if (offset === 0xffffffff) offset = next() ?? offset;
      }
      e += 4 + len;
    }
    out.push({ name, method, flags, compressedSize, size, offset });
    p = extraEnd + commentLength;
  }
  if (out.length === 0 && dir.count > 0) throw new ZipError('damaged central directory');
  return out;
}

/**
 * The entries written in full, from the local headers in order — for an
 * archive whose directory is gone. An entry whose sizes come after its data
 * (bit 3) runs to the next local header.
 */
function scanLocalHeaders(reader: Reader): ZipEntry[] {
  const all = reader.bytes(0, reader.size);
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 30 <= all.length && all.readUInt32LE(p) === LOCAL) {
    const flags = all.readUInt16LE(p + 6);
    const method = all.readUInt16LE(p + 8);
    let compressedSize = all.readUInt32LE(p + 18);
    const size = all.readUInt32LE(p + 22);
    const nameLength = all.readUInt16LE(p + 26);
    const extraLength = all.readUInt16LE(p + 28);
    const dataOffset = p + 30 + nameLength + extraLength;
    if (dataOffset > all.length) break;
    const name = decodeName(all.subarray(p + 30, p + 30 + nameLength), (flags & 0x800) !== 0);
    let next: number;
    if (flags & 0x8) {
      const at = all.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataOffset);
      next = at < 0 ? all.length : at;
      // the data descriptor (with or without its signature) sits between the data and the next header
      compressedSize = Math.max(0, next - dataOffset);
    } else {
      next = dataOffset + compressedSize;
    }
    if (next > all.length) break; // cut off in this entry's data
    out.push({ name, method, flags, compressedSize, size: flags & 0x8 ? -1 : size, offset: p, dataOffset });
    p = next;
  }
  return out;
}

export function openZip(absPath: string): ZipArchive {
  const fd = fs.openSync(absPath, 'r');
  try {
    const reader = new Reader(fd, fs.fstatSync(fd).size);
    let list: ZipEntry[] | null = null;
    let recovered = false;
    try {
      const dir = findDirectory(reader);
      if (dir) list = readDirectory(reader, dir);
    } catch {
      list = null;
    }
    if (!list) {
      if (reader.size < 4 || reader.bytes(0, 4).readUInt32LE(0) !== LOCAL) throw new ZipError('not a zip archive');
      list = scanLocalHeaders(reader);
      recovered = true;
      if (list.length === 0) throw new ZipError('not a zip archive');
    }
    const entries = new Map<string, ZipEntry>();
    for (const entry of list) if (!entries.has(entry.name)) entries.set(entry.name, entry);
    let folded: Map<string, ZipEntry> | null = null;
    let closed = false;
    return {
      entries,
      recovered,
      find(name) {
        const exact = entries.get(name);
        if (exact) return exact;
        folded ??= new Map([...entries.values()].reverse().map((entry) => [entry.name.toLowerCase(), entry]));
        return folded.get(name.toLowerCase());
      },
      read(which, maxBytes = MAX_ZIP_ENTRY_BYTES) {
        if (closed) throw new ZipError('the archive is closed');
        const entry = typeof which === 'string' ? this.find(which) : which;
        if (!entry) throw new ZipError(`no entry ${String(which)} in the archive`);
        if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted`);
        if (entry.size > maxBytes) throw new ZipError(`${entry.name} is larger than ${maxBytes} bytes`);
        let dataOffset = entry.dataOffset;
        if (dataOffset === undefined) {
          const header = reader.bytes(entry.offset, 30);
          if (header.readUInt32LE(0) !== LOCAL) throw new ZipError(`damaged local header for ${entry.name}`);
          dataOffset = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        }
        const data = reader.bytes(dataOffset, entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method !== 8) throw new ZipError(`${entry.name} uses compression method ${entry.method}, which is not read here`);
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
        } catch (e) {
          throw new ZipError(`${entry.name} does not inflate: ${(e as Error).message}`);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      },
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e instanceof ZipError ? e : new ZipError((e as Error).message);
  }
}

