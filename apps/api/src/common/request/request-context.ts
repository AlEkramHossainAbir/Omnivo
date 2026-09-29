import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';

// একটা HTTP request-এর পরিচয় — audit log আর error লগ এটা দিয়ে একে অন্যের সাথে মেলে।
// tenant-এর ALS থেকে আলাদা: লগইন (public রুট) টেন্যান্ট জানার আগেই চলে, কিন্তু তার audit-এও
// IP আর request id লাগে
export interface RequestMeta {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
}

const requestStorage = new AsyncLocalStorage<RequestMeta>();

// background job-এ (ধাপ ৮) request নেই — তখন undefined, audit-এ এই কলামগুলো NULL
export function currentRequest(): RequestMeta | undefined {
  return requestStorage.getStore();
}

// Nest-এর Fastify adapter middleware-কে Node-এর কাঁচা request দেয়; @fastify/middie তাতে Fastify-র
// id (genReqId, configure-app.ts) আর ip বসিয়ে দেয়। Node-এর টাইপে এরা নেই — তাই `in` দিয়ে narrow,
// cast না। middie ছাড়া চললেও (ভবিষ্যতে অন্য adapter) request ভাঙবে না, নিজের id বানাবে
function metaOf(req: IncomingMessage): RequestMeta {
  const id = 'id' in req && typeof req.id === 'string' ? req.id : randomUUID();
  const ip = 'ip' in req && typeof req.ip === 'string' ? req.ip : req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  return {
    id,
    ipAddress: ip ?? null,
    // header ক্লায়েন্টের হাতে — অসীম লম্বা string DB-তে না
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 512),
  };
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    requestStorage.run(metaOf(req), next);
  }
}
