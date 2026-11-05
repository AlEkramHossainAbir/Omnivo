import { type Doc, draw, newPdf, type TextStyle, wrap } from '../pdf/text.js';
import type { DocumentModel } from './model.js';

// Draws a document's model on A4 (step 16). The layout is the browser print's (CLAUDE.md → Print
// layout, PrintSheet in @omnivo/ui): white paper, ink text, 1px rules (ink under the header and the
// table head, line between rows), no fills, no shadows. The header has the logo and the company on
// the left, the title and its details on the right. The table head repeats on every page, and a
// row, the totals and the signatures never break across two pages. Change anything here → bump
// LAYOUT_VERSION in model.ts.

const INK = '#0F1728';
const INK_2 = '#475467';
const INK_3 = '#8A94A6';
const LINE = '#E4E7EC';

// 12 mm, the print sheet's margin
const MARGIN = 34;
// The space left at the foot of each page for "Page 1 of 2"
const FOOTER = 22;

const BODY: TextStyle = { size: 9, bold: false, color: INK };
const SMALL: TextStyle = { size: 7.5, bold: false, color: INK_2 };
const CAPTION: TextStyle = { size: 7.5, bold: true, color: INK_2 };
const LEADING = 1.45;

function lineHeight(style: TextStyle): number {
  return style.size * LEADING;
}

// A cursor down the page. Every block asks `room()` first: when the block does not fit, it starts
// on a new page, so a table row or the totals never break in the middle.
class Page {
  y = MARGIN;
  readonly left = MARGIN;
  readonly width: number;
  private readonly bottom: number;

  constructor(
    readonly pdf: Doc,
    private readonly onNewPage: () => void,
  ) {
    this.width = pdf.page.width - 2 * MARGIN;
    this.bottom = pdf.page.height - MARGIN - FOOTER;
  }

  room(height: number): void {
    if (this.y + height <= this.bottom) return;
    this.pdf.addPage();
    this.y = MARGIN;
    this.onNewPage();
  }

  rule(color: string, width: number): void {
    this.pdf
      .moveTo(this.left, this.y)
      .lineTo(this.left + this.width, this.y)
      .lineWidth(width)
      .strokeColor(color)
      .stroke();
  }

  // Lines of text from the cursor down, at x; returns the height used
  text(
    lines: readonly string[],
    x: number,
    width: number,
    style: TextStyle,
    align: 'left' | 'right' = 'left',
  ): number {
    const height = lineHeight(style);
    lines.forEach((line, index) => {
      draw(this.pdf, line, x, this.y + height * (index + 1) - style.size * 0.3, {
        ...style,
        align,
        width,
      });
    });
    return height * lines.length;
  }
}

export function writeDocumentPdf(model: DocumentModel, logo: Uint8Array | null): Promise<Buffer> {
  const { pdf, done } = newPdf({
    margin: MARGIN,
    // Every page stays in memory until the end, so the footer can say "Page 1 of 2"
    bufferPages: true,
    info: {
      Title: `${model.title} ${model.number} — ${model.company.name}`,
      Creator: 'Omnivo',
    },
  });
  // The table head is drawn again at the top of every page after the first
  let repeatHead = (): void => undefined;
  const page = new Page(pdf, () => {
    repeatHead();
  });

  header(page, model, logo);
  party(page, model);
  if (model.table !== null) {
    const table = model.table;
    repeatHead = () => {
      tableHead(page, table);
    };
    tableHead(page, table);
    for (const row of table.rows) tableRow(page, table, row);
  }
  totals(page, model);
  words(page, model);
  note(page, model);
  signatures(page, model);
  footer(pdf, model);
  pdf.end();
  return done;
}

