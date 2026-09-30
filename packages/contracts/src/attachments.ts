import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// ফাইল কী কাজে লাগবে — প্রতিটার নিজের আকার আর ধরনের সীমা। নতুন কাজ (ইনভয়েস PDF, খরচের রসিদ)
// = এখানে এক লাইন
export const ATTACHMENT_PURPOSES = ['company_logo'] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

interface AttachmentRule {
  maxBytes: number;
  contentTypes: readonly string[];
}

// SVG নেই ইচ্ছা করে: SVG-র ভেতরে <script> থাকতে পারে। ছবির ঠিকানা সরাসরি খুললে সেই script চলত
export const ATTACHMENT_RULES = {
  company_logo: {
    maxBytes: 2 * 1024 * 1024,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  },
} satisfies Record<AttachmentPurpose, AttachmentRule>;

// ফাইল পাঠানোর আগে শুধু তার বর্ণনা — ফাইল নিজে API-তে আসে না, সরাসরি storage-এ যায়।
// ব্রাউজারও আগে থেকে একই schema দিয়ে যাচাই করে: ৩০ MB-র ছবি বাছলে আপলোড শুরুর আগেই error
export const createUploadInputSchema = z
  .object({
    purpose: z.enum(ATTACHMENT_PURPOSES),
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().max(100),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((input, ctx) => {
    const rule: AttachmentRule = ATTACHMENT_RULES[input.purpose];
    if (!rule.contentTypes.includes(input.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: errorCode('file_type_not_allowed'),
      });
    }
    if (input.sizeBytes > rule.maxBytes) {
      ctx.addIssue({ code: 'custom', path: ['sizeBytes'], message: errorCode('file_too_large') });
    }
  });
export type CreateUploadInput = z.infer<typeof createUploadInputSchema>;

export const attachmentSchema = z.object({
  id: z.uuid(),
  purpose: z.enum(ATTACHMENT_PURPOSES),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  // pending = ঠিকানা দেওয়া হয়েছে, ফাইল এখনো যাচাই হয়নি; ready = storage-এ আছে, আকার-ধরন মিলেছে
  status: z.enum(['pending', 'ready']),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadTicketSchema = z.object({
  attachment: attachmentSchema,
  // ব্রাউজার ঠিক এই method, ঠিকানা আর header দিয়ে ফাইল পাঠাবে — header না মিললে storage সই
  // মানবে না (Content-Type সইয়ের অংশ)
  upload: z.object({
    method: z.literal('PUT'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  }),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const signedUrlSchema = z.object({ url: z.url(), expiresAt: z.iso.datetime() });

const attachmentParamsSchema = z.object({ id: z.uuid() });

export const attachmentRoutes = {
  createUpload: defineRoute({
    method: 'POST',
    path: '/attachments',
    summary: 'Describe a file and get a short-lived URL to upload it to storage',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 201,
    body: createUploadInputSchema,
    response: uploadTicketSchema,
  }),
  complete: defineRoute({
    method: 'POST',
    path: '/attachments/:id/complete',
    summary: 'Confirm the upload; the server checks the stored file matches',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: attachmentParamsSchema,
    response: attachmentSchema,
  }),
  download: defineRoute({
    method: 'GET',
    path: '/attachments/:id/download',
    summary: 'A short-lived URL to read the file',
    auth: 'bearer',
    status: 200,
    params: attachmentParamsSchema,
    response: signedUrlSchema,
  }),
};
