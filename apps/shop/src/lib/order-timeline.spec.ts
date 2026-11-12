import { describe, expect, it } from 'vitest';

import { orderTimeline } from './order-timeline';

describe('orderTimeline', () => {
  const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, '0')}:00+06:00`;

  it('marks the steps behind, the one it is at, and the ones ahead', () => {
    const steps = orderTimeline({
      status: 'confirmed',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'confirmed', at: at(2) },
      ],
    });
    expect(steps.map(({ status, state }) => [status, state])).toEqual([
      ['pending', 'done'],
      ['confirmed', 'current'],
      ['packed', 'later'],
      ['shipped', 'later'],
      ['delivered', 'later'],
    ]);
    expect(steps[1]?.at).toBe(at(2));
    expect(steps[2]?.at).toBeNull();
  });

  it('draws a delivered order as all done', () => {
    const steps = orderTimeline({
      status: 'delivered',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'shipped', at: at(30) },
        { status: 'delivered', at: at(50) },
      ],
    });
    expect(steps.every((step) => step.state === 'done')).toBe(true);
    // Skipped steps are behind it, with no date
    expect(steps.find((step) => step.status === 'packed')?.at).toBeNull();
  });

  it('ends a cancelled order on the cancel, with nothing ahead', () => {
    const steps = orderTimeline({
      status: 'cancelled',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'confirmed', at: at(2) },
        { status: 'cancelled', at: at(9) },
      ],
    });
    expect(steps.map(({ status, state }) => [status, state])).toEqual([
      ['pending', 'done'],
      ['confirmed', 'done'],
      ['cancelled', 'current'],
    ]);
  });
});
