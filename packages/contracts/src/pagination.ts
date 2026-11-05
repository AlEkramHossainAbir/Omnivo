import { z } from 'zod';

// keyset pagination-এর query: কয়টা, আর কোথা থেকে। OFFSET নেই — বড় টেবিলে OFFSET ১০,০০০ মানে
// Postgres ১০,০০০ রো পড়ে ফেলে দেয়; cursor দিলে index থেকে সোজা সেই জায়গায় যায় (system-design §৫.৬)
export const pageQuerySchema = z.object({
  // <number>: input টাইপ unknown-এর বদলে number — ক্লায়েন্ট { limit: 50 } লেখে, আর
  // querystring-এর "50" সার্ভারে coerce হয়ে 50
  limit: z.coerce.number<number>().int().min(1).max(100).default(50),
  // ক্লায়েন্টের কাছে অস্বচ্ছ string — ভেতরে কী আছে সেটা শুধু সার্ভার জানে
  cursor: z.string().min(1).max(512).optional(),
});

// প্রতিটা তালিকার উত্তর একই আকারে: items + পরের পাতার cursor (শেষ পাতায় null)।
// মোট সংখ্যা (total) নেই ইচ্ছা করে — COUNT(*) বড় টেবিলে পুরো টেবিল পড়ে
export function pageOf<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
