import * as zlib from 'zlib';

/**
 * Minimal PDF text extractor, written for the Therapios letter PDFs.
 *
 * Why this exists: every letter the platform produces (Vorabinformation, Honorarvereinbarung,
 * invoices, Storno, therapy report) is delivered as a PDF only — there is no HTML preview to read.
 * Assertions about what a letter actually PRINTS (#3370 is entirely about that) therefore need the
 * text out of the PDF.
 *
 * These PDFs draw their text with **subset-embedded fonts**, so the byte in the content stream is a
 * glyph id, not a character — reading the raw stream yields text shifted by an arbitrary offset
 * ("Mario" comes out as "0DULR"). What makes them readable is that each font also carries a
 * `/ToUnicode` CMap; this module parses those CMaps and maps every glyph id back through the font it
 * was drawn with. Fonts are resolved per `Tf` operator rather than merged, because subset fonts each
 * number their glyphs from scratch and a merged map would decode to nonsense.
 *
 * Scope: enough of the PDF grammar for these generated documents — Flate-compressed object streams,
 * literal `(...)` and hex `<...>` strings, `Tj`/`TJ`, 1-byte simple fonts and 2-byte Identity-H
 * Type0 fonts. It is not a general-purpose PDF parser and deliberately ignores layout: the output is
 * one line per text-showing block, in content-stream order, which is what letter assertions need
 * (the recipient block reads as its own lines).
 */

type PdfObject = { dict: string; stream: Buffer | null };
type PdfFont = { cmap: Map<number, string> | null; twoByte: boolean };

function parseObjects(buf: Buffer): Map<number, PdfObject> {
  const s = buf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) continue;
    const body = s.slice(start, end);
    const streamAt = body.indexOf('stream');
    const dict = streamAt >= 0 ? body.slice(0, streamAt) : body;
    let stream: Buffer | null = null;
    if (streamAt >= 0) {
      // the stream data starts after the EOL that follows the `stream` keyword
      let from = streamAt + 6;
      if (body[from] === '\r') from++;
      if (body[from] === '\n') from++;
      const to = body.lastIndexOf('endstream');
      if (to > from) {
        const raw = Buffer.from(body.slice(from, to), 'latin1');
        if (/\/FlateDecode/.test(dict)) {
          try {
            stream = zlib.inflateSync(raw);
          } catch {
            stream = null; // a stream this module cannot read is simply skipped
          }
        } else {
          stream = raw;
        }
      }
    }
    objects.set(Number(m[1]), { dict, stream });
  }
  return objects;
}

/** Parses a `/ToUnicode` CMap into glyph-code → text. */
function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };

  let block: RegExpExecArray | null;
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((block = bfchar.exec(text))) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = bfrange.exec(text))) {
    const row = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let r: RegExpExecArray | null;
    while ((r = row.exec(block[1]))) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      if (r[3] !== undefined) {
        const base = parseInt(r[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else if (r[4] !== undefined) {
        [...r[4].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((x, i) => map.set(lo + i, utf16(x[1])));
      }
    }
  }
  return map;
}

/** Decodes a PDF literal-string body (`\(`, `\\`, octal escapes …) into its raw bytes. */
function literalBytes(body: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
      out.push(parseInt(oct, 8));
    } else if (next === 'n') out.push(10);
    else if (next === 'r') out.push(13);
    else if (next === 't') out.push(9);
    else if (next === 'b') out.push(8);
    else if (next === 'f') out.push(12);
    else if (next === '\n') {
      /* escaped newline is a line continuation, not a character */
    } else out.push(body.charCodeAt(i));
  }
  return out;
}

function hexBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const out: number[] = [];
  // an odd trailing nibble is padded with 0, per the PDF spec
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt((clean.slice(i, i + 2) + '0').slice(0, 2), 16));
  return out;
}

/** Extracts the readable text of a PDF, one line per text-showing block. */
export function pdfText(buf: Buffer): string {
  const objects = parseObjects(buf);

  const fonts = new Map<number, PdfFont>();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    const cmapObj = toUnicode ? objects.get(Number(toUnicode[1])) : null;
    fonts.set(num, {
      cmap: cmapObj?.stream ? parseCMap(cmapObj.stream.toString('latin1')) : null,
      twoByte: /\/Subtype\s*\/Type0/.test(obj.dict) || /Identity-H/.test(obj.dict),
    });
  }

  // Resource name (`/R9`) → font object. Collected document-wide: these documents number their
  // font resources once, so a page-by-page walk buys nothing.
  const nameToFont = new Map<string, number>();
  const collect = (dictText: string) => {
    for (const r of dictText.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      if (fonts.has(Number(r[2]))) nameToFont.set(r[1], Number(r[2]));
    }
  };
  for (const [, obj] of objects) {
    const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
    if (inline) collect(inline[1]);
    const indirect = /\/Font\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (indirect && objects.has(Number(indirect[1]))) collect(objects.get(Number(indirect[1]))!.dict);
  }

  const decode = (bytes: number[], font: PdfFont | null) => {
    if (!font?.cmap) return '';
    let s = '';
    if (font.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) s += font.cmap.get(bytes[i] * 256 + bytes[i + 1]) ?? '';
    } else {
      for (const b of bytes) s += font.cmap.get(b) ?? '';
    }
    return s;
  };

  const lines: string[] = [];
  for (const [, obj] of objects) {
    if (!obj.stream) continue;
    const content = obj.stream.toString('latin1');
    if (!/\bT[Jj]\b/.test(content)) continue;

    let font: PdfFont | null = null;
    let line = '';
    const token =
      /\/(\w+)\s+[\d.]+\s+Tf|\[((?:\((?:\\.|[^)\\])*\)|<[0-9A-Fa-f\s]*>|[^\][])*)\]\s*TJ|\(((?:\\.|[^)\\])*)\)\s*Tj|<([0-9A-Fa-f\s]*)>\s*Tj|\bET\b|\bT\*/g;
    let t: RegExpExecArray | null;
    while ((t = token.exec(content))) {
      if (t[1] !== undefined) {
        font = fonts.get(nameToFont.get(t[1]) as number) ?? null;
      } else if (t[2] !== undefined) {
        for (const part of t[2].matchAll(/\((?:\\.|[^)\\])*\)|<[0-9A-Fa-f\s]*>/g)) {
          const p = part[0];
          line += p[0] === '(' ? decode(literalBytes(p.slice(1, -1)), font) : decode(hexBytes(p.slice(1, -1)), font);
        }
      } else if (t[3] !== undefined) {
        line += decode(literalBytes(t[3]), font);
      } else if (t[4] !== undefined) {
        line += decode(hexBytes(t[4]), font);
      } else {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join('\n');
}
