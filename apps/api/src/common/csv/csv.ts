import { CsvError, parse } from 'csv-parse/sync';

// Step 28c (decision 10): reading a CSV file, shared by the product import (step 12) and the
// courier's payout match. Only the parts both need: bytes to text, and text to rows of cells.
// What a column means stays with each caller.

// Bytes → text. Excel's "CSV UTF-8" starts with a byte order mark; its plain "CSV" on Windows is
// not UTF-8 at all, and a Bangla name would come out as question marks. fatal: true refuses such a
// file instead of reading broken names.
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// Text → rows of trimmed cells, the header first. null when it is not a CSV at all (a quote never
// closed, say). relax_column_count: Excel leaves trailing empty cells out of short rows. bom: drop
// the byte order mark, which a browser's FileReader keeps in the text it reads.
export function readCsvRecords(text: string): string[][] | null {
  try {
    return parse(text, { bom: true, trim: true, relax_column_count: true });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return null;
  }
}
