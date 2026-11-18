import multipart from '@fastify/multipart';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { env } from './config/env';
import { AppModule } from './app.module';
import { registerAttachmentUploadLogging } from './agent/attachment-upload.logger';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    trustProxy: env.trustProxy.length ? env.trustProxy : false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const fastify = app.getHttpAdapter().getInstance();
  registerAttachmentUploadLogging(fastify);

  await fastify.register(cookie);
  await fastify.register(multipart, { limits: { fileSize: env.knowledgeMaxFileMb * 1024 * 1024, files: 1, fields: 1, parts: 2 } });
  await fastify.register(helmet);

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: env.corsOrigins.length ? env.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token'],
    exposedHeaders: ['x-request-id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();
  await app.listen(env.port, '0.0.0.0');
}

void bootstrap();
