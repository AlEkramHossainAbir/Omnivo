import { describe, expect, it } from 'vitest';

import { exportIdFor } from './report-schedule-run.handler.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An outbox event's id, as the sweep's emit() writes it: a UUIDv7 of 10 Nov 2026
const eventId = '019a6ccf-3a80-7c2e-9b41-5d2f0e8a7c13';
const mitu = '019a1b2c-0000-7000-8000-000000000001';
const jahid = '019a1b2c-0000-7000-8000-000000000002';

describe("the id of one person's file of one run", () => {
  it('is the same every time, so a second run of the job inserts nothing', () => {
    expect(exportIdFor(eventId, mitu)).toBe(exportIdFor(eventId, mitu));
  });

  it('differs per person and per run', () => {
    const ids = new Set([
      exportIdFor(eventId, mitu),
      exportIdFor(eventId, jahid),
      exportIdFor('019a6ccf-3a80-7c2e-9b41-5d2f0e8a7c14', mitu),
    ]);
    expect(ids.size).toBe(3);
  });

  it("is a UUIDv7 with the event's time, so the Exports page sorts it with the others", () => {
    for (const userId of [mitu, jahid]) {
      const id = exportIdFor(eventId, userId);
      expect(id).toMatch(UUID_V7);
      // The first 48 bits are the time
      expect(id.slice(0, 13)).toBe(eventId.slice(0, 13));
    }
    // A later event's files sort after an earlier one's
    const later = '019a6cd0-0000-7000-8000-000000000000';
    expect(exportIdFor(later, mitu) > exportIdFor(eventId, jahid)).toBe(true);
  });
});
