import { CheckmarkCircle02Icon, ScissorIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { cx } from '../lib/cx';
import { Pill } from './pill';

// auth side panel-এর product preview — নকল data দিয়ে আসল UI-এর ছোট ছবি।
// illustration, তাই mockup-এর ছোট size (20 / 12.5 / 11.5px) শুধু এই ফাইলে (CLAUDE.md → Typography)
const BAR_HEIGHTS = [48, 62, 55, 70, 66, 81, 94];
const DAYS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];

const card = 'rounded-card border border-line bg-surface shadow-lg';

export function AuthPreview() {
  return (
    <div aria-hidden="true" className="relative max-w-[560px] pt-[34px] pb-9">
      <div className={cx(card, 'p-5')}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-brand text-[12.5px] font-semibold text-brand-ink">
              RG
            </span>
            <div>
              <b className="block text-[14px] font-semibold">Rahman Garments Ltd.</b>
              <small className="block text-caption text-ink-3">Gazipur · Today</small>
            </div>
          </div>
          <Pill tone="good" icon={CheckmarkCircle02Icon}>
            Synced
          </Pill>
        </div>

        <div className="mt-[18px] grid grid-cols-2 gap-3">
          <div className="rounded-control bg-subtle px-3.5 py-3">
            <span className="block text-caption text-ink-3">Sales this week</span>
            <span className="mt-0.5 block text-[20px] font-semibold tracking-[-0.02em] tabular-nums">
              ৳84,23,500
            </span>
            <span className="text-caption text-good">+12.4% vs last week</span>
          </div>
          <div className="rounded-control bg-subtle px-3.5 py-3">
            <span className="block text-caption text-ink-3">Receivables</span>
            <span className="mt-0.5 block text-[20px] font-semibold tracking-[-0.02em] tabular-nums">
              ৳3,12,40,000
            </span>
            <span className="text-caption text-ink-3">14 open invoices</span>
          </div>
        </div>

        <div className="mt-[18px] flex h-[84px] items-end gap-2 border-b border-line pt-1">
          {BAR_HEIGHTS.map((height, index) => (
            <i
              key={DAYS[index]}
              // শেষ দিন (আজ) brand, বাকিগুলো de-emphasized brand-line (CLAUDE.md → Charts)
              className={cx(
                'flex-1 rounded-t',
                index === BAR_HEIGHTS.length - 1 ? 'bg-brand' : 'bg-brand-line',
              )}
              style={{ height: `${String(height)}%` }}
            />
          ))}
        </div>
        <div className="mt-1.5 flex gap-2">
          {DAYS.map((day) => (
            <span key={day} className="flex-1 text-center text-micro text-ink-3">
              {day}
            </span>
          ))}
        </div>
      </div>

      {/* aside-এর padding ৭২px, তাই -28px offset কাটা পড়ে না */}
      <div className={cx(card, 'absolute -right-7 bottom-0 w-[min(270px,62%)] px-4 py-3.5')}>
        <div className="flex items-center justify-between gap-2">
          <b className="text-label font-semibold">PO-1182 · Knit polo</b>
          <Pill tone="brand" icon={ScissorIcon}>
            Cutting
          </Pill>
        </div>
        <p className="mt-1 text-caption font-normal text-ink-2">
          Buyer order · 4,800 pcs · ship by 18 Oct
        </p>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-md bg-subtle">
          <i className="block h-full w-[62%] rounded-md bg-brand" />
        </div>
        <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3 tabular-nums">
          <span>2,976 of 4,800 cut</span>
          <span>62%</span>
        </div>
      </div>

      <div
        className={cx(card, 'absolute -top-1.5 -left-7 flex items-center gap-2.5 px-3.5 py-2.5')}
      >
        <span className="grid size-7 place-items-center rounded-full bg-good-bg text-good">
          <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} />
        </span>
        <div>
          <b className="block text-[12.5px] font-semibold">LC 0126-2409 accepted</b>
          <small className="block text-[11.5px] text-ink-3">Export proceeds · $48,200</small>
        </div>
      </div>
    </div>
  );
}
