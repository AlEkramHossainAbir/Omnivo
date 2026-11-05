import type { EntryRef } from '@omnivo/contracts';
import { Link } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';

// The journal entries a stock document made (step 14), in a fact cell: a link to each for someone
// who reads the journal, the plain numbers for everyone else (the journal page would refuse them)
export function EntryLinks({
  label,
  entries,
  none,
}: {
  label: string;
  entries: readonly EntryRef[];
  none: string;
}) {
  const canRead = useCan()('accounting.journal.read');
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption font-medium text-ink-3">{label}</span>
      {entries.length === 0 ? (
        <span className="text-body-sm text-ink-3">{none}</span>
      ) : (
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-body-sm">
          {entries.map((entry) =>
            canRead ? (
              <Link
                key={entry.id}
                to="/journal/$entryId"
                params={{ entryId: entry.id }}
                className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
              >
                {entry.number}
              </Link>
            ) : (
              <span key={entry.id} className="font-mono tabular-nums">
                {entry.number}
              </span>
            ),
          )}
        </span>
      )}
    </div>
  );
}
