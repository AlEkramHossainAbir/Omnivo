import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import type { CheckoutChoice } from './words';

// Step 26c: the checkout's form parts (CLAUDE.md → Storefront → Checkout card). Labels 16px/600
// brand, 12px above their control; errors under the control in `promo` with an Alert02 icon.

export function FieldError({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sf-small font-medium text-promo">
      {/* mt: the 16px icon sits on the first line of a 24px line height, not above it */}
      <HugeiconsIcon
        icon={Alert02Icon}
        size={16}
        strokeWidth={1.5}
        className="mt-1 shrink-0"
        aria-hidden="true"
      />
      <span>{text}</span>
    </p>
  );
}

// An input with its label and error. Everything else (register's name, onChange, onBlur and ref,
// type, autoComplete) goes to the <input> as it is: React 19 passes `ref` like any other prop
type TextFieldProps = ComponentProps<'input'> & { label: string; error: string | undefined };

export function TextField({ label, error, ...input }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-3">
      {/* Trimmed (as Figma draws it): the input starts 23px under the label's top, not 32px */}
      <label htmlFor={id} className="trim-text font-semibold">
        {label}
      </label>
      {/* Figma: 48px, white, a 1px #E9E9E9 border, radius 8. The error border is promo, so the
          field that needs fixing is found without reading every message */}
      <input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className="h-12 w-full min-w-0 rounded-lg border border-field bg-card px-4 transition-colors duration-150 placeholder:text-muted hover:border-muted-line focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand aria-invalid:border-promo"
        {...input}
      />
      {error !== undefined && <FieldError id={errorId} text={error} />}
    </div>
  );
}

// A group of radio cards: Delivery Location, Payment Method. The whole card is the <label>, so a
// tap anywhere on it picks it. The radio is a real <input type="radio">: the arrow keys move
// between the cards and a screen reader says "1 of 2", which a styled <div> would not
interface RadioCardsProps {
  legend: string;
  choices: CheckoutChoice[];
  field: UseFormRegisterReturn;
  error: string | undefined;
  // A line under the cards ("Free delivery on orders over ৳1,000")
  hint?: ReactNode;
}

export function RadioCards({ legend, choices, field, error, hint }: RadioCardsProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <fieldset aria-describedby={error === undefined ? undefined : errorId}>
      <legend className="trim-text font-semibold">{legend}</legend>
      {/* Two cards side by side from md (Figma), one column on a phone */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {choices.map((choice) => (
          <label
            key={choice.id}
            // The focus ring goes around the card, not the 24px circle; the radio's own outline is
            // turned off below
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-cream px-[30px] py-5 font-semibold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand"
          >
            {/* Figma: a 24px circle, a brand ring, a brand dot when picked. The dot is the
                background; a 4px inset shadow in the card's white makes the gap around it */}
            <input
              type="radio"
              value={choice.id}
              className="size-6 shrink-0 appearance-none rounded-full border-[1.5px] border-brand bg-card checked:bg-brand checked:shadow-[inset_0_0_0_4px_var(--color-card)] focus-visible:outline-none"
              {...field}
            />
            {choice.label}
          </label>
        ))}
      </div>
      {hint}
      {error !== undefined && (
        <div className="mt-3">
          <FieldError id={errorId} text={error} />
        </div>
      )}
    </fieldset>
  );
}
