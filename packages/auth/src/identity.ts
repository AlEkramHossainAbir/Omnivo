import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { accounts, sessions, users, verifications, type Db } from '@omnivo/db';
import { uuidv7 } from 'uuidv7';

export interface IdentityOptions {
  db: Db;
  secret: string;
  baseURL: string;
  sessionTtlSeconds: number;
}

// Better Auth শুধু এই ফাইলে — packages/auth-এর বাইরে কেউ একে সরাসরি দেখে না (ADR 0002)
export function createIdentityProvider(options: IdentityOptions) {
  return betterAuth({
    appName: 'Omnivo',
    baseURL: options.baseURL,
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      // Better Auth-এর model নাম (key) → আমাদের Drizzle টেবিল (value)
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
      // user + credential account একসাথে তৈরি হবে, নাহলে পাসওয়ার্ড ছাড়া ইউজার থেকে যেতে পারত
      transaction: true,
    }),
    user: {
      // Better Auth-এর `name` ফিল্ড → আমাদের Drizzle key `fullName` (কলাম full_name)
      fields: { name: 'fullName' },
    },
    session: {
      expiresIn: options.sessionTtlSeconds,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    advanced: {
      // ডিফল্ট random string id আমাদের uuid কলামে ঢুকবে না; বাকি টেবিলের মতো UUIDv7
      database: { generateId: () => uuidv7() },
    },
    telemetry: { enabled: false },
  });
}

export type IdentityProvider = ReturnType<typeof createIdentityProvider>;
