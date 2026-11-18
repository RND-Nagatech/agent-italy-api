import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { env } from '../config/env';
import { SharedMemory, KnowledgeJob } from './knowledge.types';
import { learningPrompt, parseLearningCandidates, worthExtracting, hasCredential } from './learning-policy';
import { AgentGatewayAuditService } from '../agent/agent-gateway-audit.service';
import type { AgentGatewayAuditContext } from '../agent/agent-gateway-audit.service';

type LearningEvent = {
  _id: string; ownerId: string; sessionId: string; requestId: string; userText: string;
  references: string[]; status: 'queued' | 'processing' | 'done' | 'skipped' | 'failed' | 'cancelled';
  attempts: number; availableAt: Date; createdAt: Date; leaseUntil?: Date; lock?: string; reason?: string;
};
@Injectable()
export class MemoryLearningService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(MemoryLearningService.name);
  constructor(private readonly mongo: MongoService, private readonly gatewayAudit: AgentGatewayAuditService) {}
  private get events() { return this.mongo.db.collection<LearningEvent>('memory_learning_events'); }
  async onModuleInit() {
    await this.mongo.db.collection('memory_learning_control').createIndex({ name: 1 }, { unique: true });
    await this.events.createIndex({ status: 1, availableAt: 1 });
    await this.mongo.db.collection('shared_memories').createIndex({ learnedHash: 1 }, { unique: true, partialFilterExpression: { learnedHash: { $type: 'string' } } });
    await this.mongo.db.collection('shared_memories').createIndex({ learningKey: 1 });
    this.logger.log(`Pembelajaran percakapan ${env.hindsightAutoLearn ? 'aktif' : 'nonaktif'}; riwayat chat ${env.hindsightLearnHistory ? 'aktif' : 'nonaktif'}.`);
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.warn('Pemrosesan pembelajaran tertunda; akan dicoba kembali.')); }, 5000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async enqueue(ownerId: string, sessionId: string, requestId: string, userText: string, references: string[] = []) {
    if (!env.hindsightAutoLearn) return;
    const id = createHash('sha256').update(`${ownerId}:${requestId}`).digest('hex');
    await this.events.updateOne({ _id: id }, { $setOnInsert: { _id: id, ownerId, sessionId, requestId, userText: hasCredential(userText) ? '' : userText.slice(0, 16000), references, status: 'queued', attempts: 0, availableAt: new Date(), createdAt: new Date() } }, { upsert: true });
  }
  async status() {
    const counts = await this.events.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    return { enabled: env.hindsightAutoLearn, historyEnabled: env.hindsightLearnHistory, counts: Object.fromEntries(counts.map(row => [row._id, row.count])), history: await this.mongo.db.collection('memory_learning_control').findOne({ name: 'history' }, { projection: { cursor: 1, updatedAt: 1, scanned: 1 } }) };
  }
  async retryFailed() { await this.events.updateMany({ status: 'failed' }, { $set: { status: 'queued', attempts: 0, availableAt: new Date() }, $unset: { reason: '', leaseUntil: '', lock: '' } }); return { queued: true }; }
  private async scanHistory() {
    const controls = this.mongo.db.collection('memory_learning_control');
    await controls.updateOne({ name: 'history' }, { $setOnInsert: { name: 'history', scanned: 0 } }, { upsert: true });
    const control = await controls.findOne({ name: 'history' });
    const rows = await this.mongo.db.collection('agent_chat_messages').find({ role: 'user', ...(control?.cursor ? { _id: { $gt: control.cursor } } : {}) }).sort({ _id: 1 }).limit(30).toArray();
    for (const row of rows) {
      const assistant = await this.mongo.db.collection('agent_chat_messages').findOne({ ownerId: row.ownerId, sessionId: row.sessionId, requestId: row.requestId, role: 'assistant' });
      if (assistant && typeof row.content === 'string') {
        await this.enqueue(row.ownerId, row.sessionId.toString(), row.requestId, row.content, (assistant.knowledgeReferences || []).map((ref: any) => ref.documentId));
      }
      await controls.updateOne({ name: 'history' }, { $max: { cursor: row._id }, $inc: { scanned: 1 }, $set: { updatedAt: new Date() } });
    }
  }
  async tick() {
    if (this.busy || !env.hindsightAutoLearn) return;
    this.busy = true;
    try {
      if (env.hindsightLearnHistory) await this.scanHistory();
      await this.events.updateMany({ status: 'processing', leaseUntil: { $lt: new Date() }, attempts: { $gte: 3 } }, { $set: { status: 'failed', reason: 'Batas percobaan tercapai.' } });
      const lock = randomUUID(), now = new Date();
      const event = await this.events.findOneAndUpdate({ attempts: { $lt: 3 }, $or: [{ status: 'queued', availableAt: { $lte: now } }, { status: 'processing', leaseUntil: { $lt: now } }] }, { $set: { status: 'processing', lock, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, returnDocument: 'after' });
      if (!event) return;
      try {
        if (!await this.safeSource(event) || !worthExtracting(event.userText)) {
          await this.events.updateOne({ _id: event._id, lock, status: 'processing' }, { $set: { userText: '', status: 'skipped', reason: 'Tidak memuat pengetahuan umum yang layak disimpan atau konteks dibatasi.' } }); return;
        }
        const content = await this.extract(event);
        const candidates = parseLearningCandidates(content, event.userText);
        await this.mongo.mongoClient.withSession(async session => session.withTransaction(async () => {
          if (!await this.events.findOne({ _id: event._id, lock, status: 'processing' }, { session }) || !await this.safeSource(event)) return;
          for (const candidate of candidates) {
            const learnedHash = createHash('sha256').update(candidate.text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
            const memories = this.mongo.db.collection<SharedMemory>('shared_memories');
            if (await memories.findOne({ learnedHash }, { session })) continue;
            const conflict = await memories.findOne({ learningKey: candidate.key, status: { $ne: 'deleted' } }, { session });
            const automatic = candidate.confidence >= 0.9 && !conflict;
            const id = new ObjectId();
            await memories.insertOne({ _id: id, title: candidate.title, text: candidate.text, status: automatic ? 'queued' : 'pending', createdBy: event.ownerId, createdAt: new Date(), updatedAt: new Date(), sessionId: event.sessionId, documentId: `pantes-memory-${id}`, sourceKind: 'conversation-extraction', learningKey: candidate.key, learnedHash, evidence: candidate.evidence, confidence: candidate.confidence, category: candidate.category, sourceEventId: event._id, approvalMode: automatic ? 'automatic' : 'review', ...(conflict ? { conflictWith: conflict._id.toString() } : {}) }, { session });
            if (automatic) await this.mongo.db.collection<KnowledgeJob>('knowledge_jobs').insertOne({ _id: new ObjectId(), kind: 'retain', targetId: id, status: 'queued', attempts: 0, availableAt: new Date() }, { session });
          }
          await this.events.updateOne({ _id: event._id, lock, status: 'processing' }, { $set: { userText: '', status: 'done', reason: `${candidates.length} kandidat pengetahuan dievaluasi.` } }, { session });
        }));
      } catch {
        await this.events.updateOne({ _id: event._id, lock, status: 'processing' }, { $set: { status: event.attempts >= 3 ? 'failed' : 'queued', reason: 'Ekstraksi belum berhasil. Periksa koneksi/model gateway.', availableAt: new Date(Date.now() + event.attempts * 30000) } });
      }
    } finally { this.busy = false; }
  }
  private async safeSource(event: LearningEvent) {
    if (!ObjectId.isValid(event.sessionId) || !await this.mongo.db.collection('agent_chat_sessions').findOne({ _id: new ObjectId(event.sessionId), ownerId: event.ownerId })) return false;
    for (const id of event.references) {
      if (!ObjectId.isValid(id) || !await this.mongo.db.collection('knowledge_documents').findOne({ _id: new ObjectId(id), visibility: 'global', deleted: false })) return false;
    }
    return true;
  }
  private async extract(event: LearningEvent) {
    const userText = event.userText;
    if (!env.deepSeekApiKey || hasCredential(userText)) throw new Error('Model ekstraksi belum tersedia.');
    const payloadJson = JSON.stringify({ model: env.deepSeekModel, temperature: 0, max_tokens: 1500, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: learningPrompt }, { role: 'user', content: JSON.stringify({ latestUserMessage: userText }) }] });
    const auditContext: AgentGatewayAuditContext = {
      exchangeRequestId: event.requestId,
      sessionId: event.sessionId,
      actorId: event.ownerId,
      actorEmail: await this.gatewayAudit.resolveActorEmail(event.ownerId),
    };
    const auditId = await this.gatewayAudit.begin({ context: auditContext, kind: 'memory-learning', round: event.attempts, model: env.deepSeekModel, path: new URL(`${env.deepSeekBaseUrl}/chat/completions`).pathname, payloadJson });
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${env.deepSeekBaseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${env.deepSeekApiKey}`, 'Content-Type': 'application/json' }, body: payloadJson, signal: AbortSignal.timeout(60000), redirect: 'error' });
    } catch (error) {
      await this.gatewayAudit.finish(auditId, { outcome: 'network-error', statusCode: null, latencyMs: Date.now() - startedAt });
      throw error;
    }
    if (!response.ok) {
      await this.gatewayAudit.finish(auditId, { outcome: 'http-error', statusCode: response.status, latencyMs: Date.now() - startedAt });
      throw new Error('Gateway ekstraksi tidak tersedia.');
    }
    let body: any;
    try {
      body = await response.json() as any;
    } catch (error) {
      await this.gatewayAudit.finish(auditId, { outcome: 'response-error', statusCode: response.status, latencyMs: Date.now() - startedAt });
      throw error;
    }
    const finishReason = body.choices?.[0]?.finish_reason ?? null;
    await this.gatewayAudit.finish(auditId, { outcome: 'succeeded', statusCode: response.status, latencyMs: Date.now() - startedAt, finishReason });
    if (finishReason === 'length' || typeof body.choices?.[0]?.message?.content !== 'string') throw new Error('Ekstraksi tidak lengkap.');
    return body.choices[0].message.content as string;
  }
}
