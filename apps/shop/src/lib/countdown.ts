// Step 26b: the sale countdown's text, "01 : 12 : 10 : 32" (days : hours : minutes : seconds), as
// Figma writes it. The server draws the first value and the browser the rest, with this one
// function, so the two can never show different text at the hand-over.

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// `locale` is a number locale ('en-IN', 'bn-BD'): a Bangla shop counts down in Bangla digits.
// The time left is never below zero: a clock that ran past the end shows zeros, not "-1"
export function countdownText(msLeft: number, locale: string): string {
  const total = Math.max(0, Math.floor(msLeft / SECOND));
  const parts = [
    Math.floor(total / DAY),
    Math.floor((total % DAY) / HOUR),
    Math.floor((total % HOUR) / MINUTE),
    total % MINUTE,
  ];
  // Two digits at least, so the text does not jump in width when 10 becomes 9. A sale of 100
  // days or more shows its three digits. useGrouping off: never "1,000" days
  const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return parts.map((part) => two.format(part)).join(' : ');
}
