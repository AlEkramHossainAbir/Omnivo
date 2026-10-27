import {
  DeliveryTruck01Icon,
  FactoryIcon,
  Medicine02Icon,
  TShirtIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Logo } from '@omnivo/ui';
import type { ReactNode } from 'react';

import { AuthPreview } from './auth-preview';
import { LanguageSwitch } from './language-switch';

// key-টা অনুবাদের, লেখা না — ভাষা বদলালে সাথে সাথে বদলায়
const INDUSTRIES = [
  { icon: TShirtIcon, key: 'garments' },
  { icon: Medicine02Icon, key: 'pharma' },
  { icon: DeliveryTruck01Icon, key: 'distribution' },
  { icon: FactoryIcon, key: 'manufacturing' },
] as const;

// Step 19b: the sign-in page's layout, moved here from login.tsx so the lock screen (decision 7)
// uses the same one: the form on the left, in a 380px column, and the side panel on wide screens.
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="grid min-h-dvh bg-surface min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="flex flex-col px-4 py-8 sm:px-16">
        <Logo />
        <div className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-[380px]">{children}</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
          <LanguageSwitch />
        </div>
      </section>

      <aside
        aria-label={t('auth.login.panelLabel')}
        className="relative m-3 ml-0 hidden flex-col justify-center gap-10 overflow-hidden rounded-panel border border-brand-line bg-brand-soft px-[clamp(24px,5vw,72px)] py-14 min-[1040px]:flex"
      >
        <div aria-hidden="true" className="auth-grid pointer-events-none absolute inset-0" />
        {/* গ্রিড absolute, তাই লেখাকেও relative না দিলে লাইন লেখার উপরে আঁকা হতো */}
        <div className="relative max-w-lg">
          <h2 className="text-display tracking-[-0.03em]">{t('auth.login.panelTitle')}</h2>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">{t('auth.login.panelBody')}</p>
          <ul className="mt-[18px] flex flex-wrap gap-2">
            {INDUSTRIES.map((industry) => (
              <li
                key={industry.key}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
              >
                <HugeiconsIcon
                  icon={industry.icon}
                  size={14}
                  strokeWidth={1.5}
                  className="text-brand"
                />
                {t(`auth.login.industries.${industry.key}`)}
              </li>
            ))}
          </ul>
        </div>
        <AuthPreview />
      </aside>
    </div>
  );
}
