import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GridFSBucket, ObjectId } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname, basename } from 'node:path';
import { MongoService } from '../database/mongo.service';
import { env } from '../config/env';
import { AuthPrincipal } from '../users/user.types';
import { EmbeddingService } from './embedding.service';
import { KnowledgeVectorService } from './vector.service';
import { SharedMemoryService } from './memory.service';
import { KnowledgeDocument, KnowledgeChunk, KnowledgeJob, KnowledgeReference } from './knowledge.types';
import { KnowledgeMetadataDto, KnowledgePatchDto } from './knowledge.dto';
import { canManageKnowledge, readableKnowledge, visibleKnowledge, requireKnowledgeManager } from './knowledge-policy';
import { chunkPages, extractDocument, MIME, validateDocument } from './document-parser';
export interface AgentKnowledgeContext { references: KnowledgeReference[]; memories: Array<{ id: string; title: string; text: string }>; warnings: string[] }
@Injectable()
export class KnowledgeService {
  constructor(private readonly mongo: MongoService, private readonly embeddings: EmbeddingService, private readonly vectors: KnowledgeVectorService, private readonly memory: SharedMemoryService) {}
  private get documents() { return this.mongo.db.collection<KnowledgeDocument>('knowledge_documents'); }
  private get chunks() { return this.mongo.db.collection<KnowledgeChunk>('knowledge_chunks'); }
  private get jobs() { return this.mongo.db.collection<KnowledgeJob>('knowledge_jobs'); }
  private get bucket() { return new GridFSBucket(this.mongo.db, { bucketName: 'knowledge_files' }); }
  private id(value: string) { if (!ObjectId.isValid(value)) throw new NotFoundException('Dokumen tidak ditemukan.'); return new ObjectId(value); }
  private enabled() { if (!env.knowledgeEnabled) throw new ServiceUnavailableException('Knowledge dinonaktifkan.'); }
  async branches(principal: AuthPrincipal) {
    requireKnowledgeManager(principal);
    return this.mongo.db.collection('shipment_sources').find({ active: true, sourceType: { $ne: 'central' } }, { projection: { _id: 0, branchId: 1, alias: 1 } }).sort({ alias: 1 }).toArray();
  }
  async processing(principal: AuthPrincipal) {
    requireKnowledgeManager(principal);
    return this.jobs.find({ status: 'failed' }, { projection: { error: 1, kind: 1, targetId: 1 } }).sort({ availableAt: -1 }).limit(20).toArray();
  }
  async retryJob(value: string, principal: AuthPrincipal) {
    requireKnowledgeManager(principal);
    const result = await this.jobs.updateOne({ _id: this.id(value), status: 'failed', kind: { $in: ['purge', 'forget'] } }, { $set: { status: 'queued', attempts: 0, availableAt: new Date() } });
    if (!result.matchedCount) throw new BadRequestException('Pekerjaan tidak ditemukan atau tidak dapat dicoba ulang.');
    return { queued: true };
  }
  async list(principal: AuthPrincipal, page = 1, search = '', sortBy: 'size' | 'createdAt' | 'title' = 'createdAt', direction: 'asc' | 'desc' = 'desc') {
    const query = { ...visibleKnowledge(principal), ...(search ? { title: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) };
    const total = await this.documents.countDocuments(query);
    const items = await this.documents.find(query, { projection: { fileId: 0, hash: 0 } }).sort({ [sortBy]: direction === 'asc' ? 1 : -1, _id: -1 }).skip((page - 1) * 20).limit(20).toArray();
    return { items, total, page, pageSize: 20, enabled: env.knowledgeEnabled, maxFileMb: env.knowledgeMaxFileMb, embeddingState: this.embeddings.state, memoryConfigured: this.memory.configured };
  }
  async upload(buffer: Buffer, originalName: string, metadata: KnowledgeMetadataDto, principal: AuthPrincipal) {
    this.enabled(); requireKnowledgeManager(principal);
    if (buffer.length > env.knowledgeMaxFileMb * 1024 * 1024) throw new BadRequestException('File melebihi batas upload.');
    const filename = basename(originalName).replace(/[\x00-\x1f]/g, '').slice(0, 200);
    const extension = extname(filename).toLowerCase(); await validateDocument(buffer, extension);
    if (!metadata.title.trim()) throw new BadRequestException('Judul wajib diisi.');
    const branchIds = [...new Set(metadata.branchIds.map(id => id.trim()).filter(Boolean))];
    if (metadata.visibility === 'branches') {
      if (!branchIds.length) throw new BadRequestException('Pilih minimal satu cabang.');
      const configured = await this.mongo.db.collection('shipment_sources').distinct('branchId', { active: true, branchId: { $in: branchIds }, sourceType: { $ne: 'central' } });
      if (configured.length !== branchIds.length) throw new BadRequestException('Cabang tidak aktif atau tidak ditemukan.');
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    const duplicate = await this.documents.findOne({ hash, deleted: false });
    if (duplicate) throw new BadRequestException(`File yang sama sudah diunggah sebagai “${duplicate.title}”. Gunakan dokumen tersebut atau proses ulang.`);
    let previous: KnowledgeDocument | null = null;
    if (metadata.replacesId) { previous = await this.documents.findOne({ _id: this.id(metadata.replacesId), deleted: false }); if (!previous) throw new NotFoundException('Versi sebelumnya tidak ditemukan.'); }
    const stream = this.bucket.openUploadStream(filename, { metadata: { mime: MIME[extension] } });
    try { await pipeline(Readable.from(buffer), stream); }
    catch { await stream.abort().catch(() => undefined); throw new BadRequestException('File tidak dapat disimpan. Coba upload ulang.'); }
    const now = new Date();
    const doc: KnowledgeDocument = { _id: new ObjectId(), title: metadata.title.trim(), description: metadata.description, category: metadata.category, filename, extension, mime: MIME[extension], size: buffer.length, hash, fileId: stream.id, visibility: metadata.visibility, branchIds: metadata.visibility === 'global' ? [] : branchIds, active: false, deleted: false, status: 'queued', chunkCount: 0, pageCount: 0, version: previous ? previous.version + 1 : 1, ...(previous ? { replacesId: previous._id.toHexString() } : {}), createdBy: principal.sub, createdAt: now, updatedAt: now };
    try {
      await this.mongo.mongoClient.withSession(async session => session.withTransaction(async () => {
        await this.documents.insertOne(doc, { session });
        await this.jobs.insertOne({ _id: new ObjectId(), kind: 'index', targetId: doc._id, status: 'queued', attempts: 0, availableAt: now }, { session });
      }));
    } catch (error) { await this.bucket.delete(stream.id); if (typeof error === 'object' && error && 'code' in error && error.code === 11000) throw new BadRequestException('File yang sama sudah diunggah.'); throw error; }
    return { id: doc._id.toHexString(), status: doc.status };
  }
  async detail(id: string, principal: AuthPrincipal) {
    const doc = await this.documents.findOne({ _id: this.id(id), ...visibleKnowledge(principal) }, { projection: { fileId: 0, hash: 0 } });
    if (!doc) throw new NotFoundException('Dokumen tidak ditemukan atau tidak dapat diakses.');
    const chunks = await this.chunks.find({ documentId: doc._id, generation: doc.generation || '__none__' }, { projection: { text: 1, page: 1, index: 1 } }).sort({ index: 1 }).limit(200).toArray();
    return { ...doc, chunks, previewTruncated: doc.chunkCount > 200 };
  }
  async download(id: string, principal: AuthPrincipal) {
    const doc = await this.documents.findOne({ _id: this.id(id), ...visibleKnowledge(principal) });
    if (!doc) throw new NotFoundException('Dokumen tidak ditemukan atau tidak dapat diakses.');
    return { stream: this.bucket.openDownloadStream(doc.fileId), filename: doc.filename, mime: doc.mime };
  }
  async patch(id: string, dto: KnowledgePatchDto, principal: AuthPrincipal) {
    requireKnowledgeManager(principal);
    if (dto.active !== undefined) {
      if (Object.entries(dto).some(([key, value]) => key !== 'active' && value !== undefined)) throw new BadRequestException('Ubah publikasi dan metadata secara terpisah.');
      return this.publish(id, dto.active, principal);
    }
    const doc = await this.documents.findOne({ _id: this.id(id), deleted: false });
    if (!doc) throw new NotFoundException();
    const changes: Partial<KnowledgeDocument> = { updatedAt: new Date() };
    for (const key of ['title', 'description', 'category'] as const) if (dto[key] !== undefined) changes[key] = dto[key]!.trim();
    if (changes.title === '') throw new BadRequestException('Judul tidak boleh kosong.');
    if (dto.visibility !== undefined || dto.branchIds !== undefined) {
      const visibility = dto.visibility ?? doc.visibility;
      const ids = [...new Set((dto.branchIds ?? doc.branchIds).map(id => id.trim()).filter(Boolean))];
      if (visibility === 'branches') {
        const configured = await this.mongo.db.collection('shipment_sources').distinct('branchId', { active: true, branchId: { $in: ids }, sourceType: { $ne: 'central' } });
        if (!ids.length || configured.length !== ids.length) throw new BadRequestException('Pilih cabang aktif yang valid.');
      }
      changes.visibility = visibility; changes.branchIds = visibility === 'global' ? [] : ids;
    }
    await this.documents.updateOne({ _id: doc._id, deleted: false }, { $set: changes });
    return { updated: true };
  }
  async publish(id: string, active: boolean, principal: AuthPrincipal) {
    requireKnowledgeManager(principal); const doc = await this.documents.findOne({ _id: this.id(id), deleted: false });
    if (!doc) throw new NotFoundException(); if (active && doc.status !== 'ready') throw new BadRequestException('Dokumen belum selesai diindeks.');
    await this.mongo.mongoClient.withSession(async session => session.withTransaction(async () => {
      await this.documents.updateOne({ _id: doc._id, deleted: false }, { $set: { active, updatedAt: new Date() } }, { session });
      if (active && doc.replacesId) await this.documents.updateOne({ _id: this.id(doc.replacesId) }, { $set: { active: false, updatedAt: new Date() } }, { session });
    }));
    return { active };
  }
  async reindex(id: string, principal: AuthPrincipal) {
    requireKnowledgeManager(principal); const targetId = this.id(id);
    await this.mongo.mongoClient.withSession(async session => session.withTransaction(async () => {
      const result = await this.documents.updateOne({ _id: targetId, deleted: false, status: { $in: ['ready', 'failed'] } }, { $set: { status: 'queued', active: false, error: '', updatedAt: new Date() } }, { session });
      if (!result.matchedCount) throw new BadRequestException('Dokumen tidak ditemukan atau sedang diproses.');
      await this.jobs.insertOne({ _id: new ObjectId(), kind: 'index', targetId, status: 'queued', attempts: 0, availableAt: new Date() }, { session });
    }));
    return { queued: true };
  }
  async remove(id: string, principal: AuthPrincipal) {
    requireKnowledgeManager(principal); const targetId = this.id(id);
    await this.mongo.mongoClient.withSession(async session => session.withTransaction(async () => {
      const result = await this.documents.updateOne({ _id: targetId, deleted: false }, { $set: { deleted: true, active: false, updatedAt: new Date() } }, { session });
      if (!result.matchedCount) throw new NotFoundException();
      await this.jobs.insertOne({ _id: new ObjectId(), kind: 'purge', targetId, status: 'queued', attempts: 0, availableAt: new Date() }, { session });
    }));
  }
  async indexDocument(id: ObjectId) {
    const doc = await this.documents.findOne({ _id: id, deleted: false }); if (!doc) return;
    await this.documents.updateOne({ _id: id, deleted: false }, { $set: { status: 'processing', active: false, updatedAt: new Date() } });
    const data: Buffer[] = []; for await (const chunk of this.bucket.openDownloadStream(doc.fileId)) data.push(Buffer.from(chunk));
    const pages = await extractDocument(Buffer.concat(data), doc.extension);
    const parts = chunkPages(pages); const generation = randomUUID();
    await this.vectors.remove(id.toHexString());
    await this.chunks.deleteMany({ documentId: id });
    for (let offset = 0; offset < parts.length; offset += 8) {
      if (!await this.documents.findOne({ _id: id, deleted: false }, { projection: { _id: 1 } })) return;
      const batch = parts.slice(offset, offset + 8);
      const vectors = await this.embeddings.embed(batch.map(part => part.text));
      const chunks: KnowledgeChunk[] = batch.map((part, index) => ({ _id: new ObjectId(), documentId: id, generation, index: offset + index, page: part.page, text: part.text, vectorId: randomUUID() }));
      await this.chunks.insertMany(chunks);
      await this.vectors.upsert(chunks.map((chunk, index) => ({ id: chunk.vectorId, vector: vectors[index], payload: { documentId: id.toHexString(), generation, model: this.embeddings.fingerprint, chunkId: chunk._id.toHexString() } })));
    }
    await this.documents.updateOne({ _id: id, deleted: false }, { $set: { status: 'ready', generation, indexedModel: this.embeddings.fingerprint, chunkCount: parts.length, pageCount: pages.length, updatedAt: new Date(), error: '' } });
  }
  async purgeDocument(id: ObjectId) {
    await this.vectors.remove(id.toHexString()); await this.chunks.deleteMany({ documentId: id });
    const doc = await this.documents.findOne({ _id: id, deleted: true });
    if (doc) { const files = await this.bucket.find({ _id: doc.fileId }).toArray(); if (files.length) await this.bucket.delete(doc.fileId); }
  }
  async search(query: string, principal: AuthPrincipal): Promise<{ references: KnowledgeReference[]; warning?: string; method: string }> {
    if (!env.knowledgeEnabled) return { references: [], method: 'disabled' };
    const docs = await this.documents.find(readableKnowledge(principal), { projection: { _id: 1, title: 1, generation: 1, indexedModel: 1 } }).limit(5001).toArray();
    if (!docs.length) return { references: [], method: 'vector' };
    if (docs.length > 5000) return { references: [], method: 'unavailable', warning: 'Terlalu banyak dokumen aktif; persempit koleksi sebelum pencarian.' };
    let candidates: Array<{ chunkId: string; generation: string; documentId: string }>;
    try {
      const [vector] = await Promise.race([this.embeddings.embed([query], true), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Embedding belum siap')), 5000).unref())]);
      const points = await this.vectors.search(vector, docs.map(doc => doc._id.toHexString()), this.embeddings.fingerprint);
      candidates = points.map(point => point.payload);
    } catch { return { references: [], method: 'unavailable', warning: 'Pencarian Knowledge belum tersedia. Periksa Qdrant/model embedding; jawaban data operasional tetap dapat diproses.' }; }
    const references: KnowledgeReference[] = [];
    for (const candidate of candidates) {
      if (references.length >= 5 || !ObjectId.isValid(candidate.chunkId) || !ObjectId.isValid(candidate.documentId)) continue;
      // Qdrant payloads are not authorization: re-check publication and branch scope in MongoDB.
      const doc = await this.documents.findOne({ _id: new ObjectId(candidate.documentId), ...readableKnowledge(principal), generation: candidate.generation, indexedModel: this.embeddings.fingerprint });
      if (!doc || references.filter(ref => ref.documentId === candidate.documentId).length >= 2) continue;
      const chunk = await this.chunks.findOne({ _id: new ObjectId(candidate.chunkId), documentId: doc._id, generation: doc.generation });
      if (!chunk) continue;
      references.push({ documentId: candidate.documentId, title: doc.title, page: chunk.page, locationLabel: doc.extension === '.pdf' ? `halaman ${chunk.page}` : 'kutipan teks', chunkId: candidate.chunkId, excerpt: chunk.text });
    }
    return { references, method: 'vector' };
  }
  async context(query: string, principal: AuthPrincipal): Promise<AgentKnowledgeContext> {
    const [knowledge, memory] = await Promise.all([this.search(query, principal).catch(() => ({ references: [], warning: 'Knowledge gagal dibaca.' })), this.memory.recall(query)]);
    return { references: knowledge.references, memories: memory.items, warnings: [knowledge.warning, ...(this.memory.configured && memory.unavailable ? ['Memory bersama sementara tidak tersedia.'] : [])].filter((s): s is string => Boolean(s)) };
  }
}
