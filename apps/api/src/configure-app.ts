import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HttpMethod } from '@omnivo/contracts';

import type { Config } from './config.js';

// চুক্তির প্রতিটা method। @fastify/cors-এর ডিফল্ট শুধু GET, HEAD, POST — ধাপ ৫ পর্যন্ত সব রুট তা-ই
// ছিল, তাই চোখে পড়েনি। ধাপ ৬-এর প্রথম PUT (সেটিংস সেভ) ব্রাউজারের preflight-এ আটকে গিয়েছিল: API-র
// integration টেস্ট আর MSW দুটোই CORS-এর বাইরে দিয়ে যায়, ধরা পড়েছে শুধু আসল ব্রাউজারে।
// satisfies: চুক্তিতে নেই এমন method লিখলে compile error
const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] satisfies (
  HttpMethod | 'HEAD'
)[];

// প্রতিটা request-এর আলাদা id (UUID) — error response-এর requestId আর লগের লাইন এটা দিয়েই মেলে।
// Fastify-র ডিফল্ট "req-1, req-2" প্রতিটা process-এ আবার ১ থেকে শুরু হয়, একাধিক pod-এ মেলে না।
// ক্লায়েন্টের পাঠানো x-request-id নেওয়া হয় না (Fastify 5-এর ডিফল্ট) — বাইরের মান বিশ্বাস করা হয় না
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ genReqId: () => randomUUID() });
}

// main.ts আর integration test দুজনেই এটা ডাকে — টেস্টে ঠিক production-এর setup চলে
export async function configureApp(app: NestFastifyApplication, config: Config): Promise<void> {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: config.appOrigin,
    methods: CORS_METHODS,
    // cross-origin fetch-এ cookie পাঠাতে/নিতে দুই দিকেই credentials লাগে
    credentials: true,
    // CORS-এ ব্রাউজার JS শুধু গোনা কয়েকটা header দেখে; এটা না দিলে app requestId পড়তে পারত না
    exposedHeaders: ['x-request-id'],
  });
  // সফল হোক বা ব্যর্থ, প্রতিটা response-এ id — সাপোর্টে "কোন request?" প্রশ্নের উত্তর
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header('x-request-id', request.id);
      done();
    });
}
