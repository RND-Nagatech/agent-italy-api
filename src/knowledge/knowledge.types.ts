import { ObjectId } from 'mongodb';
export interface KnowledgeDocument {
  _id: ObjectId; title: string; description: string; category: string;
  filename: string; extension: string; mime: string; size: number; hash: string; fileId: ObjectId;
  visibility: 'global' | 'branches'; branchIds: string[];
  active: boolean; deleted: boolean; status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string; chunkCount: number; pageCount: number; version: number; replacesId?: string;
  createdBy: string; createdAt: Date; updatedAt: Date; indexedModel?: string; generation?: string;
}
export interface KnowledgeChunk { _id: ObjectId; documentId: ObjectId; generation: string; index: number; page: number; text: string; vectorId: string }
export interface SharedMemory {
  _id: ObjectId; title: string; text: string; status: 'pending' | 'queued' | 'syncing' | 'ready' | 'failed' | 'deleted';
  createdBy: string; approvedBy?: string; createdAt: Date; updatedAt: Date; error?: string;
  sessionId?: string; requestId?: string; documentId: string;
  sourceKind?: 'conversation-extraction'; learningKey?: string; learnedHash?: string; evidence?: string; confidence?: number; category?: string; sourceEventId?: string; conflictWith?: string; approvalMode?: 'automatic' | 'review';
}
export interface KnowledgeJob {
  _id: ObjectId; kind: 'index' | 'purge' | 'retain' | 'forget'; targetId: ObjectId;
  status: 'queued' | 'processing' | 'done' | 'failed'; attempts: number; availableAt: Date; leaseUntil?: Date; lock?: string; error?: string;
}
export interface KnowledgeReference { documentId: string; title: string; page: number; locationLabel: string; chunkId: string; excerpt: string }
