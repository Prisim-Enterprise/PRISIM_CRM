import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

export function setupApp(app: NestExpressApplication) {
  // Proxies in front of the API (1 = Vercel, or Caddy on a server).
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
}
