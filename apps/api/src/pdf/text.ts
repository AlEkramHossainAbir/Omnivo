import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

// Text in a PDF, shared by step 11's report exports and step 16's documents: the fonts, the
// Bangla/Latin runs, measuring and cutting. Moved here from reports/export/pdf.ts in step 16, so a
// fix to how Bangla is drawn reaches both kinds of file. Step 16 adds newPdf() and wrap().

// Geist for Latin text and digits, as in the app (CLAUDE.md → Typography). Bangla and the ৳ sign
// use Hind Siliguri, not the app's Noto Sans Bengali (step 16): pdfkit shapes Bangla with fontkit,
// not with a browser's HarfBuzz, and fontkit draws Noto's ন্দ্র (কেন্দ্র, চন্দ্র) with the ra-phala
// loose beside the letters. Hind Siliguri builds its conjuncts as whole glyphs, which fontkit gets
// right. A PDF must carry its fonts inside it; the files come from @fontsource packages, resolved
// through node_modules at run time.
const require = createRequire(import.meta.url);
const FONT_FILES = {
  latin: require.resolve('@fontsource/geist/files/geist-latin-400-normal.woff'),
  'latin-bold': require.resolve('@fontsource/geist/files/geist-latin-600-normal.woff'),
  bengali: require.resolve('@fontsource/hind-siliguri/files/hind-siliguri-bengali-400-normal.woff'),
  'bengali-bold':
    require.resolve('@fontsource/hind-siliguri/files/hind-siliguri-bengali-600-normal.woff'),
} as const;

export type Doc = InstanceType<typeof PDFDocument>;

// A new A4 document with the fonts registered, and a promise of its bytes once doc.end() is called
export function newPdf(options: PDFKit.PDFDocumentOptions): { pdf: Doc; done: Promise<Buffer> } {
  const pdf = new PDFDocument({ size: 'A4', ...options });
  for (const [name, file] of Object.entries(FONT_FILES)) pdf.registerFont(name, file);
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });
  return { pdf, done };
}

// pdfkit draws a string with one font, and neither font has every character: Geist has no
// Bangla, the Bangla subset has no Latin letters. So a string is cut into runs, each drawn with
// its own font. U+0980–U+09FF is the Bengali block (৳ is U+09F3); the zero-width joiners stay with
// the Bangla run they shape.
const BENGALI = /[ঀ-৿‌‍]/;

function runs(text: string): { bengali: boolean; text: string }[] {
  const out: { bengali: boolean; text: string }[] = [];
  for (const char of text) {
    const bengali = BENGALI.test(char);
    const last = out.at(-1);
    if (last?.bengali === bengali) last.text += char;
    else out.push({ bengali, text: char });
  }
  return out;
}

function fontOf(bengali: boolean, bold: boolean): keyof typeof FONT_FILES {
  if (bengali) return bold ? 'bengali-bold' : 'bengali';
  return bold ? 'latin-bold' : 'latin';
}

// tnum: Geist's tabular figures, so the digits of a column of amounts line up (CLAUDE.md:
// tabular-nums on every number that lines up)
const NUMBERS: PDFKit.Mixins.OpenTypeFeatures[] = ['tnum'];

export function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
  return runs(text).reduce((sum, run) => {
    doc.font(fontOf(run.bengali, bold)).fontSize(size);
    return sum + doc.widthOfString(run.text, { features: NUMBERS });
  }, 0);
}

// Whole letters as a reader sees them: a Bangla conjunct (ক্ষ) or a vowel sign is one grapheme
// of several code points, and cutting between them would leave a broken shape
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function lettersOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

// Cut with "…" until it fits: a long account name never runs into the amount next to it
function fit(doc: Doc, text: string, max: number, size: number, bold: boolean): string {
  if (widthOf(doc, text, size, bold) <= max) return text;
  let cut = lettersOf(text);
  while (cut.length > 0 && widthOf(doc, `${cut.join('')}…`, size, bold) > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut.join('').trimEnd()}…`;
}

export interface TextStyle {
  size: number;
  bold: boolean;
  color: string;
}

// y is the baseline: the two fonts have different heights above it, and lining both up on the
// baseline (not on the top of the line) keeps "৳" level with the digits next to it
export function draw(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  options: TextStyle & { align: 'left' | 'right'; width: number },
): void {
  const shown = fit(doc, text, options.width, options.size, options.bold);
  let cursor =
    options.align === 'right'
      ? x + options.width - widthOf(doc, shown, options.size, options.bold)
      : x;
  doc.fillColor(options.color);
  for (const run of runs(shown)) {
    doc.font(fontOf(run.bengali, options.bold)).fontSize(options.size);
    doc.text(run.text, cursor, y, { lineBreak: false, baseline: 'alphabetic', features: NUMBERS });
    cursor += doc.widthOfString(run.text, { features: NUMBERS });
  }
}

// Step 16: text that may need several lines (an address, a note, an amount in words). pdfkit can
// wrap by itself, but only inside one font, and our text switches fonts mid-line. So the words are
// laid out here, one line at a time, and each line is drawn with draw(). A line break the person
// typed stays a line break. A word longer than the whole width (a long serial number list without
// spaces) is cut between letters, never inside a Bangla letter.
export function wrap(doc: Doc, text: string, width: number, style: TextStyle): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ').filter((part) => part !== '')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (widthOf(doc, candidate, style.size, style.bold) <= width) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      // The word starts a new line. Wider than the whole line: as many letters per line as fit
      // (at least one, so a very narrow column cannot loop forever). The last letter is never cut
      // off on its own: it starts the next line, else an empty line would follow it.
      let rest = word;
      while (widthOf(doc, rest, style.size, style.bold) > width && lettersOf(rest).length > 1) {
        const letters = lettersOf(rest);
        let count = Math.max(1, letters.length - 1);
        while (
          count > 1 &&
          widthOf(doc, letters.slice(0, count).join(''), style.size, style.bold) > width
        ) {
          count -= 1;
        }
        lines.push(letters.slice(0, count).join(''));
        rest = letters.slice(count).join('');
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}
