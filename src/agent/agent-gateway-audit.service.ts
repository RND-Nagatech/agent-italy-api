import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import type { UserDocument } from '../users/user.types';

const AUDIT_EMAIL = 'rnd@nagatech.id';
const MAX_AUDIT_PAYLOAD_BYTES = 15 * 1024 * 1024;

export type AgentGatewayAuditKind = 'chat' | 'room-summary' | 'memory-learning' | 'bank-extraction' | 'price-extraction';
export type AgentGatewayAuditOutcome = 'pending' | 'succeeded' | 'http-error' | 'network-error' | 'response-error';

export type AgentGatewayAuditContext = {
  exchangeRequestId: string;
  sessionId: string | null;
  actorId: string;
  actorEmail: string;
};

type AgentGatewayAuditDocument = {
  _id: ObjectId;
  exchangeRequestId: string;
  sessionId: string | null;
  actorId: string;
  actorEmail: string;
  questionPreview: string | null;
  kind: AgentGatewayAuditKind;
  round: number;
  model: string;
  method: 'POST';
  path: string;
  payloadJson: string;
  payloadBytes: number;
  outcome: AgentGatewayAuditOutcome;
  statusCode: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  createdAt: Date;
  finishedAt?: Date;
  expiresAt: Date;
};

@Injectable()
export class AgentGatewayAuditService {
  private readonly logger = new Logger(AgentGatewayAuditService.name);

  constructor(private readonly mongo: MongoService) {}

  private get audits() {
    return this.mongo.db.collection<AgentGatewayAuditDocument>('agent_gateway_request_audits');
  }

  private async getActor(actorId: string): Promise<{ email: string; active: boolean }> {
    if (!ObjectId.isValid(actorId)) throw new ForbiddenException('Akun tidak valid untuk audit Agent.');
    const user = await this.mongo.db.collection<UserDocument>('users').findOne(
      { _id: new ObjectId(actorId) },
      { projection: { email: 1, active: 1 } },
    );
    if (!user?.email) throw new ForbiddenException('Akun tidak ditemukan.');
    return { email: user.email.trim().toLowerCase(), active: user.active };
  }

  async resolveActorEmail(actorId: string): Promise<string> {
    return (await this.getActor(actorId)).email;
  }

  private async assertAuditAccess(actorId: string): Promise<void> {
    const actor = await this.getActor(actorId);
    if (!actor.active || actor.email !== AUDIT_EMAIL) throw new ForbiddenException('Audit payload Agent hanya tersedia untuk akun yang ditunjuk.');
  }

  async begin(input: {
    context: AgentGatewayAuditContext;
    kind: AgentGatewayAuditKind;
    round: number;
    model: string;
    path: string;
    payloadJson: string;
  }): Promise<string> {
    const payloadBytes = Buffer.byteLength(input.payloadJson, 'utf8');
    if (payloadBytes > MAX_AUDIT_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException('Payload Agent terlalu besar untuk dicatat secara utuh; request tidak dikirim ke gateway.');
    }
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + env.agentGatewayAuditRetentionDays * 24 * 60 * 60 * 1000);
    let questionPreview: string | null = null;
    if (input.kind !== 'room-summary') {
      try {
        const payload = JSON.parse(input.payloadJson) as { messages?: Array<{ role?: string; content?: unknown }> };
        const lastUserMessage = [...(payload.messages ?? [])].reverse().find(message => message.role === 'user');
        const content = typeof lastUserMessage?.content === 'string'
          ? lastUserMessage.content
          : Array.isArray(lastUserMessage?.content)
            ? lastUserMessage.content.flatMap(part => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join(' ')
            : '';
        let preview = content;
        if (input.kind === 'memory-learning') {
          try {
            const parsed = JSON.parse(content) as { latestUserMessage?: unknown };
            if (typeof parsed.latestUserMessage === 'string') preview = parsed.latestUserMessage;
          } catch { /* Keep the submitted user content when it is not JSON. */ }
        }
        questionPreview = preview.replace(/\s+/g, ' ').trim().slice(0, 280) || null;
      } catch {
        questionPreview = null;
      }
    }
    const result = await this.audits.insertOne({
      _id: new ObjectId(),
      exchangeRequestId: input.context.exchangeRequestId,
      sessionId: input.context.sessionId,
      actorId: input.context.actorId,
      actorEmail: input.context.actorEmail,
      questionPreview,
      kind: input.kind,
      round: input.round,
      model: input.model,
      method: 'POST',
      path: input.path,
      payloadJson: input.payloadJson,
      payloadBytes,
      outcome: 'pending',
      statusCode: null,
      latencyMs: null,
      finishReason: null,
      createdAt,
      expiresAt,
    });
    return result.insertedId.toHexString();
  }

  async finish(id: string, result: {
    outcome: Exclude<AgentGatewayAuditOutcome, 'pending'>;
    statusCode: number | null;
    latencyMs: number;
    finishReason?: string | null;
  }): Promise<void> {
    try {
      if (!ObjectId.isValid(id)) return;
      await this.audits.updateOne(
        { _id: new ObjectId(id) },
        { $set: { ...result, finishedAt: new Date() } },
      );
    } catch (error) {
      this.logger.warn(`Status audit gateway tidak terbarui: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async list(actorId: string, query: { limit: number; cursor?: string; requestId?: string; sessionId?: string }) {
    await this.assertAuditAccess(actorId);
    const filter: Record<string, unknown> = {};
    if (query.requestId) filter.exchangeRequestId = query.requestId;
    if (query.sessionId) filter.sessionId = query.sessionId;
    if (query.cursor) {
      if (!ObjectId.isValid(query.cursor)) throw new BadRequestException('Cursor audit tidak valid.');
      filter._id = { $lt: new ObjectId(query.cursor) };
    }
    const rows = await this.audits.find(filter, { projection: { payloadJson: 0 } })
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(({ _id, createdAt, expiresAt, ...row }) => ({
        ...row,
        id: _id.toHexString(),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })),
      pagination: { limit: query.limit, nextCursor: hasMore ? page.at(-1)?._id.toHexString() ?? null : null },
      retentionDays: env.agentGatewayAuditRetentionDays,
    };
  }

  async get(actorId: string, id: string) {
    await this.assertAuditAccess(actorId);
    if (!ObjectId.isValid(id)) throw new NotFoundException('Request audit tidak ditemukan.');
    const row = await this.audits.findOne({ _id: new ObjectId(id) });
    if (!row) throw new NotFoundException('Request audit tidak ditemukan.');
    const { _id, createdAt, expiresAt, ...rest } = row;
    return { ...rest, id: _id.toHexString(), createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }
}
