import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { AuthPrincipal } from '../users/user.types';
import { AgentFeedbackDto } from './dto/agent-feedback.dto';

type ToolRunEvent = { name: string; durationMs: number; outcome: 'success' | 'error' };
type ToolPlanEvent = { round: number; status: 'approved' | 'rejected'; toolNames: string[]; reason?: string; createdAt: Date };
type AgentRunTrace = {
  _id: ObjectId;
  requestId: string;
  sessionId?: string;
  ownerId: string;
  userRole: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  toolCalls: ToolRunEvent[];
  executionPlans?: ToolPlanEvent[];
  appliedSkills: Array<{ name: string; version: number }>;
  usedSources: Array<{ alias: string; branchId: string }>;
  errorStatus?: number;
  feedback?: { rating: 'helpful' | 'needs-improvement'; category?: string; updatedAt: Date };
  attempts: number;
};

@Injectable()
export class AgentRunTracesService {
  private readonly logger = new Logger(AgentRunTracesService.name);

  constructor(private readonly mongo: MongoService) {}

  async start(requestId: string, sessionId: string | undefined, principal: AuthPrincipal): Promise<void> {
    try {
      const now = new Date();
      await this.collection().updateOne(
        { ownerId: principal.sub, requestId },
        {
          $set: { sessionId, userRole: principal.role, status: 'running', startedAt: now, toolCalls: [], executionPlans: [], appliedSkills: [], usedSources: [] },
          $setOnInsert: { ownerId: principal.sub, requestId },
          $inc: { attempts: 1 },
          $unset: { completedAt: '', durationMs: '', errorStatus: '', feedback: '' },
        },
        { upsert: true },
      );
    } catch {
      this.logger.warn('Jejak eksekusi Agent tidak dapat dimulai.');
    }
  }

  async recordTool(requestId: string, ownerId: string, name: string, durationMs: number, outcome: 'success' | 'error'): Promise<void> {
    try {
      const safeName = /^[a-z][a-z0-9_]{0,79}$/i.test(name) ? name : 'unknown_tool';
      await this.collection().updateOne(
        { ownerId, requestId, status: 'running' },
        { $push: { toolCalls: { name: safeName, durationMs: Math.max(0, Math.round(durationMs)), outcome } } },
      );
    } catch {
      this.logger.warn('Jejak langkah Agent tidak dapat disimpan.');
    }
  }

  async recordPlan(requestId: string | undefined, ownerId: string, round: number, names: string[], status: 'approved' | 'rejected', reason?: string | null): Promise<void> {
    if (!requestId) return;
    try {
      const toolNames = names.slice(0, 12).map(name => /^[a-z][a-z0-9_]{0,79}$/i.test(name) ? name : 'unknown_tool');
      await this.collection().updateOne(
        { ownerId, requestId, status: 'running' },
        { $push: { executionPlans: { $each: [{ round: Math.max(1, Math.round(round)), status, toolNames, ...(reason ? { reason: reason.slice(0, 240) } : {}), createdAt: new Date() }], $slice: -12 } } },
      );
    } catch {
      this.logger.warn('Rencana eksekusi Agent tidak dapat dicatat.');
    }
  }

  async recordSkills(requestId: string, ownerId: string, skills: Array<{ name: string; version: number }>): Promise<void> {
    try {
      await this.collection().updateOne(
        { ownerId, requestId, status: 'running' },
        { $set: { appliedSkills: skills.slice(0, 5).map(skill => ({ name: skill.name.slice(0, 80), version: Math.max(1, Math.round(skill.version)) })) } },
      );
    } catch {
      this.logger.warn('Skill yang digunakan tidak dapat dicatat pada jejak Agent.');
    }
  }

  async complete(requestId: string, ownerId: string, startedAtMs: number, usedSources: Array<{ alias: string; branchId: string }>): Promise<void> {
    await this.finish(requestId, ownerId, startedAtMs, 'completed', usedSources);
  }

  async fail(requestId: string, ownerId: string, startedAtMs: number, errorStatus?: number): Promise<void> {
    await this.finish(requestId, ownerId, startedAtMs, 'failed', [], errorStatus);
  }

