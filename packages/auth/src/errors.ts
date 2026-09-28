// facade-এর বাইরে Better Auth-এর নিজস্ব error কোড যায় না — API শুধু এই কয়টা কোড চেনে
export type AuthErrorCode =
  'INVALID_CREDENTIALS' | 'EMAIL_TAKEN' | 'INVALID_REFRESH_TOKEN' | 'REFRESH_TOKEN_REUSED';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}
