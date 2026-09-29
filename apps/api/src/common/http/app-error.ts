import type { ErrorCode } from '@omnivo/contracts';

// যে status গুলো আমরা ইচ্ছা করে পাঠাই — 500 এখানে নেই, সেটা শুধু অপ্রত্যাশিত error থেকে আসে
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export interface AppErrorOptions {
  // অনুবাদের ভেতরে বসানোর মান: "You need the {{permissions}} permission"
  params?: Record<string, string | number>;
  // ফিল্ডের পাথ → code; ক্লায়েন্ট সেই ফিল্ডের নিচে দেখায়
  fieldErrors?: Record<string, ErrorCode[]>;
}

// ব্যবসার নিয়মে ভাঙা যেকোনো অনুরোধ: status + code। detail ইংরেজি, লগ আর API-র বাইরের
// ব্যবহারকারীর জন্য; UI code দেখে নিজের ভাষায় লেখে (ProblemFilter এটাকে RFC 9457-এ বদলায়)
export class AppError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly options: AppErrorOptions;

  constructor(status: ErrorStatus, code: ErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(detail);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.options = options;
  }
}
