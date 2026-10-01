import writeXlsxFile, { type Cell, type CellObject, type Row } from 'write-excel-file/node';

import type { DocCell, DocRow, ReportDocument } from './document.js';

// Excel's own number format with thousands separators. Excel groups the digits the way the
// computer's region says (12,34,567.00 on a Bangladeshi or Indian Windows), so it is not spelled
// out here.
const AMOUNT_FORMAT = '#,##0.00';

// The one place money becomes a JavaScript number, because an Excel cell stores every number as a
// double: that is what lets people add the cells up in Excel. Before writing, the number is turned
// back into a string and compared: if the double cannot hold the amount exactly (beyond about 15
// digits), the cell gets the exact text instead of a rounded number.
function amountCell(amount: string, bold: boolean): CellObject {
  const value = Number(amount);
  const exact = Number.isFinite(value) && value.toFixed(4) === amount;
  return {
    value: exact ? value : amount,
    type: exact ? Number : String,
    format: AMOUNT_FORMAT,
    align: 'right',
    ...(bold && { fontWeight: 'bold' }),
  };
}

const BOLD_STYLES = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);

function cellOf(cell: DocCell, row: DocRow, first: boolean): Cell {
  const bold = BOLD_STYLES.has(row.style);
  const lines =
    row.style === 'total' || row.style === 'grand'
      ? { topBorderStyle: 'thin' as const, topBorderColor: '#D0D5DD' }
      : {};
  if (cell.kind === 'money') return { ...amountCell(cell.amount, bold), ...lines };
  if (cell.kind === 'empty') return { value: '', type: String, ...lines };
  return {
    value: cell.text,
    type: String,
    ...(bold && { fontWeight: 'bold' }),
    // Excel's own indent, not spaces: the text stays clean when someone copies the cell
    ...(first && row.indent > 0 && { indent: row.indent }),
    ...lines,
  };
}

export async function writeXlsx(doc: ReportDocument): Promise<Buffer> {
  const width = doc.columns.length;
  // A title line spans every column, so a long company name is not cut at the first one
  const titleRow = (value: string, size: number, bold: boolean): Row => [
    { value, type: String, fontSize: size, columnSpan: width, ...(bold && { fontWeight: 'bold' }) },
  ];
  const header: Row = doc.columns.map((column) => ({
    value: column.header,
    type: String,
    fontWeight: 'bold',
    backgroundColor: '#F1F3F6',
    bottomBorderStyle: 'thin',
    bottomBorderColor: '#D0D5DD',
    align: column.kind === 'money' ? 'right' : 'left',
  }));
  const top: Row[] = [
    titleRow(doc.company, 12, true),
    titleRow(doc.title, 14, true),
    ...doc.lines.map((line) => titleRow(line, 10, false)),
    [],
  ];
  const body: Row[] = doc.rows.map((row) =>
    row.cells.map((cell, index) => cellOf(cell, row, index === 0)),
  );

  return writeXlsxFile([...top, header, ...body], {
    // Sheet names may not hold more than 31 characters or : \ / ? * [ ]
    sheet: doc.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31),
    columns: doc.columns.map((column) => ({ width: column.width })),
    // The column headers stay in view while the rows scroll
    stickyRowsCount: top.length + 1,
    ...(doc.landscape && { orientation: 'landscape' }),
  }).toBuffer();
}
