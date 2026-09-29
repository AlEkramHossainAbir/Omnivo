import { type Preferences, routes, type UpdatePreferencesInput } from '@omnivo/contracts';
import { i18n, setLanguage } from '@omnivo/i18n';
import { toast } from '@omnivo/ui';

import { call } from './api';
import { sessionStore } from './session-store';
import { applyTheme } from './theme';

// লগইনের পরে: সার্ভারে সেভ করা পছন্দ এই ডিভাইসে। language null = ইউজার কখনো বাছেনি — তখন লগইন পেজে
// যে ভাষা চলছিল সেটাই থাকে, জোর করে ইংরেজিতে ফেরানো হয় না
export async function applyPreferences(preferences: Preferences): Promise<void> {
  applyTheme(preferences.theme);
  if (preferences.language !== null) await setLanguage(preferences.language);
}

// আগে এই ডিভাইসে (সাথে সাথে দেখা যায়), তারপর সার্ভারে। সার্ভার ব্যর্থ হলে ডিভাইসের বদল থাকে, শুধু
// জানানো হয় যে অন্য ডিভাইসে যাবে না — ভাষা বদলানোর মতো কাজ নেটওয়ার্কের জন্য আটকে থাকে না
export async function savePreference(input: UpdatePreferencesInput): Promise<void> {
  if (input.theme !== undefined) applyTheme(input.theme);
  if (input.language !== undefined) await setLanguage(input.language);
  try {
    const preferences = await call(routes.me.updatePreferences, { body: input });
    const me = sessionStore.getState().me;
    if (me) sessionStore.getState().setMe({ ...me, preferences });
  } catch {
    // React-এর বাইরে, তাই hook-এর t() না, i18n instance-এর t — বর্তমান ভাষাতেই
    toast(i18n.t('shell.preferenceNotSaved'));
  }
}
