import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { env } from '../config/env';
@Injectable()
export class EmbeddingService implements OnModuleDestroy {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  state = 'Belum dimuat';
  get fingerprint() { return `${env.embeddingModel}@${env.embeddingRevision}:${env.embeddingDimensions}`; }
  private start() {
    if (this.worker) return;
    this.state = 'Menyiapkan model embedding lokal';
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {pipeline,env}=require(workerData.module);
      env.cacheDir=workerData.cache;
      let model; let chain=Promise.resolve();
      parentPort.on('message',message=>{chain=chain.then(async()=>{
        try {
          model ||= pipeline('feature-extraction',workerData.model,{revision:workerData.revision,dtype:'q8',device:'cpu'});
          const extractor=await model;
          const result=await extractor(message.texts,{pooling:'mean',normalize:true,truncation:true});
          parentPort.postMessage({id:message.id,vectors:result.tolist()});
        } catch(error) {model=undefined;parentPort.postMessage({id:message.id,error:'Model embedding belum dapat dimuat/dijalankan. Periksa jaringan unduhan model dan konfigurasi.'});}
      });});
    `, { eval: true, workerData: { module: require.resolve('@huggingface/transformers'), cache: resolve(env.embeddingCacheDir), model: env.embeddingModel, revision: env.embeddingRevision }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    this.worker = worker;
    worker.on('message', (message: { id: number; vectors?: number[][]; error?: string }) => {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error || !message.vectors?.every(vector => vector.length === env.embeddingDimensions && vector.every(Number.isFinite))) {
        this.state = 'Embedding tidak tersedia'; request.reject(new Error(message.error || 'Dimensi model embedding tidak sesuai konfigurasi.'));
      } else { this.state = 'Siap'; request.resolve(message.vectors); }
    });
    const fail = () => { if (this.worker === worker) this.worker = undefined; this.state = 'Embedding terhenti'; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker embedding terhenti.')); } this.pending.clear(); };
    worker.on('error', fail); worker.on('exit', fail); worker.unref();
  }
  embed(texts: string[], query = false): Promise<number[][]> {
    if (!texts.length) return Promise.resolve([]);
    if (this.pending.size >= 16) return Promise.reject(new Error('Worker embedding sedang sibuk. Coba lagi setelah indexing selesai.'));
    this.start(); const id = ++this.sequence;
    const prefix = env.embeddingModel.toLowerCase().includes('e5') ? query ? 'query: ' : 'passage: ' : '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Embedding melewati batas waktu; periksa model lokal lalu proses ulang.')); void this.worker?.terminate(); }, 300_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, texts: texts.map(text => prefix + text.slice(0, 6000)) });
    });
  }
  async onModuleDestroy() { await this.worker?.terminate(); }
}
