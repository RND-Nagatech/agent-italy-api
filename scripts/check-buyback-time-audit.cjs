// Offline integration fixtures; no production database or model requests.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'buyback_time_fixture';
process.env.JWT_ACCESS_SECRET = 'offline-time-test-secret-at-least-32-characters';
process.env.ENC_KEY_DEC = 'price-fixture-key';
process.env.DEEPSEEK_API_KEY = 'offline-fixture-not-a-real-key';
const assert = require('node:assert/strict');
const { PriceAuditService } = require('../dist/src/agent/price-audit.service');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');
const { auditBuybackBatches } = require('../dist/src/agent/buyback-audit.logic');
const { priceAuditScope } = require('../dist/src/agent/price-audit-scope');
const { encryptBankField: enc } = require('../dist/src/agent/banking.logic');
const date = '2026-11-23';
const rule = rate => ({ family: 'young', kind: 'buyback', kadar: null, sourceCode: 'H04', sourceRow: 'H04', condition: 'GOOD', rate, maxRate: null, fee: null, feeType: 'unknown', note: '' });
const references = [1, 2].map(batch => ({ id: `b${batch}`, filename: `batch-${batch}.jpeg`, date, batch, effectiveFrom: batch === 1 ? '08:15' : '13:40', complete: true, warnings: [], rows: [rule(batch === 1 ? 790000 : 795000)] }));
const purchase = (id, time, price, extra = {}) => ({ _id: id, no_faktur_beli: id, tgl_system: date, jam: enc(time), nama_barang: enc('Cincin'), kode_barcode: 'young', kondisi: enc('CUCI 8K / 9K'), harga_rata: price, berat: 1.71, status_valid: 'DONE', ...extra });
const records = [purchase('early', '08:14:59', 790000), purchase('start', '08:15:00', 790000), purchase('before-next', '13:39:59', 790000), purchase('next-start', '13:40:00', 795000), purchase('wrong-price', '14:00:00', 790000), purchase('no-time', '', 795000), purchase('missing-master', '10:00:00', 790000, { kode_barcode: 'missing' }), purchase('cancelled', '14:00:00', 795000, { status_valid: 'CANC' })];
const sources = [{ databaseName: 'pusat', alias: 'Italy Pusat', branchId: 'ITY' }, { databaseName: 'otista', alias: 'Italy Otista', branchId: 'IT2' }];
let lookups = 0;
const mongo = { getDatabase() { return {
  listCollections() { return { async hasNext() { return true; } }; },
  collection(name) {
    if (name === 'tm_barang') return { find() { lookups++; return { maxTimeMS() { return this; }, limit() { return this; }, async toArray() { return [{ kode_barcode: 'young', kode_intern: enc('H04 8') }]; } }; } };
    assert.equal(name, 'tt_beli_detail');
    return { find(query) { assert.equal(query.status_valid.$ne, 'CANC'); return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* records; } }; } };
  },
}; } };

