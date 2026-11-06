import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

// Load the repo-root .env before any module reads process.env.
for (const p of [resolve(process.cwd(), '../.env'), resolve(process.cwd(), '.env')]) if (existsSync(p)) loadEnv({ path: p });

async function bootstrap() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  // Proxies in front of the API (1 = Caddy on a server; 3 = Vercel → ngrok → local gateway).
  // Needed so rate limits and the audit log see each person's real IP, not the proxy's.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.enableCors({ origin: (process.env.WEB_ORIGIN || 'http://localhost:5173').split(','), credentials: false });
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Prisim CRM API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  const port = Number(process.env.PORT || 4000);
  await app.listen(port);
  Logger.log(`API ready on http://localhost:${port}/api/v1  (docs: /api/docs)`, 'Bootstrap');
}
bootstrap();
