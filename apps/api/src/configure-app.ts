import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { Config } from './config.js';

// main.ts আর integration test দুজনেই এটা ডাকে — টেস্টে ঠিক production-এর setup চলে
export async function configureApp(app: NestFastifyApplication, config: Config): Promise<void> {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: config.appOrigin,
    // cross-origin fetch-এ cookie পাঠাতে/নিতে দুই দিকেই credentials লাগে
    credentials: true,
  });
}