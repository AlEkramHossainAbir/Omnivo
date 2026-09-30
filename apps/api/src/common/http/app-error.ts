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

// id দিয়ে খোঁজা রো নেই — অথবা অন্য টেন্যান্টের (RLS সেটা লুকায়)। দুটোই একই 404: "অন্য কোম্পানির এই id
// আছে" সেটুকুও বাইরে জানানো হয় না
export function notFound(what: string): AppError {
  return new AppError(404, 'not_found', `${what} not found.`);
}

// optimistic locking: ফর্ম খোলার পরে কেউ রো-টা বদলেছে
export function versionConflict(): AppError {
  return new AppError(
    409,
    'version_conflict',
    'The record changed after it was loaded. Reload it and try again.',
  );
}

// টোকেন বৈধ, কিন্তু মানুষটা আর এই workspace-এ নেই (বাদ দেওয়া হয়েছে)
export function accessRevoked(): AppError {
  return new AppError(401, 'access_revoked', 'The user is no longer a member of this workspace.');
}
