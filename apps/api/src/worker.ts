import './env.js';
import { NestFactory } from '@nestjs/core';

import { loadWorkerConfig } from './config.js';
import { WorkerModule } from './worker/worker.module.js';

// The second entry point of the same code base: `node dist/worker.js`. Same build and Docker
// image as the API, a different process — it can be restarted, scaled or stopped on its own.
async function bootstrap(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  // An application context, not an app: Nest's DI and lifecycle hooks, but no HTTP server
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config));
  // SIGTERM (a deploy) → finish the running jobs, stop the relay, close the pools
  app.enableShutdownHooks();
}

void bootstrap();
