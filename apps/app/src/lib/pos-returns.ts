import {
  addMoney,
  compareMoney,
  compareQuantity,
  isQuantity,
  isWithinReturnWindow,
  type PosPaperWidth,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnLineInput,
  posReturnAmounts,
  type PosTender,
  returnableQuantityOf,
  subtractMoney,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';

// Step 20c: the return screen's rules, worked out without React, so they are tested on their own
// (pos-returns.spec.ts), like the cart's (pos.ts).

// What the cashier ticked of one sale line: the quantity coming back, as typed, in the line's unit;
// for a serial product, the serial numbers ticked (its quantity is how many)
export interface ReturnPick {
  quantity: string;
  serials: string[];
}

// By the sale line's id. A line that is not here is not coming back.
export type ReturnPicks = Readonly<Record<string, ReturnPick>>;

// The serial numbers of a line that have not come back yet: the only ones offered
export function serialsLeft(line: PosReturnableLine): string[] {
  const back = new Set(line.returnedSerialNumbers);
  return line.serialNumbers.filter((serial) => !back.has(serial));
}

// A line with nothing left to return is shown, not offered ("All of it came back")
export function hasLeft(line: PosReturnableLine): boolean {
  return compareQuantity(returnableQuantityOf(line), '0') > 0;
}

// Ticking a line starts with one coming back, or all of it when less than one is left (a sale of
// 0.5 kg); a serial line starts with none ticked: the scanner or the cashier ticks them
export function firstPick(line: PosReturnableLine): ReturnPick {
  const left = returnableQuantityOf(line);
  if (line.tracking === 'serial') return { quantity: '0', serials: [] };
  return { quantity: compareQuantity(left, '1') >= 0 ? '1' : left, serials: [] };
}

function quantityOf(line: PosReturnableLine, pick: ReturnPick): string {
  return line.tracking === 'serial' ? String(pick.serials.length) : pick.quantity;
}

// One line as posReturnInputSchema reads it, with its money (posReturnAmounts, from what came back
// before). null for a line still being typed ("1.") or at 0.
export function returnLineOf(line: PosReturnableLine, pick: ReturnPick): PosReturnLineInput | null {
  const quantity = quantityOf(line, pick);
  if (!isQuantity(quantity) || compareQuantity(quantity, '0') <= 0) return null;
  const amounts = posReturnAmounts(line, quantity);
  return {
    saleLineId: line.id,
    quantity,
    net: amounts.net,
    vat: amounts.vat,
    serialNumbers: line.tracking === 'serial' ? pick.serials : [],
  };
}

// The lines ticked, each with its money
export function returnLinesOf(sale: PosReturnableSale, picks: ReturnPicks): PosReturnLineInput[] {
  return sale.lines.flatMap((line) => {
    const pick = picks[line.id];
    const back = pick && returnLineOf(line, pick);
    return back ? [back] : [];
  });
}

// "2" for the box from "2.0000": the arithmetic's 4 decimals without the zeros at the end
export function plainQuantity(quantity: string): string {
  const [whole = '0', fraction = ''] = quantity.split('.');
  const kept = fraction.replace(/0+$/, '');
  return kept === '' ? whole : `${whole}.${kept}`;
}

// What the lines pay back, with VAT
export function returnTotalOf(lines: readonly Pick<PosReturnLineInput, 'net' | 'vat'>[]): string {
  return sumMoney(lines.map((line) => addMoney(line.net, line.vat)));
}

// Why the sale cannot come back at this counter today: an error code the dialog says, or null.
// The window is the register's (decision 8); the server would take the return all the same and
// write the audit log, so this is the screen's rule.
export function saleProblem(
  sale: PosReturnableSale,
  today: string,
  register: Pick<SyncPosRegister, 'returnDays'>,
): 'pos_return_too_old' | 'pos_return_nothing_left' | null {
  if (!isWithinReturnWindow(sale.date, today, register.returnDays)) return 'pos_return_too_old';
  if (!sale.lines.some(hasLeft)) return 'pos_return_nothing_left';
  return null;
}

// Why the ticked lines cannot be paid back yet, with the line it is about: none ticked, or more
// than is left of one
export function picksProblem(
  sale: PosReturnableSale,
  picks: ReturnPicks,
): {
  code: 'pos_return_lines_required' | 'pos_return_quantity_too_large';
  line: string | null;
} | null {
  for (const line of sale.lines) {
    const pick = picks[line.id];
    if (!pick) continue;
    const quantity = quantityOf(line, pick);
    if (isQuantity(quantity) && compareQuantity(quantity, returnableQuantityOf(line)) > 0) {
      return { code: 'pos_return_quantity_too_large', line: line.id };
    }
  }
  if (returnLinesOf(sale, picks).length === 0) {
    return { code: 'pos_return_lines_required', line: null };
  }
  return null;
}

// An exchange's money on the new sale (decision 7): it pays the sale up to its total, never more;
// what is left over is paid back now, the return's other refund
export function exchangeSplit(credit: string, saleTotal: string): { used: string; rest: string } {
  const used = compareMoney(credit, saleTotal) > 0 ? saleTotal : credit;
  return { used: sumMoney([used]), rest: subtractMoney(credit, used) };
}

// ---------------------------------------------------------------------------------------------
// The return slip (pos-slips.tsx), printed by itself after the return

export interface ReturnSlipLine {
  key: string;
  name: string;
  quantity: string;
  decimals: number;
  unitCode: string;
  unitPrice: string;
  total: string;
  serialNumbers: string[];
}

export interface ReturnSlipData {
  number: string;
  returnedAt: string;
  registerCode: string;
  paperWidth: PosPaperWidth;
  receiptFooter: string | null;
  cashier: string;
  sale: { number: string; date: string };
  // null = walk-in
  customerName: string | null;
  lines: ReturnSlipLine[];
  net: string;
  vat: string;
  total: string;
  // How the money went back; an exchange's money is "Used on sale POS1-000188" instead
  refunds: { method: PosTender; amount: string; reference: string | null }[];
  usedOn: string | null;
  note: string | null;
}

// A unit's code and decimals, from the copy (the screen reads the units once)
export type UnitOf = (unitId: string) => { code: string; decimals: number } | undefined;

export function returnSlipOf(input: {
  number: string;
  returnedAt: string;
  register: Pick<SyncPosRegister, 'code' | 'paperWidth' | 'receiptFooter'>;
  cashier: string;
  sale: PosReturnableSale;
  lines: readonly PosReturnLineInput[];
  refunds: ReturnSlipData['refunds'];
  usedOn: string | null;
  note: string | null;
  unitOf: UnitOf;
}): ReturnSlipData {
  const { sale, register } = input;
  return {
    number: input.number,
    returnedAt: input.returnedAt,
    registerCode: register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: input.cashier,
    sale: { number: sale.number, date: sale.date },
    customerName: sale.customer?.name ?? null,
    lines: input.lines.flatMap((line) => {
      const sold = sale.lines.find((one) => one.id === line.saleLineId);
      if (!sold) return [];
      const unit = input.unitOf(sold.unitId);
      return [
        {
          key: line.saleLineId,
          name: sold.description,
          quantity: line.quantity,
          decimals: unit?.decimals ?? 0,
          unitCode: unit?.code ?? '',
          unitPrice: sold.unitPrice,
          total: addMoney(line.net, line.vat),
          serialNumbers: line.serialNumbers,
        },
      ];
    }),
    net: sumMoney(input.lines.map((line) => line.net)),
    vat: sumMoney(input.lines.map((line) => line.vat)),
    total: returnTotalOf(input.lines),
    refunds: input.refunds.filter((refund) => refund.method !== 'exchange'),
    usedOn: input.usedOn,
    note: input.note,
  };
}
