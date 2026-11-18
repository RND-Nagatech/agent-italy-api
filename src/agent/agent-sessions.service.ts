import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GridFSBucket, ObjectId } from 'mongodb';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MongoService } from '../database/mongo.service';
import { env } from '../config/env';
import { extractDocument } from '../knowledge/document-parser';
import { PDFParse } from 'pdf-parse';
import type { AgentResponseBlock } from './response-blocks';
import type { OfferedStockAllocationContext } from './offered-stock-followup';
import { restoreOfferedStockAllocationContextFromBlocks } from './offered-stock-followup';

export type AgentChatAttachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: Date;
};

export type PreparedAgentChatAttachment = AgentChatAttachment & (
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; text: string }
);

type AgentChatSessionDocument = {
  _id: ObjectId;
  ownerId: string;
  title: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  contextSummary?: string;
  contextSummaryThroughSequence?: number;
  contextSummaryUpdatedAt?: Date;
  lastAgentContinuation?: OfferedStockAllocationContext | null;
};

type AgentChatMessageDocument = {
  _id: ObjectId;
  sessionId: ObjectId;
  ownerId: string;
  requestId: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AgentChatAttachment[];
  blocks?: AgentResponseBlock[];
  usedSources?: Array<{ alias: string; branchId: string }>;
  knowledgeReferences?: Array<{ documentId: string; title: string; page: number; chunkId: string; excerpt: string }>;
  memoryReferences?: Array<{ id: string; title: string }>;
  contextWarnings?: string[];
  memoryProposal?: { id: string; title: string; status: string };
  feedback?: { rating: 'helpful' | 'needs-improvement'; category?: string; updatedAt: Date };
  historyIndexStatus?: 'queued' | 'indexed' | 'failed';
  historyIndexedAt?: Date;
  createdAt: Date;
};

type AgentChatAttachmentDocument = {
  _id: ObjectId;
  sessionId: ObjectId;
  ownerId: string;
  filename: string;
  mime: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  size: number;
  fileId: ObjectId;
  extractedText?: string;
  messageId?: ObjectId;
  createdAt: Date;
};

type AgentSessionSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentPromptHistoryMessage = Pick<AgentChatMessageDocument, 'role' | 'content' | 'sequence'> & {
  attachments?: AgentChatAttachment[];
  requestId?: string;
  blocks?: AgentResponseBlock[];
  usedSources?: Array<{ alias: string; branchId: string }>;
};

export type AgentPromptContextState = {
  summary: string;
  summaryThroughSequence: number;
  messages: AgentPromptHistoryMessage[];
  continuation?: OfferedStockAllocationContext;
};

const MAX_AGENT_CHAT_PDF_TEXT_CHARACTERS = 30_000;

@Injectable()
export class AgentSessionsService {
  constructor(private readonly mongo: MongoService) {}

  private get attachments() { return this.mongo.db.collection<AgentChatAttachmentDocument>('agent_chat_attachments'); }
  private get bucket() { return new GridFSBucket(this.mongo.db, { bucketName: 'agent_chat_files' }); }

  async list(ownerId: string): Promise<{ items: AgentSessionSummary[] }> {
    const sessions = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions')
      .find({ ownerId })
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();

    return { items: sessions.map((session) => this.toSummary(session)) };
  }

