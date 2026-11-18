import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
@Injectable()
export class KnowledgeVectorService {
  private initialized?: Promise<void>;
  private get base() { return `${env.qdrantUrl}/collections/${encodeURIComponent(env.qdrantCollection)}`; }
  private async call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(this.base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Qdrant tidak tersedia atau permintaan ditolak (${response.status}).`);
    return response.json() as Promise<{ result: any }>;
  }
  async ready() {
    if (!this.initialized) this.initialized = (async () => {
      const response = await fetch(this.base, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (response.status === 404) await this.call('', 'PUT', { vectors: { size: env.embeddingDimensions, distance: 'Cosine' } });
      else {
        if (!response.ok) throw new Error('Qdrant tidak tersedia.');
        const data = await response.json() as { result: { config: { params: { vectors: { size: number } } } } };
        if (data.result.config.params.vectors.size !== env.embeddingDimensions) throw new Error('Dimensi collection Qdrant berbeda; gunakan collection baru saat mengganti model.');
      }
      for (const field of ['documentId', 'generation', 'model']) await this.call('/index?wait=true', 'PUT', { field_name: field, field_schema: 'keyword' });
    })().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }
  async upsert(points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>) { await this.ready(); await this.call('/points?wait=true', 'PUT', { points }); }
  async remove(documentId: string) { await this.ready(); await this.call('/points/delete?wait=true', 'POST', { filter: { must: [{ key: 'documentId', match: { value: documentId } }] } }); }
  async search(vector: number[], documentIds: string[], model: string) {
    await this.ready();
    if (!documentIds.length) return [];
    const data = await this.call('/points/query', 'POST', { query: vector, limit: 16, score_threshold: 0.55, with_payload: true, filter: { must: [{ key: 'documentId', match: { any: documentIds } }, { key: 'model', match: { value: model } }] } });
    return (data.result?.points ?? []) as Array<{ id: string; score: number; payload: { documentId: string; generation: string; chunkId: string } }>;
  }
}
