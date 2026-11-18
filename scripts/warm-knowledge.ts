import { EmbeddingService } from '../src/knowledge/embedding.service';
async function main() {
  const service = new EmbeddingService();
  try { const [vector] = await service.embed(['penjualan dan stok perhiasan emas'], true); console.log(`Embedding lokal siap: ${vector.length} dimensi.`); }
  finally { await service.onModuleDestroy(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Embedding gagal.'); process.exitCode = 1; });