function header(page: Page, model: DocumentModel, logo: Uint8Array | null): void {
  const { pdf } = page;
  const rightWidth = 210;
  const leftWidth = page.width - rightWidth - 24;
  const top = page.y;

  // Left: the logo, then the company. A logo that pdfkit cannot read (a broken upload) is left out
  // rather than failing the whole PDF.
  let left = top;
  if (logo !== null) {
    try {
      pdf.image(Buffer.from(logo), page.left, top, { fit: [110, 40] });
      left += 48;
    } catch {
      // the PDF goes out without the logo
    }
  }
  page.y = left;
  const nameStyle: TextStyle = { size: 12, bold: true, color: INK };
  left += page.text(
    wrap(pdf, model.company.name, leftWidth, nameStyle),
    page.left,
    leftWidth,
    nameStyle,
  );
  page.y = left;
  for (const line of model.company.lines) {
    left += page.text(wrap(pdf, line, leftWidth, SMALL), page.left, leftWidth, SMALL);
    page.y = left;
  }

  // Right: the title and the details, label on the left of the column and value on the right
  const x = page.left + page.width - rightWidth;
  page.y = top;
  const titleStyle: TextStyle = { size: 18, bold: true, color: INK };
  let right = top + page.text([model.title], x, rightWidth, titleStyle, 'right') + 4;
  for (const item of model.meta) {
    page.y = right;
    page.text([item.label], x, rightWidth / 2, { ...SMALL, color: INK_3 });
    right += page.text(
      [item.value],
      x + rightWidth / 2,
      rightWidth / 2,
      { ...BODY, size: 8.5 },
      'right',
    );
  }

  page.y = Math.max(left, right) + 10;
  page.rule(INK, 1);
  page.y += 14;
}

function party(page: Page, model: DocumentModel): void {
  const { pdf } = page;
  const half = (page.width - 24) / 2;
  const top = page.y;
  const nameStyle: TextStyle = { size: 10, bold: true, color: INK };

  let left = top + page.text([model.party.label], page.left, half, { ...CAPTION, color: INK_3 });
  page.y = left;
  left += page.text(wrap(pdf, model.party.name, half, nameStyle), page.left, half, nameStyle);
  page.y = left;
  left += page.text([model.party.code], page.left, half, { ...SMALL, color: INK_3 });
  for (const line of model.party.lines) {
    page.y = left;
    left += page.text(wrap(pdf, line, half, SMALL), page.left, half, SMALL);
  }

  // A receipt's facts: the amount (large), how it was paid, the reference
  const x = page.left + half + 24;
  let right = top;
  model.facts.forEach((fact, index) => {
    page.y = right;
    right += page.text([fact.label], x, half, { ...CAPTION, color: INK_3 });
    page.y = right;
    const style: TextStyle = index === 0 ? { size: 15, bold: true, color: INK } : BODY;
    right += page.text(wrap(pdf, fact.value, half, style), x, half, style) + 6;
  });

  page.y = Math.max(left, right) + 16;
}

type Table = NonNullable<DocumentModel['table']>;
type Row = Table['rows'][number];

const GAP = 8;

// Each column's x and width, from its share of the line. The widest column takes the details.
function placesOf(page: Page, table: Table): { x: number; width: number }[] {
  const share = table.columns.reduce((sum, column) => sum + column.width, 0);
  const usable = page.width - GAP * (table.columns.length - 1);
  let x = page.left;
  return table.columns.map((column) => {
    const place = { x, width: usable * (column.width / share) };
    x += place.width + GAP;
    return place;
  });
}

function detailColumn(table: Table): number {
  return table.columns.reduce(
    (best, column, index) => (column.width > (table.columns[best]?.width ?? 0) ? index : best),
    0,
  );
}

function tableHead(page: Page, table: Table): void {
  const places = placesOf(page, table);
  const height = lineHeight(CAPTION) + 6;
  page.room(height + lineHeight(BODY) * 2);
  const top = page.y;
  table.columns.forEach((column, index) => {
    const place = places[index];
    if (!place) return;
    page.y = top + 2;
    page.text([column.label], place.x, place.width, CAPTION, column.align);
  });
  page.y = top + height;
  page.rule(INK, 0.75);
}

function tableRow(page: Page, table: Table, row: Row): void {
  const { pdf } = page;
  const places = placesOf(page, table);
  const wide = detailColumn(table);
  const widePlace = places[wide];
  const wideText = row.cells[wide] ?? '';
  // The item's description may take two lines; the details go under it, each wrapped too
  const main = widePlace === undefined ? [wideText] : wrap(pdf, wideText, widePlace.width, BODY);
  const details =
    widePlace === undefined
      ? []
      : row.details.flatMap((detail) => wrap(pdf, detail, widePlace.width, SMALL));
  const height = lineHeight(BODY) * main.length + lineHeight(SMALL) * details.length + 8;
  page.room(height);

  const top = page.y + 3;
  row.cells.forEach((cell, index) => {
    const place = places[index];
    const column = table.columns[index];
    if (!place || !column) return;
    page.y = top;
    if (index === wide) {
      page.y += page.text(main, place.x, place.width, BODY);
      page.text(details, place.x, place.width, SMALL);
    } else {
      page.text([cell], place.x, place.width, BODY, column.align);
    }
  });
  page.y = top - 3 + height;
  page.rule(LINE, 0.5);
}

