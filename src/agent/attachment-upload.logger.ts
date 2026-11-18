import { HttpException, Logger } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

type UploadStage = 'request' | 'multipart' | 'read_file' | 'session_access' | 'pending_attachments'
  | 'validate_file' | 'parse_pdf' | 'inspect_scanned_pdf' | 'gridfs_upload' | 'save_metadata' | 'complete';
type UploadDetails = { sizeBytes?: number; maxBytes?: number; extension?: string; mime?: string; statusCode?: number };

const logger = new Logger('AgentAttachmentUpload');
const requestLogs = new WeakMap<FastifyRequest, AttachmentUploadLog>();

export class AttachmentUploadLog {
  readonly requestId = randomUUID();
  private readonly startedAt = Date.now();
  private currentStage: UploadStage = 'request';
  private failureLogged = false;
  private readonly hiddenValues: string[] = [];

  constructor() {
    this.write('log', 'upload_received');
  }

  redact(...values: string[]): void {
    this.hiddenValues.push(...values.filter(Boolean));
  }

  stage(stage: UploadStage, details: UploadDetails = {}): void {
    this.currentStage = stage;
    this.write('log', stage === 'complete' ? 'upload_saved' : 'upload_stage', details);
  }

  fail(error: unknown): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    const statusCode = error instanceof HttpException ? error.getStatus() : 500;
    const cause = error instanceof Error ? error.cause : undefined;
    this.write(statusCode >= 500 || cause ? 'error' : 'warn', 'upload_failed', { statusCode }, error);
  }

  cleanupFailed(error: unknown): void {
    this.write('error', 'upload_cleanup_failed', {}, error);
  }

  response(statusCode: number): void {
    this.write(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log', 'upload_response', { statusCode });
  }

  private sanitize(value: string): string {
    let text = value.replace(/(?:full command is|command\s*:|documents?\s*:|extractedText\s*:)[\s\S]*/gi, '[details omitted]')
      .replace(/(?:mongodb(?:\+srv)?|https?):\/\/[^\s"'<>]+/gi, '[connection redacted]')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\b(Basic)\s+[a-z0-9+/=]+/gi, '$1 [redacted]')
      .replace(/(["']?\b(?:password|passwd|secret|token|api[_-]?key|authorization|filename|ownerId|sessionId)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => /password|secret|token|api_?key|mongodb_uri|enc_key/i.test(key) && value && value.length >= 4)
      .map(([, value]) => value!);
    for (const secret of [...this.hiddenValues, ...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[redacted]');
    }
    return text.replaceAll(process.cwd(), '<backend>').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 600);
  }

  private errorDetails(error: unknown, depth = 0): Record<string, unknown> {
    if (!(error instanceof Error)) return { name: 'UnknownError' };
    const coded = error as Error & { code?: unknown; codeName?: unknown };
    return {
      name: this.sanitize(error.name),
      message: this.sanitize(error.message),
      ...(typeof coded.code === 'string' || typeof coded.code === 'number' ? { code: this.sanitize(String(coded.code)) } : {}),
      ...(typeof coded.codeName === 'string' ? { codeName: this.sanitize(coded.codeName) } : {}),
      stack: error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6).map(line => this.sanitize(line.trim())),
      ...(error.cause && depth < 2 ? { cause: this.errorDetails(error.cause, depth + 1) } : {}),
    };
  }

  private write(level: 'log' | 'warn' | 'error', event: string, details: UploadDetails = {}, error?: unknown): void {
    logger[level](JSON.stringify({
      event, requestId: this.requestId, stage: this.currentStage, elapsedMs: Date.now() - this.startedAt,
      ...details, ...(error !== undefined ? { error: this.errorDetails(error) } : {}),
    }));
  }
}

export function attachmentUploadLogFor(request: FastifyRequest): AttachmentUploadLog {
  let log = requestLogs.get(request);
  if (!log) {
    log = new AttachmentUploadLog();
    requestLogs.set(request, log);
  }
  return log;
}

export function registerAttachmentUploadLogging(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const match = /^\/api\/v1\/agent\/sessions\/([^/]+)\/attachments\/?$/.exec((request.raw.url ?? '').split('?')[0]);
    if (!match) return;
    const log = attachmentUploadLogFor(request);
    log.redact(match[1]);
    reply.header('X-Request-Id', log.requestId);
  });
  fastify.addHook('onError', async (request, _reply, error) => {
    requestLogs.get(request)?.fail(error);
  });
  fastify.addHook('onResponse', async (request, reply) => {
    requestLogs.get(request)?.response(reply.statusCode);
  });
}
