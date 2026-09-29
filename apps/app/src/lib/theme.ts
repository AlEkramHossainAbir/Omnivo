import { THEMES, type Theme } from '@omnivo/contracts';

// index.html-এর inline script-ও এই key পড়ে — প্রথম রং আঁকার আগে, React লোড হওয়ারও আগে
const STORAGE_KEY = 'omnivo.theme';

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

// CLAUDE.md: data-theme OS-এর পছন্দকে দুই দিকেই হারায়; 'system' হলে attribute নেই, তখন
// prefers-color-scheme। localStorage-এ রাখা শুধু পরের বার প্রথম ঝলকের জন্য — আসল উৎস সার্ভার
export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // প্রাইভেট মোড: পরের বার প্রথম ঝলকে OS-এর থিম, তারপর সার্ভারেরটা — ক্ষতি নেই
  }
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : 'system';
}
