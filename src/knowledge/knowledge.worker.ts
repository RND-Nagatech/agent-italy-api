import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service';
import { KnowledgeService } from './knowledge.service';
import { SharedMemoryService } from './memory.service';
import { KnowledgeJob } from './knowledge.types';
import { env } from '../config/env';
@Injectable()
export class KnowledgeWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout; private running = false; private stopping = false;
  constructor(private readonly mongo: MongoService, private readonly knowledge: KnowledgeService, private readonly memory: SharedMemoryService) {}
  async onModuleInit() {
    await this.mongo.db.collection('knowledge_documents').createIndex({ hash: 1 }, { unique: true, partialFilterExpression: { deleted: false } });
    await this.mongo.db.collection('knowledge_documents').createIndex({ deleted: 1, active: 1, visibility: 1, branchIds: 1 });
    await this.mongo.db.collection('knowledge_chunks').createIndex({ documentId: 1, generation: 1, index: 1 }, { unique: true });
    await this.mongo.db.collection('knowledge_jobs').createIndex({ status: 1, availableAt: 1, leaseUntil: 1 });
    await this.mongo.db.collection('shared_memories').createIndex({ documentId: 1 }, { unique: true });
    await this.mongo.db.collection('shared_memories').createIndex({ createdBy: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
    this.timer = setInterval(() => void this.tick(), 3000); this.timer.unref();
  }
  onModuleDestroy() { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  async tick() {
    if (this.running || this.stopping) return; this.running = true;
    const jobs = this.mongo.db.collection<KnowledgeJob>('knowledge_jobs');
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const now = new Date(), lock = randomUUID();
      const exhausted = await jobs.find({ status: 'processing', leaseUntil: { $lt: now }, attempts: { $gte: 3 } }).limit(20).toArray();
      for (const stale of exhausted) {
        const result = await jobs.updateOne({ _id: stale._id, status: 'processing', leaseUntil: { $lt: now } }, { $set: { status: 'failed', error: 'Proses terhenti setelah batas percobaan. Jalankan proses ulang.' }, $unset: { leaseUntil: '', lock: '' } });
        if (result.modifiedCount && stale.kind === 'index') await this.mongo.db.collection('knowledge_documents').updateOne({ _id: stale.targetId, deleted: false, status: 'processing' }, { $set: { status: 'failed', error: 'Proses terhenti setelah batas percobaan. Jalankan proses ulang.', updatedAt: now } });
        if (result.modifiedCount && stale.kind === 'retain') await this.mongo.db.collection('shared_memories').updateOne({ _id: stale.targetId, status: 'syncing' }, { $set: { status: 'failed', error: 'Proses terhenti; coba terbitkan ulang.', updatedAt: now } });
      }
      const kinds = [...(env.knowledgeEnabled ? ['index', 'purge'] : ['purge']), ...(this.memory.configured ? ['retain', 'forget'] : [])];
      const job = await jobs.findOneAndUpdate({ kind: { $in: kinds as KnowledgeJob['kind'][] }, attempts: { $lt: 3 }, $or: [{ status: 'queued', availableAt: { $lte: now } }, { status: 'processing', leaseUntil: { $lt: now } }] }, { $set: { status: 'processing', leaseUntil: new Date(Date.now() + 90000), lock }, $inc: { attempts: 1 } }, { sort: { availableAt: 1, _id: 1 }, returnDocument: 'after' });
      if (!job) return;
      heartbeat = setInterval(() => { void jobs.updateOne({ _id: job._id, lock, status: 'processing' }, { $set: { leaseUntil: new Date(Date.now() + 90000) } }).catch(() => undefined); }, 15000); heartbeat.unref();
      try {
        if (job.kind === 'index') await this.knowledge.indexDocument(job.targetId);
        else if (job.kind === 'purge') await this.knowledge.purgeDocument(job.targetId);
        else if (job.kind === 'retain') await this.memory.retain(job.targetId);
        else await this.memory.forget(job.targetId);
        await jobs.updateOne({ _id: job._id, lock }, { $set: { status: 'done', error: '' }, $unset: { leaseUntil: '', lock: '' } });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 400) : 'Pemrosesan gagal.';
        const retry = job.attempts < 3;
        await jobs.updateOne({ _id: job._id, lock }, { $set: { status: retry ? 'queued' : 'failed', availableAt: new Date(Date.now() + job.attempts * 15000), error: message }, $unset: { leaseUntil: '', lock: '' } });
        if (job.kind === 'index') await this.mongo.db.collection('knowledge_documents').updateOne({ _id: job.targetId, deleted: false }, { $set: { status: retry ? 'queued' : 'failed', error: message, updatedAt: new Date() } });
        if (job.kind === 'retain') await this.mongo.db.collection('shared_memories').updateOne({ _id: job.targetId, status: { $in: ['syncing', 'queued', 'failed'] } }, { $set: { status: retry ? 'queued' : 'failed', error: message, updatedAt: new Date() } });
      }
    } catch { /* Database unavailable: the durable lease allows another tick/restart to recover. */ }
    finally { if (heartbeat) clearInterval(heartbeat); this.running = false; }
  }
}
