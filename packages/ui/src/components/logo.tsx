// দুটো সরানো বর্গ — ভরাট আর ফাঁকা, খাতার ডেবিট/ক্রেডিট কলাম (CLAUDE.md → Logo)
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">
      <span aria-hidden="true" className="relative size-[26px] shrink-0">
        <span className="absolute top-0 left-0 size-4 rounded-[5px] bg-brand" />
        <span className="absolute right-0 bottom-0 size-4 rounded-[5px] border-2 border-brand bg-surface" />
      </span>
      Omnivo
    </span>
  );
}
