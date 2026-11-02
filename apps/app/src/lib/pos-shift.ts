import {
  type CashCountFormValues,
  type CashDenomination,
  type CashNotes,
  cashNotesTotal,
  compareMoney,
  MAX_NOTES,
  multiplyMoney,
  type PosShift,
  type PosShiftReport,
  tenderAmountsOf,
} from '@omnivo/contracts';

// Step 20b: the count of the drawer and the shift's result, worked out without React, so the
// rules are tested on their own (pos-shift.spec.ts). The screens are pos-shift.tsx.

// By notes (how many of each) or as one total (decision 8)
export type CountMode = 'notes' | 'total';

// The note boxes as typed: '' = none of that note
export type NoteBoxes = Record<CashDenomination, string>;

export const EMPTY_NOTES: NoteBoxes = {
  '1000': '',
  '500': '',
  '200': '',
  '100': '',
  '50': '',
  '20': '',
  '10': '',
  '5': '',
  '2': '',
  '1': '',
};

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// What a note box keeps of what was typed: ASCII digits only, as the PIN box does (a Bangla
// keyboard types Bangla ones), and no more than MAX_NOTES has digits. A count of notes is a whole
// number: a dot or a minus is dropped as it is typed.
export function noteDigits(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[^0-9]/g, '')
    .slice(0, String(MAX_NOTES).length);
}

// The boxes as numbers; '' is 0. A box over MAX_NOTES (99999 is the longest a box takes, so
// never) is left as it is for the schema to refuse.
export function notesOf(boxes: NoteBoxes): CashNotes {
  const count = (denomination: CashDenomination) => Number(boxes[denomination] || '0');
  return {
    '1000': count('1000'),
    '500': count('500'),
    '200': count('200'),
    '100': count('100'),
    '50': count('50'),
    '20': count('20'),
    '10': count('10'),
    '5': count('5'),
    '2': count('2'),
    '1': count('1'),
  };
}

// A count's total with 2 decimals, as cashCountSchema reads it. The notes are whole taka, so their
// total (4 decimals, cashNotesTotal) is "5000.0000": its whole part and ".00".
function notesTotal(notes: CashNotes): string {
  const [whole = '0'] = cashNotesTotal(notes).split('.');
  return `${whole}.00`;
}

// The count as cashCountSchema reads it: the notes and their total, or a total alone. The total of
// the notes is worked out here, so it always matches them (pos_count_total_mismatch is for a
// device that sends something else).
export function countValues(mode: CountMode, boxes: NoteBoxes, total: string): CashCountFormValues {
  if (mode === 'total') return { notes: null, total };
  const notes = notesOf(boxes);
  return { notes, total: notesTotal(notes) };
}

// For the "= ৳4,000" next to each box and the notes' total under them. Money stays a decimal
// string (CLAUDE.md), even for whole notes.
export function noteAmount(denomination: CashDenomination, box: string): string {
  return multiplyMoney(box || '0', denomination);
}

export function boxesTotal(boxes: NoteBoxes): string {
  return notesTotal(notesOf(boxes));
}

// The way a count reads in the result: even, over (more cash than expected) or short
export type DifferenceKind = 'even' | 'over' | 'short';

export function differenceKind(difference: string): DifferenceKind {
  const sign = compareMoney(difference, '0');
  return sign === 0 ? 'even' : sign > 0 ? 'over' : 'short';
}

// Decision 6: a shift still open on a later day (yesterday's, left open) is closed before the next
// sale. ISO dates compare as text.
export function leftOpen(openingDate: string, today: string): boolean {
  return openingDate < today;
}

// Step 20c (decision 4): the Z report of a closed shift, from its page (the server's sums, so a
// manager prints it again on any computer of the workspace). The drawer is there only when the
// shift was counted; a shift closed without a count has nothing to set the expected cash against.
export function zReportOf(shift: PosShift, printedAt: string): PosShiftReport {
  const { cash } = shift;
  return {
    kind: 'z',
    register: { code: shift.register.code, name: shift.register.name },
    shiftNumber: shift.number,
    cashierName: shift.cashier.fullName,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    printedAt,
    saleCount: shift.saleCount,
    salesTotal: shift.salesTotal,
    salesDiscount: shift.salesDiscount,
    salesVat: shift.salesVat,
    returnCount: shift.returnCount,
    returnsTotal: shift.returnsTotal,
    returnsVat: shift.returnsVat,
    // The page lists every method of the register with its 0; the paper only the ones used
    taken: tenderAmountsOf(shift.payments),
    refunded: tenderAmountsOf(shift.refunds),
    paidIn: cash.paidIn,
    paidOut: cash.paidOut,
    drawer:
      shift.countedCash === null || shift.difference === null
        ? null
        : {
            ...cash,
            expected: shift.expectedCash,
            counted: shift.countedCash,
            difference: shift.difference,
          },
  };
}
