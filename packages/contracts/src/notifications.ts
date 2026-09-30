import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// Every kind of in-app notification. The server stores the type and a few values (params), never a
// sentence: the app turns them into text in the reader's language (notifications.types.* in en.ts).
export const NOTIFICATION_TYPES = [
  'workspace.ready',
  'member.joined',
  'invitation.failed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return NOTIFICATION_TYPES.some((type) => type === value);
}

// Values placed into the text, like {{name}}. Plain values only, the same rule as audit changes.
export const notificationParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type NotificationParams = z.infer<typeof notificationParamsSchema>;

export const notificationSchema = z.object({
  id: z.uuid(),
  // z.string(), not an enum: a new type from a newer server must not break the parse in an older
  // offline client (the same rule as error codes and audit actions). The app narrows it with
  // isNotificationType() and skips types it does not know.
  type: z.string(),
  params: notificationParamsSchema,
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = pageOf(notificationSchema);
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ count: z.number().int().min(0) });

const notificationParamsPathSchema = z.object({ id: z.uuid() });

// No permission on any of these: everyone may read and clear their own notifications, and the
// server only ever touches rows of the signed-in user.
export const notificationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/notifications',
    summary: "The signed-in user's notifications in this workspace, newest first",
    auth: 'bearer',
    status: 200,
    query: pageQuerySchema,
    response: notificationPageSchema,
  }),
  // The bell polls this every 30 seconds, so it is a tiny, separate call
  unreadCount: defineRoute({
    method: 'GET',
    path: '/notifications/unread-count',
    summary: 'How many notifications are unread',
    auth: 'bearer',
    status: 200,
    response: unreadCountSchema,
  }),
  markRead: defineRoute({
    method: 'POST',
    path: '/notifications/:id/read',
    summary: 'Mark one notification as read',
    auth: 'bearer',
    status: 204,
    params: notificationParamsPathSchema,
    response: z.void(),
  }),
  markAllRead: defineRoute({
    method: 'POST',
    path: '/notifications/read-all',
    summary: 'Mark every notification as read',
    auth: 'bearer',
    status: 204,
    response: z.void(),
  }),
};
