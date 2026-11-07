import zlib from 'node:zlib';

/**
 * Zip archives and EPUBs built in memory, for the zip reader and the EPUB
 * converter: entries stored or deflated, the central directory optional (an
 * archive cut off before it), no external tooling.
 */

export interface ZipFileSpec {
  name: string;
  data: string | Buffer;
  /** Store instead of deflate (an EPUB's mimetype is stored). */
  store?: boolean;
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

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: ZipFileSpec[], opts: { directory?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const data = f.store ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  if (opts.directory === false) return Buffer.concat(locals);
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export interface EpubSpec {
  /** Package metadata, as written inside <metadata>. */
  metadata?: string;
  /** Chapters in reading order: file name under OEBPS/ and its XHTML body. */
  chapters: { file: string; body: string; title?: string }[];
  /** An EPUB 3 nav document's <ol>, or an EPUB 2 NCX's navMap content. */
  nav?: string;
  ncx?: string;
  /** Other entries (pictures), under OEBPS/. */
  extra?: { file: string; data: string | Buffer; mediaType: string; properties?: string }[];
  /** `<meta name="cover" content="…">` for EPUB 2. */
  coverId?: string;
  directory?: boolean;
  encrypted?: string[];
}

const xhtml = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;

/** A book: mimetype, container, package, chapters, and a nav document or an NCX. */
export function epub(spec: EpubSpec): Buffer {
  const items: string[] = [];
  const spine: string[] = [];
  const files: ZipFileSpec[] = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
  ];
  spec.chapters.forEach((c, i) => {
    items.push(`<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    files.push({ name: `OEBPS/${c.file}`, data: xhtml(c.title ?? 'Book', c.body) });
  });
  if (spec.nav !== undefined) {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    files.push({ name: 'OEBPS/nav.xhtml', data: xhtml('Contents', `<nav epub:type="toc"><h1>Contents</h1>${spec.nav}</nav>`) });
  }
  if (spec.ncx !== undefined) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    files.push({ name: 'OEBPS/toc.ncx', data: `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><docTitle><text>Book</text></docTitle><navMap>${spec.ncx}</navMap></ncx>` });
  }
  for (const [i, e] of (spec.extra ?? []).entries()) {
    items.push(`<item id="x${i}" href="${e.file}" media-type="${e.mediaType}"${e.properties ? ` properties="${e.properties}"` : ''}/>`);
    files.push({ name: `OEBPS/${e.file}`, data: e.data });
  }
  if (spec.encrypted?.length) {
    files.push({
      name: 'META-INF/encryption.xml',
      data: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">${spec.encrypted.map((u) => `<enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${u}"/></enc:CipherData></enc:EncryptedData>`).join('')}</encryption>`,
    });
  }
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">${spec.metadata ?? '<dc:title>Book</dc:title>'}${spec.coverId ? `<meta name="cover" content="${spec.coverId}"/>` : ''}</metadata>
<manifest>${items.join('')}</manifest>
<spine${spec.ncx !== undefined ? ' toc="ncx"' : ''}>${spine.join('')}</spine>
</package>`;
  files.splice(2, 0, { name: 'OEBPS/content.opf', data: opf });
  return zip(files, { directory: spec.directory });
}

/** A 1×1 PNG. */
export const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
