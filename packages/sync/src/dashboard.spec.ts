import 'fake-indexeddb/auto';

import { DASHBOARD_TREND_DAYS, type Dashboard } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { keepDashboard, keptDashboard } from './dashboard.js';
import { newCopy } from './test-fixtures.js';

const BRANCH = '01928c4e-7777-7000-8000-0000000000b1';

function answer(today: string): Dashboard {
  return {
    today,
    generatedAt: `${today}T04:42:00.000Z`,
    branchId: BRANCH,
    sales: {
      today: '184250.0000',
      yesterday: '163900.0000',
      monthToDate: '692400.0000',
      lastMonthToDate: '631800.0000',
      days: Array.from({ length: DASHBOARD_TREND_DAYS }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, '0')}`,
        amount: '0.0000',
      })),
    },
    margin: null,
    cash: null,
    topProducts: null,
    receivables: { total: '486750.0000', overdue: '112400.0000', overdueCount: 7 },
    payables: null,
    lowStock: null,
  };
}

describe('the kept Overview (step 21a)', () => {
  it('has nothing before the page was ever online', async () => {
    expect(await keptDashboard(await newCopy())).toBeNull();
  });

  it('keeps the last answer, sealed, and gives it back with its branch', async () => {
    const copy = await newCopy();
    await keepDashboard(copy, answer('2026-11-03'), null);
    await keepDashboard(copy, answer('2026-11-04'), 'MIR · Mirpur store');

    expect(await keptDashboard(copy)).toEqual({
      dashboard: answer('2026-11-04'),
      branchName: 'MIR · Mirpur store',
    });
    // One row, and only its key is clear: the numbers and the branch's name are in the box
    const rows = await copy.db.dashboard.toArray();
    expect(rows.map((row) => Object.keys(row).sort())).toEqual([['box', 'key']]);
    const clear = new TextDecoder().decode(rows[0]?.box);
    expect(clear).not.toContain('486750');
    expect(clear).not.toContain('Mirpur');
  });

  it('treats a row changed on the disk as nothing kept', async () => {
    const copy = await newCopy();
    await keepDashboard(copy, answer('2026-11-04'), null);
    const row = await copy.db.dashboard.get('dashboard');
    if (!row) throw new Error('No row');
    // One byte of the sealed body changed: AES-GCM's check fails, so the box does not open
    const changed = row.box.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    await copy.db.dashboard.put({ key: 'dashboard', box: changed });

    expect(await keptDashboard(copy)).toBeNull();
  });
});
