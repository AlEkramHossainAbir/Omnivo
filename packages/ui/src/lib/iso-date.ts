// ফর্ম আর API-তে তারিখ "2026-09-23" (ISO date, সময় নেই)। দুই দিকেই local অংশ দিয়ে:
// new Date('2026-09-23') UTC মধ্যরাত ধরে, আর toISOString() UTC-তে লেখে — ঢাকায় (UTC+6)
// local মধ্যরাত মানে UTC-তে আগের দিন সন্ধ্যা ৬টা, ফলে তারিখ এক দিন পিছিয়ে "2026-09-22" হতো
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): Date | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function toIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