  async create(ownerId: string): Promise<AgentSessionSummary> {
    const now = new Date();
    const session: AgentChatSessionDocument = {
      _id: new ObjectId(),
      ownerId,
      title: 'Percakapan baru',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions').insertOne(session);
    return this.toSummary(session);
  }

  async get(sessionId: string, ownerId: string) {
    const id = this.parseId(sessionId);
    const session = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions')
      .findOne({ _id: id, ownerId });
    if (!session) throw new NotFoundException('Room percakapan tidak ditemukan.');

    const messages = await this.mongo.db.collection<AgentChatMessageDocument>('agent_chat_messages')
      .find({ sessionId: id, ownerId })
      .sort({ sequence: 1, createdAt: 1, _id: 1 })
      .toArray();
    const pendingAttachments = await this.attachments.find(
      { sessionId: id, ownerId, messageId: { $exists: false } },
      { projection: { filename: 1, mime: 1, size: 1, createdAt: 1 } },
    ).sort({ createdAt: 1 }).limit(3).toArray();

    return {
      ...this.toSummary(session),
      pendingAttachments: pendingAttachments.map(attachment => this.toAttachment(attachment)),
      messages: messages.map((message) => ({
        id: message._id.toHexString(),
        requestId: message.requestId,
        role: message.role,
        content: message.content,
        attachments: message.attachments ?? [],
        ...(message.blocks ? { blocks: message.blocks } : {}),
        ...(message.usedSources ? { usedSources: message.usedSources } : {}),
        knowledgeReferences: message.knowledgeReferences ?? [], memoryReferences: message.memoryReferences ?? [], contextWarnings: message.contextWarnings ?? [], memoryProposal: message.memoryProposal,
        feedback: message.feedback ?? null,
        createdAt: message.createdAt,
      })),
    };
  }

  async delete(sessionId: string, ownerId: string, forgetMemories = false): Promise<void> {
    const id = this.parseId(sessionId);
    const fileIds: ObjectId[] = [];
    await this.mongo.mongoClient.withSession(async (transaction) => {
      await transaction.withTransaction(async () => {
        const result = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions')
          .deleteOne({ _id: id, ownerId }, { session: transaction });
        if (!result.deletedCount) throw new NotFoundException('Room percakapan tidak ditemukan.');
        const attachmentFiles = await this.attachments.find({ sessionId: id, ownerId }, { session: transaction, projection: { fileId: 1 } }).toArray();
        fileIds.push(...attachmentFiles.map(attachment => attachment.fileId));
        await this.attachments.deleteMany({ sessionId: id, ownerId }, { session: transaction });
        await this.mongo.db.collection('agent_bank_statements').deleteMany({ sessionId, ownerId }, { session: transaction });
        await this.mongo.db.collection('agent_bank_reconciliations').deleteMany({ sessionId, ownerId }, { session: transaction });
        await this.mongo.db.collection('agent_history_jobs').updateOne(
          { dedupeKey: `delete:${ownerId}:${id.toHexString()}` },
          { $setOnInsert: { _id: new ObjectId(), dedupeKey: `delete:${ownerId}:${id.toHexString()}`, kind: 'delete-session', targetId: id, sessionId: id, ownerId, status: 'queued', attempts: 0, availableAt: new Date() } },
          { upsert: true, session: transaction },
        );
        await this.mongo.db.collection('memory_learning_events').updateMany({ sessionId, ownerId }, { $set: { status: 'cancelled', userText: '', references: [] } }, { session: transaction });
        await this.mongo.db.collection<AgentChatMessageDocument>('agent_chat_messages')
          .deleteMany({ sessionId: id, ownerId }, { session: transaction });
        if (forgetMemories) {
          const memories = this.mongo.db.collection('shared_memories');
          const linked = await memories.find({ sessionId, createdBy: ownerId, status: { $ne: 'deleted' } }, { session: transaction, projection: { _id: 1 } }).toArray();
          await memories.updateMany({ sessionId, createdBy: ownerId, status: { $ne: 'deleted' } }, { $set: { status: 'deleted', updatedAt: new Date() } }, { session: transaction });
          if (linked.length) await this.mongo.db.collection('knowledge_jobs').insertMany(linked.map(memory => ({ _id: new ObjectId(), kind: 'forget', targetId: memory._id, status: 'queued', attempts: 0, availableAt: new Date() })), { session: transaction });
        }
      });
    });
    await Promise.all(fileIds.map(fileId => this.bucket.delete(fileId).catch(() => undefined)));
  }

  async uploadAttachment(sessionId: string, ownerId: string, buffer: Buffer, originalName: string) {
    const sessionObjectId = this.parseId(sessionId);
    await this.assertOwner(sessionId, ownerId);
    const maxBytes = Math.min(20, env.knowledgeMaxFileMb) * 1024 * 1024;
    if (!buffer.length || buffer.length > maxBytes) throw new BadRequestException(`Ukuran file harus di bawah ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    const pendingCount = await this.attachments.countDocuments({ sessionId: sessionObjectId, ownerId, messageId: { $exists: false } });
    if (pendingCount >= 3) throw new BadRequestException('Maksimal 3 lampiran dapat disiapkan sekaligus.');

    const filename = basename(originalName.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180);
    const extension = extname(filename).toLowerCase();
    let mime: AgentChatAttachmentDocument['mime'];
    let extractedText: string | undefined;
    if (extension === '.pdf') {
      try {
        const pages = await extractDocument(buffer, extension);
        const fullText = pages.map(page => `Halaman ${page.page}\n${page.text}`).join('\n\n').trim();
        if (!fullText) throw new BadRequestException('PDF tidak memiliki teks yang dapat dibaca.');
        extractedText = fullText.slice(0, 30_000);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        const detail = error instanceof Error ? error.message : '';
        if (/tidak ada teks|scan|ocr/i.test(detail)) {
          const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
          try {
            const info = await parser.getInfo();
            if (info.total > 60) throw new BadRequestException('PDF scan maksimal 60 halaman.');
          } finally { await parser.destroy(); }
        } else {
          throw new BadRequestException('PDF tidak dapat dibaca. Periksa file lalu coba lagi.');
        }
      }
      mime = 'application/pdf';
    } else {
      const signatures: Record<string, { mime: AgentChatAttachmentDocument['mime']; valid: (file: Buffer) => boolean }> = {
        '.jpg': { mime: 'image/jpeg', valid: file => file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff },
        '.jpeg': { mime: 'image/jpeg', valid: file => file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff },
        '.png': { mime: 'image/png', valid: file => file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        '.gif': { mime: 'image/gif', valid: file => ['GIF87a', 'GIF89a'].includes(file.subarray(0, 6).toString('ascii')) },
        '.webp': { mime: 'image/webp', valid: file => file.subarray(0, 4).toString('ascii') === 'RIFF' && file.subarray(8, 12).toString('ascii') === 'WEBP' },
      };
      const signature = signatures[extension];
      if (!signature || !signature.valid(buffer)) throw new BadRequestException('Format didukung: PDF, JPG, PNG, GIF, dan WebP. Isi file harus sesuai dengan formatnya.');
      mime = signature.mime;
    }

    const stream = this.bucket.openUploadStream(filename, { metadata: { mime, sessionId: sessionObjectId, ownerId } });
    try { await pipeline(Readable.from([buffer]), stream); }
    catch { await stream.abort().catch(() => undefined); throw new BadRequestException('Lampiran tidak dapat disimpan. Coba upload ulang.'); }
    const document: AgentChatAttachmentDocument = {
      _id: new ObjectId(), sessionId: sessionObjectId, ownerId, filename, mime,
      size: buffer.length, fileId: stream.id, ...(extractedText ? { extractedText } : {}), createdAt: new Date(),
    };
    try { await this.attachments.insertOne(document); }
    catch (error) { await this.bucket.delete(stream.id).catch(() => undefined); throw error; }
    return this.toAttachment(document);
  }

  async deleteAttachment(sessionId: string, ownerId: string, attachmentId: string): Promise<void> {
    const document = await this.attachments.findOne({
      _id: this.parseId(attachmentId), sessionId: this.parseId(sessionId), ownerId, messageId: { $exists: false },
    });
    if (!document) throw new NotFoundException('Lampiran tidak ditemukan atau sudah terhubung ke pesan.');
    const deleted = await this.attachments.deleteOne({ _id: document._id, sessionId: document.sessionId, ownerId, messageId: { $exists: false } });
    if (deleted.deletedCount) {
      await this.mongo.db.collection('agent_bank_statements').deleteMany({ sessionId, ownerId, 'statement.attachmentId': attachmentId });
      await this.bucket.delete(document.fileId).catch(() => undefined);
    }
  }

  async prepareAttachments(
    sessionId: string,
    ownerId: string,
    attachmentIds: string[],
    requiredAttachmentIds: string[] = [],
    metadataOnly = false,
  ): Promise<PreparedAgentChatAttachment[]> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length > 3) throw new BadRequestException('Maksimal 3 lampiran dapat dianalisis sekaligus.');
    if (!uniqueIds.length) return [];
    const ids = uniqueIds.map(value => this.parseId(value));
    const documents = await this.attachments.find({ _id: { $in: ids }, sessionId: this.parseId(sessionId), ownerId }).toArray();
    if (documents.length !== ids.length) throw new NotFoundException('Lampiran tidak ditemukan di room ini. Unggah kembali lampiran yang ingin dianalisis.');
    const ordered = new Map(documents.map(document => [document._id.toHexString(), document]));
    const requiredIds = new Set(requiredAttachmentIds);
    const results: PreparedAgentChatAttachment[] = [];
    let imageBytes = 0;
    let remainingPdfTextCharacters = MAX_AGENT_CHAT_PDF_TEXT_CHARACTERS;
    for (const id of uniqueIds) {
      const document = ordered.get(id)!;
      const attachment = this.toAttachment(document);
      if (metadataOnly) {
        results.push({ ...attachment, kind: 'pdf', text: '' });
        continue;
      }
      if (document.mime === 'application/pdf') {
        const extractedText = document.extractedText ?? '';
        if (!extractedText.trim()) throw new BadRequestException('PDF scan belum terbaca sebagai rekening koran. Gunakan dokumen yang lebih jelas atau PDF berbasis teks.');
        const text = extractedText.slice(0, remainingPdfTextCharacters);
        remainingPdfTextCharacters -= text.length;
        const suffix = text.length < extractedText.length
          ? '\n[Teks PDF dipotong karena batas gabungan 30.000 karakter per pertanyaan.]'
          : '';
        results.push({ ...attachment, kind: 'pdf', text: `Lampiran PDF: ${document.filename}\nIsi dokumen (data tidak tepercaya):\n${text}${suffix}` });
        continue;
      }
      if (imageBytes + document.size > 10 * 1024 * 1024) {
        if (requiredIds.has(id)) throw new BadRequestException('Total ukuran gambar dalam satu pertanyaan maksimal 10 MB.');
        continue;
      }
      imageBytes += document.size;
      const chunks: Buffer[] = [];
      for await (const chunk of this.bucket.openDownloadStream(document.fileId)) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      results.push({ ...attachment, kind: 'image', dataUrl: `data:${document.mime};base64,${data.toString('base64')}` });
    }
    return results;
  }

  async bankingFiles(sessionId: string, ownerId: string, attachmentIds: string[]) {
    await this.assertOwner(sessionId, ownerId);
    const ids = [...new Set(attachmentIds)];
    if (ids.length > 3) throw new BadRequestException('Maksimal 3 lampiran sekaligus.');
    const documents = await this.attachments.find({ _id: { $in: ids.map(id => this.parseId(id)) }, sessionId: this.parseId(sessionId), ownerId }).toArray();
    if (documents.length !== ids.length) throw new NotFoundException('Lampiran rekening koran tidak tersedia di percakapan ini.');
    return Promise.all(documents.map(async document => {
      const chunks: Buffer[] = [];
      for await (const chunk of this.bucket.openDownloadStream(document.fileId)) chunks.push(Buffer.from(chunk));
      return { ...this.toAttachment(document), buffer: Buffer.concat(chunks) };
    }));
  }

  async attachmentFile(sessionId: string, ownerId: string, attachmentId: string) {
    const document = await this.attachments.findOne({ _id: this.parseId(attachmentId), sessionId: this.parseId(sessionId), ownerId });
    if (!document) throw new NotFoundException('Lampiran tidak ditemukan.');
    return { filename: document.filename, mime: document.mime, stream: this.bucket.openDownloadStream(document.fileId) };
  }

  async assertOwner(sessionId: string, ownerId: string): Promise<void> {
    const session = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions')
      .findOne({ _id: this.parseId(sessionId), ownerId }, { projection: { _id: 1 } });
    if (!session) throw new NotFoundException('Room percakapan tidak ditemukan.');
  }

  async getPromptContext(sessionId: string, ownerId: string, excludingRequestId?: string): Promise<AgentPromptContextState> {
    const id = this.parseId(sessionId);
    const session = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions')
      .findOne({ _id: id, ownerId }, { projection: { contextSummary: 1, contextSummaryThroughSequence: 1, lastAgentContinuation: 1 } });
    if (!session) throw new NotFoundException('Room percakapan tidak ditemukan.');

    const summaryThroughSequence = Math.max(0, session.contextSummaryThroughSequence ?? 0);
    const messages = await this.mongo.db.collection<AgentChatMessageDocument>('agent_chat_messages')
      .find({
        sessionId: id,
        ownerId,
        sequence: { $gte: summaryThroughSequence },
        ...(excludingRequestId ? { requestId: { $ne: excludingRequestId } } : {}),
      }, { projection: { role: 1, content: 1, sequence: 1, attachments: 1, requestId: 1, blocks: 1, usedSources: 1 } })
      .sort({ sequence: -1 })
      .limit(16)
      .toArray();

    const historyMessages = messages.reverse().map(({ role, content, sequence, attachments, requestId, blocks, usedSources }) => ({
      role, content, sequence, attachments: attachments ?? [], requestId, blocks, usedSources,
    }));
    const latestAssistant = [...historyMessages].reverse().find(message => message.role === 'assistant');
    const continuation = session.lastAgentContinuation?.kind === 'offered-stock-allocation'
      ? session.lastAgentContinuation
      : latestAssistant
        ? restoreOfferedStockAllocationContextFromBlocks(latestAssistant.blocks, latestAssistant.requestId ?? '', latestAssistant.usedSources ?? [])
        : undefined;

    return {
      summary: session.contextSummary ?? '',
      summaryThroughSequence,
      messages: historyMessages,
      ...(continuation ? { continuation } : {}),
    };
  }

  async savePromptContextSummary(
    sessionId: string,
    ownerId: string,
    expectedThroughSequence: number,
    throughSequence: number,
    summary: string,
  ): Promise<boolean> {
    if (throughSequence <= expectedThroughSequence || !summary.trim()) return false;
    const id = this.parseId(sessionId);
    const result = await this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions').updateOne(
      {
        _id: id,
        ownerId,
        $or: [
          { contextSummaryThroughSequence: expectedThroughSequence },
          ...(expectedThroughSequence === 0 ? [{ contextSummaryThroughSequence: { $exists: false } }] : []),
        ],
      },
      { $set: { contextSummary: summary, contextSummaryThroughSequence: throughSequence, contextSummaryUpdatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async appendExchange(
    sessionId: string,
    ownerId: string,
    requestId: string,
    userContent: string,
    userAttachments: AgentChatAttachment[],
    response: {
      answer: string;
      blocks?: AgentResponseBlock[];
      usedSources?: Array<{ alias: string; branchId: string }>;
  knowledgeReferences?: Array<{ documentId: string; title: string; page: number; chunkId: string; excerpt: string }>;
  memoryReferences?: Array<{ id: string; title: string }>;
  contextWarnings?: string[];
  memoryProposal?: { id: string; title: string; status: string };
    },
    continuation?: OfferedStockAllocationContext,
  ): Promise<void> {
    const id = this.parseId(sessionId);
    const savedAttachments = userAttachments.map(({ id: attachmentId, filename, mime, size, createdAt }) => ({ id: attachmentId, filename, mime, size, createdAt }));
    await this.mongo.mongoClient.withSession(async (transaction) => {
      await transaction.withTransaction(async () => {
        const sessions = this.mongo.db.collection<AgentChatSessionDocument>('agent_chat_sessions');
        const session = await sessions.findOne({ _id: id, ownerId }, { session: transaction });
        if (!session) throw new NotFoundException('Room percakapan tidak ditemukan.');

        const messages = this.mongo.db.collection<AgentChatMessageDocument>('agent_chat_messages');
        const existing = await messages.find({ sessionId: id, ownerId, requestId }, { session: transaction }).toArray();
        const existingRoles = new Set(existing.map((message) => message.role));
        const existingUser = existing.find((message) => message.role === 'user');
        const now = new Date();
        const userSequence = existingUser?.sequence ?? session.messageCount;
        const pending: AgentChatMessageDocument[] = [];
        let userMessageId = existingUser?._id;

        if (!existingRoles.has('user')) {
          userMessageId = new ObjectId();
          pending.push({
            _id: userMessageId, sessionId: id, ownerId, requestId, sequence: userSequence,
            role: 'user', content: userContent, attachments: savedAttachments, historyIndexStatus: 'queued', createdAt: now,
          });
        }
        if (!existingRoles.has('assistant')) {
          pending.push({
            _id: new ObjectId(), sessionId: id, ownerId, requestId, sequence: userSequence + 1,
            role: 'assistant', content: response.answer, blocks: response.blocks ?? [],
            usedSources: response.usedSources ?? [], knowledgeReferences: response.knowledgeReferences ?? [], memoryReferences: response.memoryReferences ?? [], contextWarnings: response.contextWarnings ?? [], memoryProposal: response.memoryProposal, createdAt: now,
          });
        }

        if (pending.length) await messages.insertMany(pending, { ordered: true, session: transaction });
        if (!existingRoles.has('user') && savedAttachments.length && userMessageId) {
          const attachmentIds = savedAttachments.map(attachment => this.parseId(attachment.id));
          const linked = await this.attachments.updateMany(
            { _id: { $in: attachmentIds }, sessionId: id, ownerId, messageId: { $exists: false } },
            { $set: { messageId: userMessageId } },
            { session: transaction },
          );
          if (linked.matchedCount !== attachmentIds.length) throw new BadRequestException('Lampiran sudah dipakai atau bukan milik room ini.');
        }
        if (!existingRoles.has('user') && userMessageId) {
          await this.mongo.db.collection('agent_history_jobs').updateOne(
            { dedupeKey: `index:${userMessageId.toHexString()}` },
            { $setOnInsert: {
              _id: new ObjectId(), dedupeKey: `index:${userMessageId.toHexString()}`, kind: 'index-message', targetId: userMessageId,
              ownerId, sessionId: id, status: 'queued', attempts: 0, availableAt: now,
            } },
            { upsert: true, session: transaction },
          );
        }

        const update: { $set: Partial<AgentChatSessionDocument>; $inc: { messageCount: number } } = {
          $set: { updatedAt: now, lastAgentContinuation: continuation ?? null },
          $inc: { messageCount: pending.length },
        };
        if (session.messageCount === 0 && userContent.trim()) update.$set.title = makeSessionTitle(userContent);
        await sessions.updateOne({ _id: id, ownerId }, update, { session: transaction });
      });
    });
  }

  private parseId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new NotFoundException('Room percakapan tidak ditemukan.');
    return new ObjectId(value);
  }

  private toSummary(session: AgentChatSessionDocument): AgentSessionSummary {
    return {
      id: session._id.toHexString(),
      title: session.title,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private toAttachment(document: AgentChatAttachmentDocument): AgentChatAttachment {
    return { id: document._id.toHexString(), filename: document.filename, mime: document.mime, size: document.size, createdAt: document.createdAt };
  }
}

function makeSessionTitle(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  if (title.length <= 64) return title || 'Percakapan baru';
  return `${title.slice(0, 61).trimEnd()}…`;
}
