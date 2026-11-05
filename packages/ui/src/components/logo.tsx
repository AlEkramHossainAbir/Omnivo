// দুটো সরানো বর্গ — ভরাট আর ফাঁকা, খাতার ডেবিট/ক্রেডিট কলাম (CLAUDE.md → Logo)
// markOnPhone: the mark alone below sm (the word stays for screen readers), for a bar that has
// no room for it on a 390px phone (the POS screen, step 20c.7)
export function Logo({ markOnPhone = false }: { markOnPhone?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">
      <span aria-hidden="true" className="relative size-[26px] shrink-0">
        <span className="absolute top-0 left-0 size-4 rounded-[5px] bg-brand" />
        <span className="absolute right-0 bottom-0 size-4 rounded-[5px] border-2 border-brand bg-surface" />
      </span>
      <span className={markOnPhone ? 'max-sm:sr-only' : undefined}>Omnivo</span>
    </span>
  );
}
