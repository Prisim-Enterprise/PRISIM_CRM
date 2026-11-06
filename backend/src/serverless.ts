import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function boot(): Promise<Handler> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  setupApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance();
}

// Kept between requests while the function stays warm.
let ready: Promise<Handler> | undefined;

/** Vercel entry point (see /api/index.js). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= boot().catch((e) => { ready = undefined; throw e; });
  (await ready)(req, res);
}
