import { z } from 'zod';

// API যত রকম error পাঠায় (আর ক্লায়েন্ট নিজে যত বানায়) তার পুরো তালিকা। UI-র লেখা থাকে
// i18n-এর errors.*-এ — এখানে নতুন code যোগ করে en.ts-এ অনুবাদ না লিখলে typecheck fail করে
export const ERROR_CODES = [
  // সাধারণ যাচাই: schema নিজে code না দিলে Zod-এর issue থেকে আসে (contractErrorMap)
  'invalid_input',
  'required',
  'too_short',
  'too_long',
  'too_small',
  'too_large',
  'invalid_format',
  'invalid_value',
  // নির্দিষ্ট ফিল্ডের যাচাই
  'company_name_required',
  'full_name_required',
  'email_invalid',
  'email_taken',
  'password_required',
  'password_too_short',
  'password_too_long',
  'slug_too_short',
  'slug_too_long',
  'slug_format',
  'slug_reserved',
  'slug_taken',
  // auth ও অনুমতি
  'workspace_not_found',
  'invalid_credentials',
  'not_a_member',
  'sign_in_required',
  'session_ended',
  'access_revoked',
  'switch_denied',
  'permission_missing',
  // HTTP ও সার্ভার
  'invalid_cursor',
  'malformed_request',
  'not_found',
  'request_failed',
  'internal_error',
  // শুধু ক্লায়েন্ট বানায়, সার্ভার কখনো পাঠায় না
  'network_error',
  'unexpected_response',
  'unknown_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

// schema-র ভেতরে মেসেজের জায়গায় code: .min(3, errorCode('slug_too_short'))।
// সাধারণ string লিখলে বানান ভুল ধরা পড়ত না — এই ফাংশন শুধু ErrorCode নেয়
export function errorCode(code: ErrorCode): ErrorCode {
  return code;
}

// schema যেখানে নিজে code দেয়নি (যেমন .max(120)), সেখানে Zod-এর issue দেখে সাধারণ code।
// Zod-এর ক্রম: schema-র নিজের মেসেজ > parse-এর সময় দেওয়া এই map > Zod-এর ইংরেজি মেসেজ
export const contractErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'required' : 'invalid_value';
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_short' : 'too_small';
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_long' : 'too_large';
    case 'invalid_format':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
};

// RFC 9457 "Problem Details" — HTTP API-র error-এর প্রচলিত আকার (Content-Type:
// application/problem+json)। title/status/detail RFC-র নিজের ফিল্ড; code, params, fieldErrors,
// requestId আমাদের extension। type নেই = RFC অনুযায়ী "about:blank" (title = HTTP status-এর নাম)
export const problemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  // ইংরেজি, ডেভেলপার আর লগের জন্য — UI এটা দেখায় না, code অনুবাদ করে দেখায়
  detail: z.string(),
  // z.string(), enum না: নতুন সার্ভার নতুন code পাঠালে পুরনো ক্লায়েন্ট (অফলাইন PWA-র ক্যাশ)
  // parse-এ ভেঙে পড়বে না; isErrorCode() দিয়ে চেনা code-এ নামানো হয়
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  // ফিল্ডের পাথ (react-hook-form-এর মতো: "items.0.qty") → সেই ফিল্ডের error code
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  requestId: z.string().optional(),
});

export type Problem = z.infer<typeof problemSchema>;
