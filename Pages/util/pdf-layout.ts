import * as zlib from 'zlib';

/**
 * Positioned-text PDF reader, for the layout assertions `pdfText` deliberately cannot make.
 *
 * `Pages/util/pdf-text.ts` returns one flat string and says so: "it deliberately ignores layout".
 * That is the right shape for "does this letter print a country marker" (#3370) or "does it carry
 * the rebrand banner" (#3481). It cannot answer the RC 3.11.3 letter tickets, which are entirely
 * about geometry:
 *
 *   - #3522 — does the Vorabinformation fit on ONE page, and which page is the closing on?
 *   - #3523 — how large is the copayment FAQ text, and is the FAQ still one page?
 *   - #3525 — do the Vorabinformation's four footer columns span the full page width?
 *
 * So this module keeps `pdf-text`'s font decoding (subset fonts + `/ToUnicode`, see that file for
 * why that is required at all) and adds the graphics state: page tree, CTM, text matrix, font size
 * and the filled rectangles.
 *
 * **The tokenizer is a real lexer, not a regex.** That is load-bearing rather than fastidious: the
 * text operands are raw subset-font bytes, so a byte that happens to be `Q` sits inside a string
 * with `\0` on either side and a regex alternation matches it as the restore-graphics-state
 * operator. On a real Vorabinformation that produced 235 `Q`s against 53 `q`s, which emptied the
 * graphics stack, dropped the outer `0.1` scale, and reported every coordinate and font size ten
 * times too large — a wrong answer that still looked plausible. Consuming strings as single tokens
 * is what makes q/Q balance (53/53) and the numbers real.
 *
 * These documents come out of headless Chrome via Ghostscript, which wraps the page in
 * `q 0.1 0 0 0.1 0 0 cm` and each text block in a matching `10 0 0 10 0 0 cm`, so the CTM has to be
 * tracked properly for the two to cancel. Coordinates are PDF points from the bottom-left.
 */

// ─────────────────────────────────── lexer ───────────────────────────────────

