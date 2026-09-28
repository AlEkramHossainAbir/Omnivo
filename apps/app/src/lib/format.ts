// CLAUDE.md: UI-তে তারিখ "23 Sep 2026"। en-GB নতুন ICU-তে "Sept" লেখে, তাই en-US-এর অংশ
// নিয়ে নিজেরা সাজানো — ব্রাউজার/OS ভেদে একই ফল
const dateParts = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDate(date: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    dateParts.formatToParts(date).find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}
