import { lazy, Suspense, useEffect } from 'react';
// Types only: erased from the build, so this line fetches nothing
import type * as Sonner from 'sonner';

// Step 17a: sonner is a chunk of its own, fetched right after the first render instead of being
// part of the first load. A toast always follows something the person did, so the first paint
// never needs it, and it was about 9 KB gz of the 200 KB first-load budget. One loader, so the
// toaster and toast() share a single fetch.
let sonner: Promise<typeof Sonner> | null = null;
const loadSonner = () => (sonner ??= import('sonner'));

// Resolves once sonner's toaster is on the page. A toast sent before that (a save that answered
// in the first second) waits for it instead of being lost: sonner only shows toasts sent after
// its toaster subscribed.
let markReady: () => void = () => undefined;
const ready = new Promise<void>((resolve) => {
  markReady = resolve;
});

// CLAUDE.md → Toast: ink পটভূমি, bg লেখা, ১০px কোণ, shadow-lg, নিচে মাঝখানে, ~৩ সেকেন্ড।
// unstyled: sonner-এর নিজের রং/কোণ বাদ, শুধু আমাদের token — dark mode-এ ink নিজেই উল্টে যায়
const LoadedToaster = lazy(async () => {
  const { Toaster: SonnerToaster } = await loadSonner();
  function Loaded() {
    // Effects run child first: sonner's toaster has subscribed by the time this one runs
    useEffect(() => {
      markReady();
    }, []);
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
  return { default: Loaded };
});

export function Toaster() {
  // Nothing to show while the chunk arrives: no toast has been sent yet
  return (
    <Suspense fallback={null}>
      <LoadedToaster />
    </Suspense>
  );
}

// sonner-এর পুরো API বাইরে না দিয়ে একটাই ফাংশন: পরে লাইব্রেরি বদলালে শুধু এই ফাইল বদলাবে।
// লেখা হবে কী ঘটল তা ("Workspace created") — CLAUDE.md
export function toast(message: string): void {
  void ready.then(async () => {
    (await loadSonner()).toast(message);
  });
}