type Token =
  | { t: 'str'; bytes: number[] }
  | { t: 'name'; v: string }
  | { t: 'num'; v: number }
  | { t: 'op'; v: string };

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function* tokenize(s: string): Generator<Token> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (WS.has(c)) { i++; continue; }
    if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }

    if (c === '(') {
      // Literal string. Parens nest, and a backslash escapes the next byte — both must be honoured
      // or the scan ends early and the rest of the stream is read as operators.
      let depth = 1;
      let j = i + 1;
      const bytes: number[] = [];
      while (j < n && depth > 0) {
        const ch = s[j];
        if (ch === '\\') {
          const nx = s[j + 1];
          if (nx >= '0' && nx <= '7') {
            let oct = '';
            let k = j + 1;
            while (oct.length < 3 && s[k] >= '0' && s[k] <= '7') oct += s[k++];
            bytes.push(parseInt(oct, 8));
            j = k;
            continue;
          }
          const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (nx in esc) bytes.push(esc[nx]);
          else if (nx === '\n') { /* line continuation */ }
          else if (nx === '\r') { if (s[j + 2] === '\n') j++; }
          else if (nx !== undefined) bytes.push(nx.charCodeAt(0));
          j += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
        bytes.push(ch.charCodeAt(0));
        j++;
      }
      yield { t: 'str', bytes };
      i = j;
      continue;
    }

    if (c === '<' && s[i + 1] === '<') { yield { t: 'op', v: '<<' }; i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { yield { t: 'op', v: '>>' }; i += 2; continue; }
    if (c === '<') {
      const end = s.indexOf('>', i + 1);
      const hex = (end < 0 ? s.slice(i + 1) : s.slice(i + 1, end)).replace(/[^0-9A-Fa-f]/g, '');
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt((hex.slice(k, k + 2) + '0').slice(0, 2), 16));
      yield { t: 'str', bytes };
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (c === '[' || c === ']' || c === '{' || c === '}') { yield { t: 'op', v: c }; i++; continue; }

    if (c === '/') {
      let j = i + 1;
      while (j < n && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
      yield { t: 'name', v: s.slice(i + 1, j) };
      i = j;
      continue;
    }

    if ((c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.') {
      let j = i;
      while (j < n && /[0-9+\-.eE]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      yield { t: 'num', v: Number.isFinite(num) ? num : 0 };
      i = j;
      continue;
    }

    let j = i;
    while (j < n && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
    if (j === i) { i++; continue; }
    yield { t: 'op', v: s.slice(i, j) };
    i = j;
  }
}

// ────────────────────────────── object / font plumbing ──────────────────────────────

type PdfObject = { dict: string; stream: Buffer | null };
type PdfFont = { cmap: Map<number, string> | null; twoByte: boolean; base: string };

function parseObjects(buf: Buffer): Map<number, PdfObject> {
  const s = buf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  for (const m of s.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) continue;
    const body = s.slice(start, end);
    const at = body.indexOf('stream');
    const dict = at >= 0 ? body.slice(0, at) : body;
    let stream: Buffer | null = null;
    if (at >= 0) {
      let from = at + 6;
      if (body[from] === '\r') from++;
      if (body[from] === '\n') from++;
      const to = body.lastIndexOf('endstream');
      if (to > from) {
        const raw = Buffer.from(body.slice(from, to), 'latin1');
        if (/\/FlateDecode/.test(dict)) {
          try { stream = zlib.inflateSync(raw); } catch { stream = null; }
        } else stream = raw;
      }
    }
    objects.set(Number(m[1]), { dict, stream });
  }
  return objects;
}

function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))
      map.set(parseInt(p[1], 16), utf16(p[2]));
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
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

/** 3x2 affine multiply, PDF operand order. */
type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

// ──────────────────────────────────── public API ────────────────────────────────────

export interface TextRun {
  /** PDF points from the page's left edge. */
  x: number;
  /** PDF points from the page's BOTTOM edge — larger y is higher up the page. */
  y: number;
  /** Rendered font size in points (the `Tf` operand scaled by the text matrix and CTM). */
  size: number;
  font: string;
  text: string;
}

export interface FilledRect { x: number; y: number; w: number; h: number }

export interface PdfPage {
  width: number;
  height: number;
  runs: TextRun[];
  rects: FilledRect[];
}

/** Every page of a PDF, in page-tree order, with positioned text runs and filled rectangles. */
export function pdfPages(buf: Buffer): PdfPage[] {
  const objects = parseObjects(buf);

  const fonts = new Map<number, PdfFont>();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    const cmapObj = tu ? objects.get(Number(tu[1])) : null;
    fonts.set(num, {
      cmap: cmapObj?.stream ? parseCMap(cmapObj.stream.toString('latin1')) : null,
      twoByte: /\/Subtype\s*\/Type0/.test(obj.dict) || /Identity-H/.test(obj.dict),
      base: /\/BaseFont\s*\/([#\w+-]+)/.exec(obj.dict)?.[1] ?? '?',
    });
  }

  // Page order comes from the page tree; object order is not required to match it.
  const pageNums: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth = 0) => {
    if (depth > 32 || seen.has(num)) return;
    seen.add(num);
    const o = objects.get(num);
    if (!o) return;
    if (/\/Type\s*\/Page(?![s])/.test(o.dict)) { pageNums.push(num); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict);
    if (kids) for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  for (const [, o] of objects) {
    const root = /\/Type\s*\/Catalog[\s\S]*?\/Pages\s+(\d+)\s+\d+\s+R/.exec(o.dict);
    if (root) { walk(Number(root[1])); break; }
  }
  if (!pageNums.length) {
    for (const [num, o] of objects) if (/\/Type\s*\/Page(?![s])/.test(o.dict)) pageNums.push(num);
  }

  // Resource name (`/R12`) -> font object, collected DOCUMENT-WIDE.
  //
  // Not an optimisation — a correctness requirement. These files carry 9 `/Type /Font` objects for
  // 3 actual fonts (each Type0 wrapper plus its CID descendant match too), and a page's own
  // `/Font` dict can name the descendant, which carries no `/ToUnicode` and therefore decodes to
  // nothing. Resolving page-locally silently dropped every bold heading: the copayment FAQ came
  // back with 1 of its 10 numbered questions. `pdf-text.ts` collects document-wide for the same
  // reason ("these documents number their font resources once"), so the two agree.
  const docNameToFont = new Map<string, number>();
  const collectInto = (target: Map<string, number>, text: string) => {
    for (const r of text.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      const num = Number(r[2]);
      // Prefer a font that can actually decode; never let a cmap-less descendant win.
      if (fonts.has(num) && (fonts.get(num)!.cmap || !target.has(r[1]))) target.set(r[1], num);
    }
  };
  for (const [, obj] of objects) {
    const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
    if (inline) collectInto(docNameToFont, inline[1]);
    const indirect = /\/Font\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (indirect && objects.has(Number(indirect[1]))) collectInto(docNameToFont, objects.get(Number(indirect[1]))!.dict);
  }

  const pages: PdfPage[] = [];
  for (const pn of pageNums) {
    const dict = objects.get(pn)!.dict;

    const nameToFont = new Map<string, number>(docNameToFont);
    const collect = (text: string) => collectInto(nameToFont, text);
    const inlineFont = /\/Font\s*<<([\s\S]*?)>>/.exec(dict);
    if (inlineFont) collect(inlineFont[1]);
    const indirectFont = /\/Font\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (indirectFont && objects.has(Number(indirectFont[1]))) collect(objects.get(Number(indirectFont[1]))!.dict);
    const resRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (resRef && objects.has(Number(resRef[1]))) {
      const rd = objects.get(Number(resRef[1]))!.dict;
      const rf = /\/Font\s*<<([\s\S]*?)>>/.exec(rd);
      if (rf) collect(rf[1]);
      const rfi = /\/Font\s+(\d+)\s+\d+\s+R/.exec(rd);
      if (rfi && objects.has(Number(rfi[1]))) collect(objects.get(Number(rfi[1]))!.dict);
    }

    let content = '';
    const cRef = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
    const cArr = /\/Contents\s*\[([^\]]*)\]/.exec(dict);
    if (cRef) content = objects.get(Number(cRef[1]))?.stream?.toString('latin1') ?? '';
    else if (cArr)
      for (const r of cArr[1].matchAll(/(\d+)\s+\d+\s+R/g))
        content += (objects.get(Number(r[1]))?.stream?.toString('latin1') ?? '') + '\n';

    const mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(dict)?.[1].trim().split(/\s+/).map(Number) ?? [0, 0, 595.92, 841.92];

    const runs: TextRun[] = [];
    const rects: FilledRect[] = [];
    let ctm: M = [1, 0, 0, 1, 0, 0];
    const stack: M[] = [];
    let tm: M = [1, 0, 0, 1, 0, 0];
    let tlm: M = [1, 0, 0, 1, 0, 0];
    let leading = 0;
    let font: PdfFont | null = null;
    let size = 0;
    let pendingRect: FilledRect | null = null;
    const operands: Token[] = [];
    // A `TJ` array is collected in its own buffer rather than left among the operands.
    //
    // The operand list has to stay bounded (a content stream is one long token soup), but a single
    // line of text can be hundreds of array elements once kerning numbers are interleaved. Capping
    // one shared list dropped the FRONT of every long line — which reads as a plausible-looking
    // extraction full of tails ("...sene", "...ortungsvoll") and cost 9 of the FAQ's 10 questions.
    let arrayBuf: Token[] | null = null;

    const num = (i: number) => {
      const t = operands[operands.length + i];
      return t && t.t === 'num' ? t.v : 0;
    };
    const decode = (bytes: number[]) => {
      if (!font?.cmap) return '';
      let out = '';
      if (font.twoByte) for (let i = 0; i + 1 < bytes.length; i += 2) out += font.cmap.get(bytes[i] * 256 + bytes[i + 1]) ?? '';
      else for (const b of bytes) out += font.cmap.get(b) ?? '';
      return out;
    };
    const show = (text: string) => {
      if (!text) return;
      const m = mul(tm, ctm);
      runs.push({
        x: +m[4].toFixed(2),
        y: +m[5].toFixed(2),
        size: +(size * Math.hypot(m[0], m[1])).toFixed(2),
        font: font?.base ?? '',
        text,
      });
    };

    for (const tok of tokenize(content)) {
      if (tok.t !== 'op') {
        if (arrayBuf) arrayBuf.push(tok);
        else { operands.push(tok); if (operands.length > 16) operands.shift(); }
        continue;
      }
      switch (tok.v) {
        case 'q': stack.push(ctm.slice() as M); break;
        case 'Q': ctm = stack.pop() ?? ([1, 0, 0, 1, 0, 0] as M); break;
        case 'cm': ctm = mul([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)], ctm); break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'Tm': tm = [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)]; tlm = tm.slice() as M; break;
        case 'Td': tlm = mul([1, 0, 0, 1, num(-2), num(-1)], tlm); tm = tlm.slice() as M; break;
        case 'TD': leading = -num(-1); tlm = mul([1, 0, 0, 1, num(-2), num(-1)], tlm); tm = tlm.slice() as M; break;
        case 'TL': leading = num(-1); break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice() as M; break;
        case 'Tf': {
          size = num(-1);
          const nameTok = operands[operands.length - 2];
          if (nameTok && nameTok.t === 'name') font = fonts.get(nameToFont.get(nameTok.v) as number) ?? null;
          break;
        }
        case 're': {
          const m = mul([1, 0, 0, 1, num(-4), num(-3)], ctm);
          pendingRect = { x: +m[4].toFixed(2), y: +m[5].toFixed(2), w: +(num(-2) * ctm[0]).toFixed(2), h: +(num(-1) * ctm[3]).toFixed(2) };
          break;
        }
        // Only a painted rectangle counts; `W n` clip rectangles are not marks on the page.
        case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
          if (pendingRect) { rects.push(pendingRect); pendingRect = null; }
          break;
        case 'n': case 'W': case 'W*': case 'S': case 's': pendingRect = null; break;
        case 'Tj': case "'": case '"': {
          const st = operands[operands.length - 1];
          if (tok.v !== 'Tj') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice() as M; }
          if (st && st.t === 'str') show(decode(st.bytes));
          break;
        }
        case 'TJ': {
          let text = '';
          for (const p of arrayBuf ?? []) if (p.t === 'str') text += decode(p.bytes);
          arrayBuf = null;
          show(text);
          break;
        }
        case '[': arrayBuf = []; continue;
        case ']': continue;
        default: break;
      }
      operands.length = 0;
    }

    pages.push({ width: mb[2] - mb[0], height: mb[3] - mb[1], runs, rects });
  }
  return pages;
}

/** How many pages the document has. */
export function pdfPageCount(buf: Buffer): number {
  return pdfPages(buf).length;
}

/** One page's text in reading order (top to bottom, then left to right), one line per text row. */
export function pageText(page: PdfPage, rowTolerance = 2): string {
  const rows: { y: number; runs: TextRun[] }[] = [];
  for (const r of [...page.runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((g) => Math.abs(g.y - r.y) <= rowTolerance);
    if (row) row.runs.push(r);
    else rows.push({ y: r.y, runs: [r] });
  }
  return rows
    .map((g) => g.runs.sort((a, b) => a.x - b.x).map((r) => r.text).join(''))
    .join('\n');
}

/** Whole-document text, pages separated by a form feed. */
export function pdfDocText(buf: Buffer): string {
  return pdfPages(buf).map((p) => pageText(p)).join('\n\f\n');
}
