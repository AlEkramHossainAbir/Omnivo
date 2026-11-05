import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';

// ফিল্ডে বসানো যায় না এমন error (ভুল পাসওয়ার্ড, নেটওয়ার্ক) — রঙের সাথে আইকন আর লেখা।
// message একটা error code হলে ('invalid_credentials') বর্তমান ভাষায়, নাহলে যেমন আছে
export function FormAlert({ message }: { message: string }) {
  const { errorText } = useLocale();
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-crit/30 bg-crit-bg px-3 py-2.5 text-body-sm text-crit"
    >
      <HugeiconsIcon icon={Alert02Icon} size={17} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(message)}
    </p>
  );
}
