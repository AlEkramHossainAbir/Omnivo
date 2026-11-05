import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { cn } from '../lib/cn.js';

interface StepperProps {
  // The list's name for screen readers ("Setup steps")
  label: string;
  steps: readonly string[];
  // 0-based index of the step on screen
  current: number;
}

// CLAUDE.md → Stepper: numbered 26px circles (valid here: the steps are a real sequence). Current
// = brand border and ring; done = filled brand with a tick. It only shows where you are — moving
// between steps is the wizard's job, so nothing here is clickable.
export function Stepper({ label, steps, current }: StepperProps) {
  return (
    <ol aria-label={label} className="flex items-center gap-2">
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li
            key={step}
            // "step" is the ARIA value for the current item of a process
            aria-current={state === 'current' ? 'step' : undefined}
            // relative: the phone's sr-only step names stay inside this item (see Checkbox)
            className="relative flex min-w-0 items-center gap-2"
          >
            <span
              className={cn(
                'grid size-[26px] shrink-0 place-items-center rounded-full border text-caption font-semibold tabular-nums',
                state === 'done' && 'border-brand bg-brand text-brand-ink',
                state === 'current' && 'border-brand bg-surface text-brand shadow-ring',
                state === 'todo' && 'border-line-strong bg-surface text-ink-3',
              )}
            >
              {state === 'done' ? (
                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.5} />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                'truncate text-body-sm font-medium',
                state === 'todo' ? 'text-ink-3' : 'text-ink',
                // On phones only the current step keeps its name; three names do not fit in 358px
                state !== 'current' && 'max-sm:sr-only',
              )}
            >
              {step}
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className="h-px w-5 shrink-0 bg-line sm:w-8" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