(async () => {
  const scope = priceAuditScope('tolong periksa buyback dari file ini', references);
  assert.equal(scope.needsTime, false);
  const report = await new PriceAuditService(mongo, { async read() { return structuredClone(references); } }).report(scope.selection, sources, 'owner', 'session');
  const table = report.blocks.find(block => block.type === 'table' && block.title === 'Audit harga buyback perhiasan');
  const cell = (row, column) => row[table.columns.indexOf(column)];
  assert.equal(table.rows.length, 14); assert.equal(lookups, 2);
  for (const source of sources) {
    const byInvoice = name => table.rows.find(row => cell(row, 'Toko') === source.alias && cell(row, 'No. Faktur') === name);
    assert.equal(cell(byInvoice('early'), 'Batch Acuan'), 'Belum dapat ditentukan');
    assert.match(cell(byInvoice('early'), 'Keterangan Pemeriksaan'), /sebelum.*08:15/);
    for (const name of ['start', 'before-next']) { assert.equal(cell(byInvoice(name), 'Batch Acuan'), 'Batch 1'); assert.equal(cell(byInvoice(name), 'Berlaku WIB'), '08:15–sebelum 13:40'); }
    assert.equal(cell(byInvoice('next-start'), 'Batch Acuan'), 'Batch 2');
    assert.equal(cell(byInvoice('wrong-price'), 'Batch Acuan'), 'Batch 2');
    assert.equal(cell(byInvoice('wrong-price'), 'Hasil Pemeriksaan'), 'Di luar range acuan');
    assert.equal(cell(byInvoice('wrong-price'), 'Dasar Penentuan Batch'), 'Jam transaksi');
    assert.equal(cell(byInvoice('wrong-price'), 'Range Batch 1 (IDR/gram)'), 'Rp790.000 (harga tunggal)');
    assert.equal(cell(byInvoice('no-time'), 'Batch Acuan'), 'Belum dapat ditentukan');
    assert.equal(cell(byInvoice('missing-master'), 'Batch Acuan'), 'Batch 1');
    assert.equal(cell(byInvoice('missing-master'), 'Hasil Pemeriksaan'), 'Perlu diperhatikan');
    assert.ok(!byInvoice('cancelled'));
  }
  const refTable = report.blocks.find(block => block.type === 'table' && block.title === 'Daftar acuan pemeriksaan harga');
  assert.deepEqual(refTable.rows.map(row => [row[refTable.columns.indexOf('Berlaku Mulai WIB')], row[refTable.columns.indexOf('Berlaku Sampai WIB')]]), [['08:15', 'Sebelum 13:40'], ['13:40', 'Akhir hari']]);
  const automatic = await new PriceAuditService(mongo, { async read() { return structuredClone(references); } }).report({ ...scope.selection, buybackAutoBatch: undefined }, sources.slice(0, 1), 'owner', 'session');
  const automaticTable = automatic.blocks.find(block => block.type === 'table' && block.title === 'Audit harga buyback perhiasan');
  const automaticRow = automaticTable.rows.find(row => row[automaticTable.columns.indexOf('No. Faktur')] === 'wrong-price');
  assert.equal(automaticRow[automaticTable.columns.indexOf('Batch Acuan')], 'Batch 2', 'printed effective hours activate time-based matching without a client-supplied mode flag');

  let saved;
  const originalFetch = global.fetch;
  const parserMongo = { db: { collection() { return { async updateOne(_query, update) { saved = update.$set; }, find(query) { assert.equal(query.parserVersion, PRICE_REFERENCE_PARSER_VERSION); return { async toArray() { return [saved]; } }; } }; } } };
  const parser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache(parserMongo), { async assertOwner() {}, async get() { assert.fail('reading references must not reload the full chat'); }, async uploadPriceAttachment() { return { id: '000000000000000000000001', filename: 'one-image-two-batches.png', mime: 'image/png' }; }, async deleteAttachment() {} }, { async resolveActorEmail() { return ''; }, async begin() { return 'fixture'; }, async finish() {} });
  const compact = goodThousands => ({ family: 'young', sourceCode: 'H04', sourceLabel: '', printedKadar: '', goodThousands, scrapThousands: null, stoneMinThousands: null, stoneMaxThousands: null });
  const documents = [1, 2].map(batch => ({ isJewelryPrice: true, date, batch, effectiveFrom: batch === 1 ? '07:00' : '12:00', complete: true, warnings: [], rows: [], buybackRows: [compact(batch === 1 ? 790 : 795)] }));
  try {
    global.fetch = async (_url, options) => {
      const system = JSON.parse(options.body).messages[0].content;
      assert.match(system, /effectiveFrom ONLY from the printed/); assert.match(system, /multiple independent tables/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ isJewelryPrice: true, rows: [], buybackRows: [], documents }) } }] }), { status: 200 });
    };
    const parsed = await parser.upload('000000000000000000000002', 'owner', Buffer.from('fixture'), 'one-image-two-batches.png');
    assert.equal(parsed.sections.length, 2); assert.equal(parsed.rows.length, 2); assert.equal(parsed.batch, null);
    assert.deepEqual(parsed.sections.map(section => [section.batch, section.effectiveFrom, section.rows[0].rate]), [[1, '07:00', 790000], [2, '12:00', 795000]]);
    assert.ok(!parsed.warnings.some(warning => /Lebih dari satu tarif|Nomor batch/.test(warning)), 'different batch prices in one image are valid');
    assert.equal(saved.parserVersion, PRICE_REFERENCE_PARSER_VERSION);
    const [cached] = await parser.read('000000000000000000000002', 'owner', ['000000000000000000000001']);
    assert.deepEqual(cached.sections, parsed.sections);
    const normalized = { id: 'fixture', kind: 'buyback', store: 'Italy', date, time: '11:59:59', invoice: 'B', name: 'Cincin', internalCode: 'H04', printedKadar: '', condition: 'CUCI 8K / 9K', pricePerGram: 790000, weight: 1, price: null, fee: null, quantity: 1, kadar: null, inputBy: 'Kasir' };
    assert.equal(auditBuybackBatches(normalized, [cached]).batch, 'Batch 1');
    assert.equal(auditBuybackBatches({ ...normalized, time: '12:00:00', pricePerGram: 795000 }, [cached]).batch, 'Batch 2');
    assert.equal(priceAuditScope('cek file ini', [cached]).selection.windows[0].attachmentIds.length, 1, 'one upload can hold two independent time periods');
    documents[0].effectiveFrom = '25:00';
    await assert.rejects(() => parser.upload('000000000000000000000002', 'owner', Buffer.from('invalid-time fixture'), 'invalid-time.png'), /belum terbaca lengkap\/valid/);
  } finally { global.fetch = originalFetch; }
  console.log('Buyback header-time integration passed: dynamic effective hours, encrypted transaction times, exclusive boundaries, wrong-price isolation, missing masters/times, cancellation filtering, combined-image sections and cached metadata.');
})().catch(error => { console.error(error); process.exitCode = 1; });
