import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { setupApp } from './app.setup';

// Load the repo-root .env before any module reads process.env.
for (const p of [resolve(process.cwd(), '../.env'), resolve(process.cwd(), '.env')]) if (existsSync(p)) loadEnv({ path: p });

async function bootstrap() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  setupApp(app);

  const port = Number(process.env.PORT || 4000);
  await app.listen(port);
  Logger.log(`API ready on http://localhost:${port}/api/v1  (docs: /api/docs)`, 'Bootstrap');
}
bootstrap();
