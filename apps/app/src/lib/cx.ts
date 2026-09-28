// শর্তসাপেক্ষ class জোড়া লাগানো — এর জন্য আলাদা dependency (clsx) লাগে না
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
