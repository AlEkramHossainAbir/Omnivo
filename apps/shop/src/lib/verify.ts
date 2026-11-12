import type { ShopOrderConfirmed } from '@omnivo/contracts';

// Step 26c: the pure parts of /checkout/verify's script, here so they can be tested without a
// browser. Like quote.ts, nothing here may import Zod, the contracts' values or i18next: the
// script ships to the shopper (src/boundaries.spec.ts checks it).

// A Bangla keyboard types ০–৯; a code pasted from an SMS may hold spaces ("123 456"). The box keeps
// the ASCII digits only, at most `length` of them, so what the shopper sees is what is sent
export function codeDigits(text: string, length: number): string {
  return text
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/\D/g, '')
    .slice(0, length);
}

// "Resend code in 0:45". Minutes without a leading zero, seconds with one, in the shop's digits
// ('bn-BD' writes ০:৪৫). Never below 0:00: a timer that fires late shows zero, not "-0:01"
export function waitText(seconds: number, numberLocale: string): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = new Intl.NumberFormat(numberLocale, { useGrouping: false });
  const two = new Intl.NumberFormat(numberLocale, { minimumIntegerDigits: 2, useGrouping: false });
  return `${minutes.format(Math.floor(total / 60))}:${two.format(total % 60)}`;
}

// "{{count}} tries left." with its value. Every {{name}} is replaced, not only the first
export function fillWords(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The two parts of a problem answer (server/problem.ts) the page acts on. Anything else (a proxy's
// HTML error page, a body cut short) is null, and the page shows its "not sent" line
export interface ProblemParts {
  code: string;
  params: Record<string, unknown>;
}

export function problemParts(body: unknown): ProblemParts | null {
  if (!isRecord(body) || typeof body.code !== 'string') return null;
  return { code: body.code, params: isRecord(body.params) ? body.params : {} };
}

// A right code's answer. Hand-written for the same reason as quote.ts's guard: the order number
// goes into a link, so it must be a string, and the phone into the dialog's sentence
export function isOrderConfirmed(body: unknown): body is ShopOrderConfirmed {
  return (
    isRecord(body) &&
    typeof body.orderNo === 'string' &&
    body.orderNo !== '' &&
    typeof body.phone === 'string' &&
    body.phone !== ''
  );
}

// "Resend code" answers with the seconds until the next one; a 429 says the same in its params
export function resendSeconds(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const value = isRecord(body.params) ? body.params.seconds : body.resendInSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
