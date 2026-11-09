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

/**
 * A rewrite with a named parameter adds it to the query, which the API's strict validation
 * refuses. vercel.json avoids that; this keeps a future rewrite from taking down every list.
 */
function dropRewriteParam(req: IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.searchParams.has('path')) return;
  url.searchParams.delete('path');
  req.url = url.pathname + url.search;
  delete (req as IncomingMessage & { query?: unknown }).query; // Vercel's copy, parsed from the old URL.
}

/** Vercel entry point (see /api/index.js). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  dropRewriteParam(req);
  ready ??= boot().catch((e) => { ready = undefined; throw e; });
  (await ready)(req, res);
}
