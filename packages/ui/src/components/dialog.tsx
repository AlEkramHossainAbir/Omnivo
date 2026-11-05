import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { IconButton } from './button.js';

// Radix: খোলার সময় focus ভেতরে যায় আর Tab ভেতরেই ঘোরে, Esc-এ বন্ধ, বন্ধ হলে focus আবার trigger-এ,
// পেছনের পেজ scroll হয় না আর স্ক্রিন রিডারের কাছে লুকানো — এগুলো হাতে লিখলে প্রতিটাই আলাদা bug
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  // নিচের বাটনের সারি (বাতিল + একটা primary)
  footer?: ReactNode;
  className?: string | undefined;
}

// CLAUDE.md → Dialog: surface, ১px line, ১৪px কোণ, shadow-lg, সর্বোচ্চ ৫২০px; শিরোনাম কার্ডের মতো
// ১৫px/600। ফোনে দুই পাশে ১৬px ফাঁক রেখে পুরো চওড়া, লম্বা হলে ভেতরে scroll — পেজ আড়াআড়ি নড়ে না
export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: DialogContentProps) {
  const { t } = useLocale();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        // description না থাকলে Radix console-এ সতর্ক করে; undefined দিলে বোঝে ইচ্ছাকৃত
        {...(description === undefined && { 'aria-describedby': undefined })}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-card border border-line bg-surface p-[18px] shadow-lg outline-none sm:p-6',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-h3">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="text-label text-ink-3">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton icon={Cancel01Icon} label={t('common.close')} className="-m-2 shrink-0" />
          </DialogPrimitive.Close>
        </header>
        {children}
        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {footer}
          </footer>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