  async feedback(requestId: string, principal: AuthPrincipal, dto: AgentFeedbackDto) {
    const message = await this.mongo.db.collection('agent_chat_messages').findOne(
      { ownerId: principal.sub, requestId, role: 'assistant' },
      { projection: { sessionId: 1, createdAt: 1 } },
    );
    if (!message) throw new NotFoundException('Jawaban Agent tidak ditemukan pada riwayat akun ini.');

    const now = new Date();
    const feedback = {
      rating: dto.rating,
      ...(dto.rating === 'needs-improvement' && dto.category ? { category: dto.category } : {}),
      updatedAt: now,
    };
    await this.collection().updateOne(
      { ownerId: principal.sub, requestId },
      {
        $set: { feedback },
        $setOnInsert: {
          ownerId: principal.sub,
          requestId,
          sessionId: String(message.sessionId),
          userRole: principal.role,
          status: 'completed',
          startedAt: message.createdAt instanceof Date ? message.createdAt : now,
          completedAt: message.createdAt instanceof Date ? message.createdAt : now,
          toolCalls: [],
          appliedSkills: [],
          usedSources: [],
          attempts: 1,
          legacyTrace: true,
        },
      },
      { upsert: true },
    );
    await this.mongo.db.collection('agent_chat_messages').updateOne(
      { ownerId: principal.sub, requestId, role: 'assistant' },
      { $set: { feedback } },
    );
    return feedback;
  }

  async list(days: number, page: number, pageSize: number, rating: string) {
    const startedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const periodFilter = { startedAt: { $gte: startedAfter } };
    const filter: Record<string, unknown> = { ...periodFilter };
    if (rating === 'helpful') filter['feedback.rating'] = 'helpful';
    if (rating === 'needs-improvement') filter['feedback.rating'] = 'needs-improvement';
    if (rating === 'unrated') filter.feedback = { $exists: false };

    const traces = this.collection();
    const [total, rows, stats] = await Promise.all([
      traces.countDocuments(filter),
      traces.find(filter).sort({ startedAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      traces.aggregate([
        { $match: periodFilter },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          running: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
          helpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'helpful'] }, 1, 0] } },
          needsImprovement: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'needs-improvement'] }, 1, 0] } },
        } },
        { $project: { _id: 0 } },
      ]).toArray(),
    ]);

    const ownerIds = [...new Set(rows.map(row => row.ownerId).filter(id => ObjectId.isValid(id)))].map(id => new ObjectId(id));
    const users = ownerIds.length
      ? await this.mongo.db.collection('users').find({ _id: { $in: ownerIds } }, { projection: { name: 1, role: 1 } }).toArray()
      : [];
    const userById = new Map(users.map(user => [user._id.toHexString(), { name: String(user.name ?? 'Pengguna'), role: String(user.role ?? '') }]));

    return {
      period: { days, from: startedAfter.toISOString() },
      summary: stats[0] ?? { total: 0, completed: 0, failed: 0, running: 0, helpful: 0, needsImprovement: 0 },
      items: rows.map(row => ({
        id: row._id.toHexString(),
        requestId: row.requestId,
        sessionId: row.sessionId ?? null,
        user: userById.get(row.ownerId) ?? { name: `Pengguna ${row.ownerId.slice(-6)}`, role: row.userRole },
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt ?? null,
        durationMs: row.durationMs ?? null,
        toolCalls: row.toolCalls ?? [],
        executionPlans: row.executionPlans ?? [],
        appliedSkills: row.appliedSkills ?? [],
        usedSources: row.usedSources ?? [],
        errorStatus: row.errorStatus ?? null,
        feedback: row.feedback ?? null,
        attempts: row.attempts ?? 1,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  private async finish(
    requestId: string,
    ownerId: string,
    startedAtMs: number,
    status: 'completed' | 'failed',
    usedSources: Array<{ alias: string; branchId: string }>,
    errorStatus?: number,
  ): Promise<void> {
    try {
      await this.collection().updateOne(
        { ownerId, requestId },
        {
          $set: {
            status,
            completedAt: new Date(),
            durationMs: Math.max(0, Date.now() - startedAtMs),
            usedSources: usedSources.map(source => ({ alias: source.alias.slice(0, 80), branchId: source.branchId.slice(0, 80) })),
            ...(errorStatus ? { errorStatus } : {}),
          },
        },
      );
    } catch {
      this.logger.warn('Status akhir jejak Agent tidak dapat disimpan.');
    }
  }

  private collection() {
    return this.mongo.db.collection<AgentRunTrace>('agent_run_traces');
  }
}
