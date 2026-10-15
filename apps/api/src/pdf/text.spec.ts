import { afterAll, describe, expect, it } from 'vitest';

import { newPdf, type TextStyle, widthOf, wrap } from './text.js';

// A real pdfkit document with the real fonts: wrap() measures with them
const { pdf } = newPdf({});
const style: TextStyle = { size: 10, bold: false, color: '#000000' };

afterAll(() => {
  pdf.end();
});

describe('wrap', () => {
  it('keeps text that fits on one line as it is', () => {
    expect(wrap(pdf, 'Station Road, Bhairab', 300, style)).toEqual(['Station Road, Bhairab']);
  });

  it('breaks between words, and every line fits', () => {
    const text = 'Deliver the cartons to the Mirpur depot before ten in the morning';
    const lines = wrap(pdf, text, 120, style);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const line of lines)
      expect(widthOf(pdf, line, style.size, false)).toBeLessThanOrEqual(120);
  });

  it('keeps the line breaks a person typed, empty lines too', () => {
    expect(wrap(pdf, 'House 12, Road 4\n\nNarsingdi', 300, style)).toEqual([
      'House 12, Road 4',
      '',
      'Narsingdi',
    ]);
  });

  it('cuts a word wider than the line between letters, never inside a Bangla letter', () => {
    const word = 'ক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্ম';
    const lines = wrap(pdf, word, 40, style);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(word);
    // Every piece is whole clusters: ক্ষ্ম is one letter of five code points
    for (const line of lines) expect(line.replaceAll('ক্ষ্ম', '')).toBe('');
  });

  it('puts one letter on each line of a column narrower than a letter, and ends', () => {
    expect(wrap(pdf, 'SN0001', 1, style)).toEqual(['S', 'N', '0', '0', '0', '1']);
  });
});
