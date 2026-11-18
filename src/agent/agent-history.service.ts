import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { EmbeddingService } from '../knowledge/embedding.service';

type HistoryMessage = {
  _id: ObjectId;
  ownerId: string;
  sessionId: ObjectId;
  requestId: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  historyIndexStatus?: 'queued' | 'indexed' | 'failed';
  historyIndexedAt?: Date;
};

type HistorySearchRow = Pick<HistoryMessage, '_id' | 'sessionId' | 'requestId' | 'sequence' | 'role' | 'content' | 'createdAt'>;

type HistoryJob = {
  _id: ObjectId;
  dedupeKey: string;
  kind: 'index-message' | 'delete-session';
  targetId: ObjectId;
  ownerId: string;
  sessionId: ObjectId;
  status: 'queued' | 'processing' | 'done' | 'failed';
  attempts: number;
  availableAt: Date;
  leaseUntil?: Date;
  lock?: string;
  error?: string;
};

type HistoryCandidate = {
  sessionId: ObjectId;
  requestId: string;
  score: number;
  matchType: 'semantic' | 'keyword' | 'both';
};

type HistoryPayload = {
  ownerId?: string;
  sessionId?: string;
  requestId?: string;
  userMessageId?: string;
  model?: string;
};

@Injectable()
export class AgentHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentHistoryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private initialized?: Promise<void>;
  private get vectorBase() {
    return `${env.qdrantUrl}/collections/${encodeURIComponent(env.agentHistoryQdrantCollection)}`;
  }

  constructor(private readonly mongo: MongoService, private readonly embeddings: EmbeddingService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async search(ownerId: string, queryValue: string, limit = 10) {
    const query = queryValue.replace(/\s+/g, ' ').trim();
    if (query.length < 2 || query.length > 200) throw new BadRequestException('Kata kunci pencarian harus 2–200 karakter.');
    const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(20, limit)) : 10;
    const messages = this.mongo.db.collection<HistoryMessage>('agent_chat_messages');
    const lexicalTerms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    const lexicalRows = lexicalTerms.length ? await messages.find(
      { ownerId, role: { $in: ['user', 'assistant'] }, $text: { $search: lexicalTerms.join(' ') } },
      { projection: { ownerId: 1, sessionId: 1, requestId: 1, sequence: 1, role: 1, content: 1, createdAt: 1, score: { $meta: 'textScore' } } },
    ).sort({ score: { $meta: 'textScore' }, createdAt: -1 }).limit(safeLimit * 4).toArray() : [];

    let semanticRows: Array<{ score: number; payload?: HistoryPayload }> = [];
    let semanticUnavailable = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const semanticPromise = this.searchSemantic(ownerId, query);
      const semanticResult = await Promise.race([
        semanticPromise.then(rows => ({ kind: 'ready' as const, rows })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), 8_000);
          timeout.unref();
        }),
      ]);
      if (semanticResult.kind === 'timeout') semanticUnavailable = true;
      else semanticRows = semanticResult.rows;
    } catch {
      semanticUnavailable = true;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const candidates = new Map<string, HistoryCandidate>();
    for (const row of lexicalRows) {
      if (!(row.sessionId instanceof ObjectId) || !row.requestId) continue;
      const key = `${row.sessionId.toHexString()}:${row.requestId}`;
      const score = Math.min(0.89, 0.58 + Number((row as HistoryMessage & { score?: number }).score ?? 0) * 0.08);
      const current = candidates.get(key);
      candidates.set(key, {
        sessionId: row.sessionId,
        requestId: row.requestId,
        score: Math.min(1, Math.max(score, current?.score ?? 0) + (current ? 0.04 : 0)),
        matchType: current ? 'both' : 'keyword',
      });
    }
    for (const row of semanticRows) {
      const payload = row.payload;
      const sessionIdValue = payload?.sessionId;
      if (payload?.ownerId !== ownerId || typeof sessionIdValue !== 'string' || !ObjectId.isValid(sessionIdValue) || !payload.requestId) continue;
      const sessionId = new ObjectId(sessionIdValue);
      const key = `${sessionId.toHexString()}:${payload.requestId}`;
      const score = Math.max(0, Math.min(1, Number(row.score) || 0));
      const current = candidates.get(key);
      candidates.set(key, {
        sessionId,
        requestId: payload.requestId,
        score: Math.min(1, Math.max(score, current?.score ?? 0) + (current ? 0.04 : 0)),
        matchType: current ? 'both' : 'semantic',
      });
    }

    const selected = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, safeLimit);
    if (!selected.length) return { items: [], warning: semanticUnavailable ? 'Pencarian semantik sedang tidak tersedia; pencarian kata kunci juga tidak menemukan kecocokan.' : null };

    const messageFilter = selected.map(({ sessionId, requestId }) => ({ sessionId, requestId }));
    const [pairedMessages, sessions] = await Promise.all([
      messages.find({ ownerId, role: { $in: ['user', 'assistant'] }, $or: messageFilter })
        .project({ _id: 1, sessionId: 1, requestId: 1, sequence: 1, role: 1, content: 1, createdAt: 1 })
        .toArray(),
      this.mongo.db.collection<{ _id: ObjectId; ownerId: string; title: string }>('agent_chat_sessions')
        .find({ ownerId, _id: { $in: [...new Map(selected.map(item => [item.sessionId.toHexString(), item.sessionId])).values()] } }, { projection: { title: 1 } })
        .toArray(),
    ]);
    const messageByExchange = new Map<string, { user?: HistorySearchRow; assistant?: HistorySearchRow }>();
    for (const message of pairedMessages as HistorySearchRow[]) {
      const key = `${message.sessionId.toHexString()}:${message.requestId}`;
      const pair = messageByExchange.get(key) ?? {};
      if (message.role === 'user') pair.user = message;
      else if (message.role === 'assistant') pair.assistant = message;
      messageByExchange.set(key, pair);
    }
    const titleBySession = new Map(sessions.map(session => [session._id.toHexString(), session.title]));
    const items = selected.flatMap(candidate => {
      const sessionKey = candidate.sessionId.toHexString();
      const pair = messageByExchange.get(`${sessionKey}:${candidate.requestId}`);
      const user = pair?.user;
      const assistant = pair?.assistant;
      const matched = user ?? assistant;
      const title = titleBySession.get(sessionKey);
      if (!matched || !title) return [];
      return [{
        sessionId: sessionKey,
        sessionTitle: title,
        requestId: candidate.requestId,
        messageId: (user ?? matched)._id.toHexString(),
        sequence: user?.sequence ?? matched.sequence,
        createdAt: matched.createdAt,
        question: makeSnippet(user?.content ?? ''),
        answer: makeSnippet(assistant?.content ?? ''),
        matchType: candidate.matchType,
      }];
    });
    return {
      items,
      warning: semanticUnavailable ? 'Pencarian semantik tidak tersedia; hasil kata kunci tetap ditampilkan.' : null,
    };
  }

  private async searchSemantic(ownerId: string, query: string) {
    const [vector] = await this.embeddings.embed([query], true);
    await this.ensureVectorCollection();
    const data = await this.vectorCall('/points/query', 'POST', {
      query: vector,
      limit: 24,
      score_threshold: 0.42,
      with_payload: true,
      filter: { must: [
        { key: 'ownerId', match: { value: ownerId } },
        { key: 'model', match: { value: this.embeddings.fingerprint } },
      ] },
    });
    return (data.result?.points ?? []) as Array<{ score: number; payload?: HistoryPayload }>;
  }

  private async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    const jobs = this.mongo.db.collection<HistoryJob>('agent_history_jobs');
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.queueOneBackfillMessage();
      const now = new Date();
      const exhausted = await jobs.find({ status: 'processing', leaseUntil: { $lt: now }, attempts: { $gte: 3 } }).limit(20).toArray();
      for (const stale of exhausted) {
        const result = await jobs.updateOne({ _id: stale._id, status: 'processing', leaseUntil: { $lt: now } }, { $set: { status: 'failed', error: 'Proses indeks terhenti setelah batas percobaan.' }, $unset: { leaseUntil: '', lock: '' } });
        if (result.modifiedCount && stale.kind === 'index-message') {
          await this.mongo.db.collection<HistoryMessage>('agent_chat_messages').updateOne({ _id: stale.targetId, ownerId: stale.ownerId }, { $set: { historyIndexStatus: 'failed' } });
        }
      }
      const lock = randomUUID();
      const job = await jobs.findOneAndUpdate(
        { attempts: { $lt: 3 }, $or: [{ status: 'queued', availableAt: { $lte: now } }, { status: 'processing', leaseUntil: { $lt: now } }] },
        { $set: { status: 'processing', leaseUntil: new Date(Date.now() + 90_000), lock }, $inc: { attempts: 1 } },
        { sort: { availableAt: 1, _id: 1 }, returnDocument: 'after' },
      );
      if (!job) return;
      heartbeat = setInterval(() => { void jobs.updateOne({ _id: job._id, lock, status: 'processing' }, { $set: { leaseUntil: new Date(Date.now() + 90_000) } }).catch(() => undefined); }, 15_000);
      heartbeat.unref();
      try {
        if (job.kind === 'index-message') await this.indexMessage(job);
        else await this.deleteSessionPoints(job.ownerId, job.sessionId);
        await jobs.updateOne({ _id: job._id, lock }, { $set: { status: 'done', error: '' }, $unset: { leaseUntil: '', lock: '' } });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : 'Indeks percakapan gagal.';
        const retry = job.attempts < 3;
        await jobs.updateOne({ _id: job._id, lock }, { $set: { status: retry ? 'queued' : 'failed', availableAt: new Date(Date.now() + job.attempts * 15_000), error: message }, $unset: { leaseUntil: '', lock: '' } });
        if (job.kind === 'index-message') {
          await this.mongo.db.collection<HistoryMessage>('agent_chat_messages').updateOne(
            { _id: job.targetId, ownerId: job.ownerId },
            { $set: { historyIndexStatus: retry ? 'queued' : 'failed' } },
          );
        }
        this.logger.warn('Pencarian semantik riwayat belum dapat diperbarui.');
      }
    } catch {
      // Durable jobs remain available for a later tick or backend restart.
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.running = false;
    }
  }

  private async queueOneBackfillMessage() {
    const messages = this.mongo.db.collection<HistoryMessage>('agent_chat_messages');
    const message = await messages.findOne(
        { role: 'user', historyIndexStatus: { $exists: false } },
      { sort: { _id: 1 }, projection: { ownerId: 1, sessionId: 1, requestId: 1 } },
    );
    if (!message) return;
    const now = new Date();
    await this.mongo.db.collection<HistoryJob>('agent_history_jobs').updateOne(
      { dedupeKey: `index:${message._id.toHexString()}` },
      { $setOnInsert: {
        _id: new ObjectId(), dedupeKey: `index:${message._id.toHexString()}`, kind: 'index-message', targetId: message._id,
        ownerId: message.ownerId, sessionId: message.sessionId, status: 'queued', attempts: 0, availableAt: now,
      } },
      { upsert: true },
    );
    await messages.updateOne({ _id: message._id, ownerId: message.ownerId, historyIndexStatus: { $exists: false } }, { $set: { historyIndexStatus: 'queued' } });
  }

  private async indexMessage(job: HistoryJob) {
    const messages = this.mongo.db.collection<HistoryMessage>('agent_chat_messages');
    const user = await messages.findOne({ _id: job.targetId, ownerId: job.ownerId, sessionId: job.sessionId, role: 'user' });
    if (!user) return;
    if (typeof user.requestId !== 'string' || !user.requestId) {
      await messages.updateOne({ _id: user._id, ownerId: job.ownerId }, { $set: { historyIndexStatus: 'failed' } });
      return;
    }
    const assistant = await messages.findOne({ ownerId: job.ownerId, sessionId: job.sessionId, requestId: user.requestId, role: 'assistant' });
    const text = `Pertanyaan: ${user.content}\nJawaban: ${(assistant?.content ?? '').slice(0, 3_500)}`.slice(0, 5_500);
    const [vector] = await this.embeddings.embed([text]);
    await this.ensureVectorCollection();
    const pointId = objectIdPointId(user._id);
    await this.vectorCall('/points?wait=true', 'PUT', { points: [{
      id: pointId,
      vector,
      payload: {
        ownerId: job.ownerId,
        sessionId: job.sessionId.toHexString(),
        requestId: user.requestId,
        userMessageId: user._id.toHexString(),
        model: this.embeddings.fingerprint,
      },
    }] });
    await messages.updateOne({ _id: user._id, ownerId: job.ownerId }, { $set: { historyIndexStatus: 'indexed', historyIndexedAt: new Date() } });
  }

  private async deleteSessionPoints(ownerId: string, sessionId: ObjectId) {
    await this.ensureVectorCollection();
    await this.vectorCall('/points/delete?wait=true', 'POST', { filter: { must: [
      { key: 'ownerId', match: { value: ownerId } },
      { key: 'sessionId', match: { value: sessionId.toHexString() } },
    ] } });
  }

  private async ensureVectorCollection() {
    if (!this.initialized) this.initialized = (async () => {
      const response = await fetch(this.vectorBase, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (response.status === 404) {
        await this.vectorCall('', 'PUT', { vectors: { size: env.embeddingDimensions, distance: 'Cosine' } });
      } else {
        if (!response.ok) throw new Error('Koleksi riwayat Qdrant tidak tersedia.');
        const data = await response.json() as { result?: { config?: { params?: { vectors?: { size?: number } } } } };
        if (data.result?.config?.params?.vectors?.size !== env.embeddingDimensions) throw new Error('Dimensi koleksi riwayat Qdrant tidak sesuai model embedding.');
      }
      for (const field of ['ownerId', 'sessionId', 'model']) {
        await this.vectorCall('/index?wait=true', 'PUT', { field_name: field, field_schema: 'keyword' });
      }
    })().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }

  private async vectorCall(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(this.vectorBase + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Qdrant riwayat menolak permintaan (${response.status}).`);
    return response.json() as Promise<{ result?: { points?: unknown[] } }>;
  }
}

function objectIdPointId(id: ObjectId): string {
  const bytes = createHash('sha256').update(id.toHexString()).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function makeSnippet(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= 240 ? text : `${text.slice(0, 237).trimEnd()}…`;
}