function totals(page: Page, model: DocumentModel): void {
  if (model.totals === null) return;
  const { rows, note: vatNote } = model.totals;
  const width = 230;
  const x = page.left + page.width - width;
  const row = lineHeight(BODY) + 3;
  page.y += 8;
  page.room(row * rows.length + 8);
  const top = page.y;
  if (vatNote !== null) {
    page.text([vatNote], page.left, page.width - width - 24, SMALL);
  }
  for (const item of rows) {
    // A strong row (the total, what is still due) sits under an ink rule, like the print
    if (item.strong) {
      page.pdf
        .moveTo(x, page.y + 1)
        .lineTo(x + width, page.y + 1)
        .lineWidth(0.75)
        .strokeColor(INK)
        .stroke();
    }
    const style: TextStyle = { ...BODY, bold: item.strong };
    const start = page.y + 1;
    page.y = start;
    page.text([item.label], x, width / 2, item.strong ? style : { ...style, color: INK_2 });
    page.y = start;
    page.text([item.value], x + width / 2, width / 2, style, 'right');
    page.y = start + row;
  }
  page.y = Math.max(page.y, top + lineHeight(SMALL)) + 6;
}

function words(page: Page, model: DocumentModel): void {
  if (model.words === null) return;
  const style: TextStyle = { ...BODY, bold: true };
  const lines = wrap(page.pdf, model.words, page.width, style);
  page.y += 4;
  page.room(lineHeight(style) * lines.length);
  page.y += page.text(lines, page.left, page.width, style) + 8;
}

function note(page: Page, model: DocumentModel): void {
  if (model.note === null) return;
  const lines = wrap(page.pdf, model.note.value, page.width, BODY);
  page.y += 4;
  // A long note may run over a page; its label and first lines stay together
  page.room(lineHeight(CAPTION) + lineHeight(BODY) * Math.min(lines.length, 3));
  page.y += page.text([model.note.label], page.left, page.width, { ...CAPTION, color: INK_3 });
  for (const line of lines) {
    page.room(lineHeight(BODY));
    page.y += page.text([line], page.left, page.width, BODY);
  }
  page.y += 8;
}

// The lines people sign on, side by side, with room above them for the signature and the stamp
function signatures(page: Page, model: DocumentModel): void {
  if (model.signatures.length === 0) return;
  const space = 44;
  page.room(space + lineHeight(SMALL) + 4);
  page.y += space;
  const gap = 32;
  const width = (page.width - gap * (model.signatures.length - 1)) / model.signatures.length;
  const top = page.y;
  model.signatures.forEach((label, index) => {
    const x = page.left + index * (width + gap);
    page.pdf
      .moveTo(x, top)
      .lineTo(x + width, top)
      .lineWidth(0.75)
      .strokeColor(INK)
      .stroke();
    page.y = top + 2;
    page.text([label], x, width, SMALL);
  });
  page.y = top + lineHeight(SMALL) + 4;
}

// "Page 1 of 2" at the foot of every page, in the document's digits, now that the count is known
function footer(pdf: Doc, model: DocumentModel): void {
  const range = pdf.bufferedPageRange();
  const digits = new Intl.NumberFormat(model.language === 'bn' ? 'bn-BD' : 'en-US');
  const width = pdf.page.width - 2 * MARGIN;
  for (let index = range.start; index < range.start + range.count; index += 1) {
    pdf.switchToPage(index);
    const text = model.page
      .replace('{page}', digits.format(index + 1))
      .replace('{pages}', digits.format(range.count));
    draw(pdf, text, MARGIN, pdf.page.height - MARGIN, {
      size: 7.5,
      bold: false,
      color: INK_3,
      align: 'right',
      width,
    });
  }
}
