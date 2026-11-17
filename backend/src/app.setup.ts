import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

export function stripVercelPathQuery(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return requestUrl;
  const queryIndex = requestUrl.indexOf('?');
  if (queryIndex < 0) return requestUrl;

  const path = requestUrl.slice(0, queryIndex);
  const params = new URLSearchParams(requestUrl.slice(queryIndex + 1));
  if (!params.has('path')) return requestUrl;
  params.delete('path');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function stripVercelPathProperty<T extends Record<string, unknown>>(query: T): Omit<T, 'path'> {
  const { path: _path, ...remaining } = query;
  return remaining;
}

export function setupApp(app: NestExpressApplication) {
  // Proxies in front of the API (1 = Vercel, or Caddy on a server).
  // Needed so rate limits and the audit log see each person's real IP, not the proxy's.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.url = stripVercelPathQuery(req.url) ?? req.url;
    if ('path' in req.query) {
      Object.defineProperty(req, 'query', { configurable: true, value: stripVercelPathProperty(req.query) });
    }
    next();
  });
  app.enableCors({ origin: (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map((o) => o.trim().replace(/\/$/, '')), credentials: false, exposedHeaders: ['X-File-Location', 'X-File-Type', 'X-File-Encoding', 'Content-Disposition'] });
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
}
