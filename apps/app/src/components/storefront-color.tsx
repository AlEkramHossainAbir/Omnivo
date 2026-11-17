import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { contrastRatio, formatContrast } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { controlBoxClass, Pill } from '@omnivo/ui';
import type { Ref } from 'react';

// Step 26h: a color box and the contrast lines under it (decisions 3 and 11). The box is a swatch
// that opens the browser's own palette (<input type="color">) and the code beside it, which can be
// typed or pasted ("#005859"). Both edit the same form value, so the schema checks one string.

const HEX = /^#[0-9a-f]{6}$/i;

// What FormField hands its child (id, value, onChange, the error state), for a string value
export interface ColorInputProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  ref?: Ref<HTMLInputElement>;
  invalid: boolean;
  'aria-describedby': string | undefined;
  // The box's label, for the swatch's own name: "Pick Brand color on a palette"
  label: string;
}

export function ColorInput({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid,
  'aria-describedby': describedBy,
  label,
}: ColorInputProps) {
  const { t } = useLocale();
  // The palette takes only a whole color: while the code is half typed ("#00585") the palette
  // opens on black, and the swatch is empty until the code is whole again
  const whole = HEX.test(value);
  return (
    <div className={controlBoxClass(invalid)}>
      <span className="relative -ml-1 size-6.5 shrink-0 overflow-hidden rounded-lg border border-line-strong">
        {/* The swatch's color is the tenant's own value, which no token can name */}
        <span className="absolute inset-0" style={whole ? { background: value } : undefined} />
        <input
          type="color"
          aria-label={t('storefront.color.palette', { name: label })}
          value={whole ? value.toLowerCase() : '#000000'}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        ref={ref}
        id={id}
        name={name}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onBlur={onBlur}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        className="min-w-0 flex-1 bg-transparent py-2.5 font-mono text-body outline-none"
      />
    </div>
  );
}

export interface ContrastLine {
  label: string;
  // The two colors the line compares, as the boxes hold them now
  first: string;
  second: string;
  // CONTRAST_TEXT (4.5) or CONTRAST_LARGE_TEXT (3)
  min: number;
}

// The checks as the person types: the ratio, the minimum and a pill. The API runs the same
// contrastRatio on save, so a line that says "Easy to read" never meets a refusal
export function ContrastList({ lines }: { lines: readonly ContrastLine[] }) {
  const { t } = useLocale();
  return (
    <ul className="rounded-control border border-line">
      {lines.map((line) => {
        const whole = HEX.test(line.first) && HEX.test(line.second);
        const ratio = whole ? contrastRatio(line.first, line.second) : null;
        return (
          <li
            key={line.label}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3.5 py-2.5 first:border-t-0"
          >
            <span className="mr-auto text-body-sm text-ink-2">{line.label}</span>
            {ratio !== null && (
              <>
                <span className="text-caption font-normal text-ink-3 tabular-nums">
                  {t('storefront.color.ratio', {
                    ratio: formatContrast(ratio),
                    min: `${String(line.min)}:1`,
                  })}
                </span>
                {ratio >= line.min ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('storefront.color.ok')}
                  </Pill>
                ) : (
                  <Pill tone="crit" icon={Alert02Icon}>
                    {t('storefront.color.low')}
                  </Pill>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
