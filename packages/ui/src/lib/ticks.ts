// Step 21a: the chart's gridlines (line-chart.tsx), apart from the component so a test can reach it
// without React.

// The gridlines' values: 0 and a few round steps (1, 2 or 5 times a power of ten) that hold every
// point. A day with more returns than sales is below zero, so the steps go below zero too.
export function niceTicks(values: readonly number[], count = 3): number[] {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  // Nothing but zeros: one step of 1, so the line lies on the bottom gridline
  if (high === low) return [0, 1];
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((times) => times * power).find((size) => size >= raw) ?? raw;
  const first = Math.floor(low / step);
  const last = Math.ceil(high / step);
  return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step);
}
