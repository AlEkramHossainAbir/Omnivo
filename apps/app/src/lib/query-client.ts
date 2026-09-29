import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from './api';

// 4xx আবার চেষ্টা করলেও একই উত্তর (অনুমতি নেই, ভুল cursor) — শুধু নেটওয়ার্ক আর 5xx-এ আবার
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

// একটাই client, module-level: React-এর বাইরে (session.ts) থেকেও ক্যাশ মোছা যায়
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // ৩০ সেকেন্ড "টাটকা": পেজ বদলে ফিরে এলে সাথে সাথে ক্যাশ থেকে, পেছনে আবার আনে না
      staleTime: 30_000,
      retry: shouldRetry,
    },
  },
});
