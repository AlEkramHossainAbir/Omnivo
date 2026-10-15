import { draw, newPdf } from '../../pdf/text.js';
import { COPY } from './copy.js';
import type { DocCell, DocRow, ReportDocument } from './document.js';
import { formatAmount } from './format.js';

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

function cellText(cell: DocCell, language: ReportDocument['language']): string {
  if (cell.kind === 'money') return formatAmount(cell.amount, language);
  return cell.kind === 'text' ? cell.text : '';
}

const BOLD = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);

export function writePdf(doc: ReportDocument): Promise<Buffer> {
  const { pdf, done } = newPdf({
    layout: doc.landscape ? 'landscape' : 'portrait',
    margin: MARGIN,
    // Every page stays in memory until the end, so the footer can say "Page 1 of 3"
    bufferPages: true,
    info: { Title: `${doc.title} — ${doc.company}`, Creator: 'Omnivo' },
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
