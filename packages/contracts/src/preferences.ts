import { z } from 'zod';

import { defineRoute } from './http.js';

// UI-র ভাষা — i18n-এর LANGUAGES এই তালিকা মানতে বাধ্য (i18n.ts-এর satisfies)
export const LANGUAGE_CODES = ['en', 'bn'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

// 'system' = OS-এর prefers-color-scheme মেনে চলা (CLAUDE.md → Color tokens)
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

// ইউজারের নিজের পছন্দ, workspace-এর না — একই মানুষ দুই কোম্পানিতে থাকলেও ভাষা একটাই।
// language null = এখনো বাছেনি; তখন এই ডিভাইসে যা চলছে (লগইন পেজে বাছা ভাষা) সেটাই থাকে
export const preferencesSchema = z.object({
  language: z.enum(LANGUAGE_CODES).nullable(),
  theme: z.enum(THEMES),
});
export type Preferences = z.infer<typeof preferencesSchema>;

// PATCH: যেটা বদলাল শুধু সেটা — ভাষা বদলানো থিমের পুরনো মান ফেরত পাঠিয়ে মুছে দিতে পারে না
export const updatePreferencesInputSchema = z.object({
  language: z.enum(LANGUAGE_CODES).optional(),
  theme: z.enum(THEMES).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesInputSchema>;

export const meRoutes = {
  updatePreferences: defineRoute({
    method: 'PATCH',
    path: '/me/preferences',
    summary: "Save the signed-in user's language and theme, for every device",
    auth: 'bearer',
    status: 200,
    body: updatePreferencesInputSchema,
    response: preferencesSchema,
  }),
};
