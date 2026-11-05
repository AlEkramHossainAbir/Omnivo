import { useLocale } from '@omnivo/i18n';

import { reloadApp, useUpdateState } from '../lib/app-update';

// Step 19a (decision 3): "A new version is ready · Reload". Outside the router (main.tsx), so it
// stays on every page, the sign-in page too, and a page change never hides it. Fixed in a corner
// in the toast's look: it never moves the page under an open form. It cannot be closed: it says
// what will happen, and in another tab's case this tab's next page needs the reload.
export function UpdateNotice() {
  const { t } = useLocale();
  const state = useUpdateState();
  if (state === 'none') return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md flex-wrap items-center gap-x-4 gap-y-2 rounded-control bg-ink px-4 py-3 text-body-sm text-bg shadow-lg sm:right-6 sm:bottom-6 sm:left-auto"
    >
      <span className="min-w-0 flex-1">
        {state === 'other-tab' ? t('shell.update.otherTab') : t('shell.update.ready')}
      </span>
      <button
        type="button"
        disabled={state === 'reloading'}
        onClick={reloadApp}
        className="h-9 shrink-0 rounded-lg bg-bg px-3 font-medium text-ink transition-colors duration-150 hover:bg-subtle"
      >
        {state === 'reloading' ? t('shell.update.reloading') : t('common.reload')}
      </button>
    </div>
  );
}
