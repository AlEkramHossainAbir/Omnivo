import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '../lib/cn.js';
import { niceTicks } from '../lib/ticks.js';

// Step 21a (decision 8): our own small SVG line chart, no chart library. CLAUDE.md → Charts: a 2px
// brand line, a brand area fading from 14% to 0, dashed line-colored gridlines, 11px ink-3 axis
// labels, an emphasized end point, and a hover crosshair with a tooltip. Only the pages that draw a
// chart import it, and each of them is a lazy route, so none of this is in the first download.

export interface LineChartPoint {
  // React's key: the day ("2026-10-29")
  key: string;
  // A decimal string, like every amount. The chart turns it into a number only to place the point:
  // a pixel has no paisa. What the person reads comes from formatValue(), from the string.
  value: string;
  // The tooltip's name of the point ("29 Oct 2026") and the axis's shorter one ("29 Oct")
  label: string;
  axisLabel: string;
}

interface LineChartProps {
  // The chart's name for a screen reader: what it shows, from when to when
  label: string;
  points: readonly LineChartPoint[];
  // The axis and the tooltip: "৳2,00,000"
  formatValue: (value: string) => string;
  height?: number;
  className?: string;
}

// The width of the box the chart sits in, in pixels. The chart is drawn at that width (not scaled
// from a viewBox), so its 11px labels stay 11px on a phone. ResizeObserver tells the first width
// too, before the first paint.
function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

const TOP = 12;
const BOTTOM = 26;
const RIGHT = 8;
// About the width of one 11px digit: the left margin fits the longest gridline label
const CHAR_WIDTH = 6.6;

export function LineChart({ label, points, formatValue, height = 220, className }: LineChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const fillId = useId();
  // The point under the pointer or chosen with the arrow keys; null = none
  const [active, setActive] = useState<number | null>(null);

  const values = points.map((point) => Number(point.value));
  const ticks = niceTicks(values);
  const low = ticks[0] ?? 0;
  const high = ticks[ticks.length - 1] ?? 1;
  const tickLabels = ticks.map((tick) => formatValue(tick.toFixed(4)));
  const left = Math.ceil(Math.max(...tickLabels.map((text) => text.length)) * CHAR_WIDTH) + 12;
  const plotWidth = Math.max(width - left - RIGHT, 1);
  const plotBottom = height - BOTTOM;
  const last = points.length - 1;

  const x = (index: number) => left + (last > 0 ? (index * plotWidth) / last : plotWidth / 2);
  const y = (value: number) => TOP + ((high - value) / (high - low)) * (plotBottom - TOP);

  const line = values
    .map(
      (value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`,
    )
    .join(' ');
  // The area closes on the zero line, so a day below zero is filled up to it, not down to the axis
  const area = `${line} L${x(last).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  // Five labels on a wide chart, three on a phone; the first and the last always
  const labelCount = Math.min(width >= 480 ? 5 : 3, points.length);
  const labelIndexes =
    labelCount < 2
      ? [0]
      : Array.from({ length: labelCount }, (_, i) => Math.round((i * last) / (labelCount - 1)));

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (last < 0) return;
    const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const index = Math.round(((offset - left) / plotWidth) * last);
    setActive(Math.min(Math.max(index, 0), last));
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? last;
    const next =
      event.key === 'ArrowLeft'
        ? from - 1
        : event.key === 'ArrowRight'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(Math.min(Math.max(next, 0), last));
  };

  const shown = active === null ? undefined : points[active];
  const shownValue = active === null ? 0 : (values[active] ?? 0);
  // The tooltip stays inside the box: 64px is about half of its width
  const tipLeft = Math.min(Math.max(x(active ?? 0), 64), Math.max(width - 64, 64));

  return (
    // The box takes the focus, not the SVG: a screen reader hears the chart's name, and the arrow
    // keys walk the days; the live region below says each one
    <div
      ref={box}
      role="group"
      aria-label={label}
      tabIndex={0}
      onKeyDown={move}
      onFocus={() => {
        setActive((current) => current ?? last);
      }}
      onBlur={() => {
        setActive(null);
      }}
      className={cn('relative rounded-control outline-none focus-visible:shadow-ring', className)}
      style={{ height }}
    >
      {width > 0 && points.length > 0 && (
        <svg
          width={width}
          height={height}
          aria-hidden="true"
          className="block touch-pan-y overflow-visible"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => {
            setActive(null);
          }}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--brand)', stopOpacity: 0.14 }} />
              <stop offset="1" style={{ stopColor: 'var(--brand)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {ticks.map((tick, index) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-line"
                strokeDasharray={tick === 0 ? undefined : '3 4'}
              />
              <text
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-ink-3 text-micro tabular-nums"
              >
                {tickLabels[index]}
              </text>
            </g>
          ))}
          {labelIndexes.map((index, position) => (
            <text
              key={index}
              x={x(index)}
              y={height - 6}
              textAnchor={
                position === 0 ? 'start' : position === labelIndexes.length - 1 ? 'end' : 'middle'
              }
              className="fill-ink-3 text-micro"
            >
              {points[index]?.axisLabel}
            </text>
          ))}
          <path d={area} fill={`url(#${fillId})`} />
          <path
            d={line}
            className="fill-none stroke-brand"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {active !== null && (
            <>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={TOP}
                y2={plotBottom}
                className="stroke-ink-3"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(active)}
                cy={y(shownValue)}
                r={4}
                className="fill-surface stroke-brand"
                strokeWidth={2}
              />
            </>
          )}
          {/* The end point: today */}
          <circle
            cx={x(last)}
            cy={y(values[last] ?? 0)}
            r={4.5}
            className="fill-brand stroke-surface"
            strokeWidth={2}
          />
        </svg>
      )}
      {shown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-md"
          style={{ left: tipLeft, top: y(shownValue) - 10 }}
        >
          <div className="text-caption text-ink-3">{shown.label}</div>
          <div className="text-body-sm font-semibold tabular-nums">{formatValue(shown.value)}</div>
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {shown && `${shown.label}: ${formatValue(shown.value)}`}
      </span>
    </div>
  );
}
