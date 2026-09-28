import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

// CLAUDE.md → Toast: ink পটভূমি, bg লেখা, ১০px কোণ, shadow-lg, নিচে মাঝখানে, ~৩ সেকেন্ড।
// unstyled: sonner-এর নিজের রং/কোণ বাদ, শুধু আমাদের token — dark mode-এ ink নিজেই উল্টে যায়
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      duration={3000}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-2.5 rounded-control bg-ink px-4 py-3 text-body-sm font-medium text-bg shadow-lg',
        },
      }}
    />
  );
}

// sonner-এর পুরো API বাইরে না দিয়ে একটাই ফাংশন: পরে লাইব্রেরি বদলালে শুধু এই ফাইল বদলাবে।
// লেখা হবে কী ঘটল তা ("Workspace created") — CLAUDE.md
export function toast(message: string): void {
  sonnerToast(message);
}
