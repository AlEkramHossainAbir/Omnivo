import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

import { COPY } from './copy.js';
import type { DocCell, DocRow, ReportDocument } from './document.js';
import { formatAmount } from './format.js';

// The fonts of the app (CLAUDE.md → Typography): Geist for Latin text and digits, Noto Sans
// Bengali for Bangla and the ৳ sign. A PDF must carry its fonts inside it; these files come from
// the same @fontsource packages the app uses, resolved through node_modules at run time.
const require = createRequire(import.meta.url);
const FONT_FILES = {
  latin: require.resolve('@fontsource/geist/files/geist-latin-400-normal.woff'),
  'latin-bold': require.resolve('@fontsource/geist/files/geist-latin-600-normal.woff'),
  bengali:
    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff'),
  'bengali-bold':
    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-600-normal.woff'),
} as const;

// The design system's colors (CLAUDE.md → Color tokens, light): the PDF is printed on white
const INK = '#0F1728';
const INK_2 = '#475467';
const INK_3 = '#8A94A6';
const LINE = '#E4E7EC';
const LINE_STRONG = '#D0D5DD';
const SUBTLE = '#F1F3F6';

const MARGIN = 40;
const ROW_HEIGHT = 18;
const FONT_SIZE = 8.5;
const INDENT = 10;

type Doc = InstanceType<typeof PDFDocument>;

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

function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
  return runs(text).reduce((sum, run) => {
    doc.font(fontOf(run.bengali, bold)).fontSize(size);
    return sum + doc.widthOfString(run.text, { features: NUMBERS });
  }, 0);
}

// Whole letters as a reader sees them: a Bangla conjunct (ক্ষ) or a vowel sign is one grapheme
// of several code points, and cutting between them would leave a broken shape
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Cut with "…" until it fits: a long account name never runs into the amount next to it
function fit(doc: Doc, text: string, max: number, size: number, bold: boolean): string {
  if (widthOf(doc, text, size, bold) <= max) return text;
  let cut = Array.from(graphemes.segment(text), (part) => part.segment);
  while (cut.length > 0 && widthOf(doc, `${cut.join('')}…`, size, bold) > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut.join('').trimEnd()}…`;
}

// y is the baseline: the two fonts have different heights above it, and lining both up on the
// baseline (not on the top of the line) keeps "৳" level with the digits next to it
function draw(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  options: { size: number; bold: boolean; color: string; align: 'left' | 'right'; width: number },
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

function cellText(cell: DocCell, language: ReportDocument['language']): string {
  if (cell.kind === 'money') return formatAmount(cell.amount, language);
  return cell.kind === 'text' ? cell.text : '';
}

const BOLD = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);

export function writePdf(doc: ReportDocument): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    layout: doc.landscape ? 'landscape' : 'portrait',
    margin: MARGIN,
    // Every page stays in memory until the end, so the footer can say "Page 1 of 3"
    bufferPages: true,
    info: { Title: `${doc.title} — ${doc.company}`, Creator: 'Omnivo' },
  });
  for (const [name, file] of Object.entries(FONT_FILES)) pdf.registerFont(name, file);

  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });

  const left = MARGIN;
  const width = pdf.page.width - 2 * MARGIN;
  const bottom = pdf.page.height - MARGIN - 20;
  const share = doc.columns.reduce((sum, column) => sum + column.width, 0);
  const gap = 8;
  // Each column's x and width, from its share of the line
  const columns = doc.columns.reduce<{ x: number; width: number }[]>((list, column) => {
    const x = list.length === 0 ? left : (list.at(-1)?.x ?? left) + (list.at(-1)?.width ?? 0) + gap;
    return [
      ...list,
      { x, width: (width - gap * (doc.columns.length - 1)) * (column.width / share) },
    ];
  }, []);

  // The heading of the first page: company, title and the lines under it
  let y = MARGIN + 12;
  draw(pdf, doc.company, left, y, { size: 10, bold: true, color: INK_2, align: 'left', width });
  y += 22;
  draw(pdf, doc.title, left, y, { size: 18, bold: true, color: INK, align: 'left', width });
  y += 8;
  for (const line of doc.lines) {
    y += 14;
    draw(pdf, line, left, y, { size: 9, bold: false, color: INK_3, align: 'left', width });
  }
  y += 18;

  // The column headers, again at the top of every page
  const headerRow = () => {
    pdf.rect(left, y, width, ROW_HEIGHT).fill(SUBTLE);
    doc.columns.forEach((column, index) => {
      const place = columns[index];
      if (!place) return;
      draw(pdf, column.header, place.x + (index === 0 ? 6 : 0), y + 12, {
        size: 7.5,
        bold: true,
        color: INK_3,
        align: column.kind === 'money' ? 'right' : 'left',
        width: place.width - (index === 0 ? 6 : 0),
      });
    });
    y += ROW_HEIGHT;
  };
  headerRow();

  for (const row of doc.rows) {
    if (y + ROW_HEIGHT > bottom) {
      pdf.addPage();
      y = MARGIN;
      headerRow();
    }
    const bold = BOLD.has(row.style);
    // A total sits under a stronger rule; every other row under a light one
    if (row.style === 'total' || row.style === 'grand') {
      pdf
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.75)
        .strokeColor(LINE_STRONG)
        .stroke();
    }
    row.cells.forEach((cell, index) => {
      const place = columns[index];
      const column = doc.columns[index];
      if (!place || !column) return;
      const indent = index === 0 ? 6 + row.indent * INDENT : 0;
      draw(pdf, cellText(cell, doc.language), place.x + indent, y + 12, {
        size: row.style === 'grand' ? 9 : FONT_SIZE,
        bold,
        color: row.style === 'heading' ? INK_3 : INK,
        align: column.kind === 'money' ? 'right' : 'left',
        width: place.width - indent,
      });
    });
    y += ROW_HEIGHT;
    if (row.style !== 'heading') {
      pdf
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke();
    }
  }

  // "Page 1 of 3" at the foot of every page, now that the number of pages is known
  const range = pdf.bufferedPageRange();
  const copy = COPY[doc.language];
  const digits = new Intl.NumberFormat(doc.language === 'bn' ? 'bn-BD' : 'en-US');
  for (let index = range.start; index < range.start + range.count; index += 1) {
    pdf.switchToPage(index);
    draw(
      pdf,
      copy.page(digits.format(index + 1), digits.format(range.count)),
      left,
      pdf.page.height - MARGIN,
      { size: 7.5, bold: false, color: INK_3, align: 'right', width },
    );
  }
  pdf.end();
  return done;
}
