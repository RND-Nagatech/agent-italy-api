import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ObjectId, type WithId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../database/mongo.service';
import { AgentSessionsService } from './agent-sessions.service';
import { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION, type PriceReadProgress } from './price-reference.service';

type ReadJob = {
  sessionId: ObjectId; ownerId: string; attachmentId: string; parserVersion: number;
  status: 'queued' | 'reading' | 'complete' | 'error'; message: string; handled?: boolean;
  startedAt: Date; updatedAt: Date; expiresAt: Date; leaseUntil?: Date; leaseToken?: string;
};

@Injectable()
export class PriceReadService {
  private readonly pending = new Set<string>();
  private readonly queue: WithId<ReadJob>[] = [];
  private running = 0;
  constructor(private readonly mongo: MongoService, private readonly sessions: AgentSessionsService, private readonly references: PriceReferenceService) {}
  private get jobs() { return this.mongo.db.collection<ReadJob>('agent_price_read_jobs'); }

  async start(sessionId: string, attachmentId: string, ownerId: string) {
    await this.sessions.assertOwner(sessionId, ownerId);
    await this.sessions.prepareAttachments(sessionId, ownerId, [attachmentId], [], true);
    const now = new Date();
    const key = { sessionId: new ObjectId(sessionId), ownerId, attachmentId, parserVersion: PRICE_REFERENCE_PARSER_VERSION };
    // Concurrent retries and different backend instances share the same job.
    let job: WithId<ReadJob> | null;
    try {
      job = await this.jobs.findOneAndUpdate(key, { $setOnInsert: { ...key, status: 'queued', message: 'Menunggu giliran membaca file', startedAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000) } }, { upsert: true, returnDocument: 'after' });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      job = await this.jobs.findOne(key);
    }
    if (!job) throw new NotFoundException('Proses pembacaan file tidak ditemukan.');
    if (job.status === 'error') {
      job = await this.jobs.findOneAndUpdate({ _id: job._id, ownerId, status: 'error' }, { $set: { status: 'queued', message: 'Mencoba membaca kembali file yang sama', startedAt: now, updatedAt: now }, $unset: { leaseToken: '', leaseUntil: '' } }, { returnDocument: 'after' }) ?? await this.jobs.findOne(key);
    }
    if (!job) throw new NotFoundException('Proses pembacaan file tidak ditemukan.');
    this.schedule(job);
    return this.view(job);
  }

  async get(id: string, ownerId: string) {
    if (!ObjectId.isValid(id)) throw new NotFoundException('Proses pembacaan file tidak ditemukan.');
    const job = await this.jobs.findOne({ _id: new ObjectId(id), ownerId });
    if (!job) throw new NotFoundException('Proses pembacaan file tidak ditemukan.');
    await this.sessions.assertOwner(job.sessionId.toHexString(), ownerId);
    // Polling can resume a queued/stale job after a server restart. An atomic
    // lease prevents another instance from parsing the same file concurrently.
    this.schedule(job);
    return this.view(job);
  }

  private async view(job: WithId<ReadJob>) {
    const reference = job.status === 'complete' && job.handled
      ? (await this.references.read(job.sessionId.toHexString(), job.ownerId, [job.attachmentId]))[0]
      : undefined;
    return { id: job._id.toHexString(), status: job.status, message: job.message, elapsedMs: Math.max(0, Date.now() - job.startedAt.getTime()), handled: job.handled, ...(reference ? { reference } : {}) };
  }

  private schedule(job: WithId<ReadJob>) {
    if (job.status !== 'queued' && !(job.status === 'reading' && (!job.leaseUntil || job.leaseUntil.getTime() <= Date.now()))) return;
    const id = job._id.toHexString();
    if (this.pending.has(id)) return;
    this.pending.add(id); this.queue.push(job); this.pump();
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!; this.running++;
      void this.run(job).catch(() => {
        // A database outage leaves the persisted lease recoverable by polling.
        console.warn('Proses pembacaan harga belum tersimpan; dapat dilanjutkan setelah koneksi pulih.');
      }).finally(() => { this.pending.delete(job._id.toHexString()); this.running--; this.pump(); });
    }
  }

  private async run(job: WithId<ReadJob>) {
    const now = new Date(), leaseToken = randomUUID();
    const owned = await this.jobs.findOneAndUpdate({ _id: job._id, ownerId: job.ownerId, $or: [{ status: 'queued' }, { status: 'reading', leaseUntil: { $lte: now } }] }, { $set: { status: 'reading', message: 'Membaca gambar dan tabel harga', leaseToken, leaseUntil: new Date(Date.now() + 300000), updatedAt: now } }, { returnDocument: 'after' });
    if (!owned) return;
    const guard = { _id: owned._id, ownerId: owned.ownerId, leaseToken };
    const progress = async (event: PriceReadProgress) => {
      const update = await this.jobs.updateOne(guard, { $set: { message: event.message, updatedAt: new Date(), leaseUntil: new Date(Date.now() + 300000) } });
      if (!update.matchedCount) throw new Error('Proses pembacaan tidak lagi tersedia.');
    };
    try {
      const result = await this.references.scope({ sessionId: owned.sessionId.toHexString(), attachmentIds: [owned.attachmentId], prompt: 'Baca file acuan harga' }, owned.ownerId, progress);
      await this.jobs.updateOne(guard, { $set: { status: 'complete', handled: result.handled, message: result.handled ? 'File harga penjualan/buyback selesai dibaca' : 'Gunakan file harga penjualan perhiasan atau buyback perhiasan/logam mulia', updatedAt: new Date() }, $unset: { leaseToken: '', leaseUntil: '' } });
    } catch (error) {
      const message = error instanceof HttpException ? error.message : 'File belum dapat dibaca. Coba lagi tanpa mengunggah ulang.';
      await this.jobs.updateOne(guard, { $set: { status: 'error', message, updatedAt: new Date() }, $unset: { leaseToken: '', leaseUntil: '' } });
    }
  }
}
