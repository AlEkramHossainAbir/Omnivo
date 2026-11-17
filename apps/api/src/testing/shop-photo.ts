import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type StorefrontUpload,
  storefrontUploadSchema,
  storefrontUploadTicketSchema,
} from '@omnivo/contracts';
import sharp from 'sharp';
import { expect } from 'vitest';

import { eventually } from './app.js';
import { bearer, type SignedIn } from './http.js';

// Step 26g: a shop photo the way the editor sends one. The tests that use these need the storage
// (startStorage) for the upload and a worker for the image job.

// A plain JPEG of this size, in the shop's teal. orientation: the EXIF "turn me" note a phone
// writes (6 = turn a quarter to the right), so a test can see the job turn the photo upright
export function jpegOf(width: number, height: number, orientation?: number): Promise<Buffer> {
  const picture = sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 88, b: 89 } },
  }).jpeg();
  return (orientation === undefined ? picture : picture.withMetadata({ orientation })).toBuffer();
}

// The three steps of an upload: describe the file, PUT it to the presigned address, confirm it.
// The answer is the photo's id; the job then runs on its own
export async function sendPhoto(
  app: NestFastifyApplication,
  who: SignedIn,
  bytes: Buffer,
  contentType = 'image/jpeg',
): Promise<string> {
  const headers = bearer(who.accessToken);
  const start = await app.inject({
    method: 'POST',
    url: '/storefront/images',
    headers,
    payload: { fileName: 'photo.jpg', contentType, sizeBytes: bytes.length },
  });
  expect(start.statusCode, start.body).toBe(201);
  const ticket = storefrontUploadTicketSchema.parse(start.json());
  // fetch, not inject: the address is the storage's, not the API's. Uint8Array: what fetch's body
  // type takes (a Buffer is one, but the DOM types do not say so)
  const put = await fetch(ticket.upload.url, {
    method: 'PUT',
    headers: ticket.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  const done = await app.inject({
    method: 'POST',
    url: `/storefront/images/${ticket.image.id}/complete`,
    headers,
  });
  expect(done.statusCode, done.body).toBe(200);
  return ticket.image.id;
}

// The photo once the job is done with it: ready or failed. A photo still processing after the
// time is a failure of the test, with the last state in the message
export function photoSettled(
  app: NestFastifyApplication,
  who: SignedIn,
  id: string,
): Promise<StorefrontUpload> {
  return eventually(async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/storefront/images/${id}`,
      headers: bearer(who.accessToken),
    });
    const upload = storefrontUploadSchema.parse(res.json());
    if (upload.status !== 'ready' && upload.status !== 'failed') {
      throw new Error(`Photo ${id} is still ${upload.status}`);
    }
    return upload;
  }, 20_000);
}

// A photo a listing may save: sent, made, ready
export async function readyPhoto(app: NestFastifyApplication, who: SignedIn): Promise<string> {
  const id = await sendPhoto(app, who, await jpegOf(800, 800));
  expect((await photoSettled(app, who, id)).status).toBe('ready');
  return id;
}
