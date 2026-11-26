// Offline integration fixtures. Never connect to production or a model provider.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'sales_code_fixture';
process.env.JWT_ACCESS_SECRET = 'offline-sales-code-test-secret-at-least-32-characters';
process.env.ENC_KEY_DEC = 'price-fixture-key';
process.env.DEEPSEEK_API_KEY = 'offline-fixture-not-a-real-key';
const assert = require('node:assert/strict');
const { PriceAuditService } = require('../dist/src/agent/price-audit.service');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');
const { priceAuditScope } = require('../dist/src/agent/price-audit-scope');
const { encryptBankField: enc } = require('../dist/src/agent/banking.logic');
const date = '2026-11-23';
const rule = (sourceCode, kadar, rate, fee = 20000) => ({ family: kadar <= 60 ? 'young' : 'old', kind: 'sales', sourceCode, kadar, rate, maxRate: null, fee, feeType: fee === null ? 'unknown' : 'nominal', condition: 'ANY', note: '' });
const ref = (id, batch, rows) => ({ id, batch, rows, filename: `${id}.jpeg`, date, complete: true, warnings: [] });
const refs = [ref('muda-1', 1, [rule('H04', 38, 798000, null)]), ref('muda-2', 2, [rule('H04', 38, 804000, null)]), ref('tua-1', 1, [rule('C5', 88, 1848000), rule('D7', 88, 1848000, 25000), rule('C8', 65, 1365000), rule('C8', 81, 1701000)])];
const sale = (id, barcode, kadar, rate, fee, extra = {}) => ({ _id: id, no_faktur_jual: id, tgl_system: date, jam: enc('09:00:00'), nama_barang: enc('Cincin'), kode_barcode: barcode, barang: { kadar }, berat: 1.71, harga_jual: 9999999, harga_gram: rate, ongkos: fee, qty: 1, status_valid: 'DONE', status_kembali: 'OPEN', status_tukar: false, trs_barang_tukar: false, kode_intern: enc('WRONG'), ...extra });
const records = [
  sale('c5', '0011256038', 88, 1848000, 40000), sale('d7', '11256039', 88, 1848000, 50000),
  sale('young-batch2', '11256040', 38, 804000, 0, { jam: enc('23:59:59') }),
  sale('missing-master', 'old-missing', 88, 1848000, 40000),
  sale('missing-grade', '11256039', null, 1848000, 50000, { barang: undefined, kadar: 12, jam: '' }),
  sale('wrong-grade', '11256041', 65, 1701000, 40000),
  sale('wrong-code-price', '0011256038', 88, 1701000, 40000),
  sale('cancelled', '0011256038', 88, 1848000, 40000, { status_valid: 'CANC' }),
];
const sources = [{ databaseName: 'pusat', alias: 'Italy Pusat', branchId: 'ITY' }, { databaseName: 'otista', alias: 'Italy Otista', branchId: 'IT2' }];
let lookups = 0;
const readCollections = new Set();
const mongo = { getDatabase(database) { return {
  listCollections() { return { async hasNext() { return true; } }; },
  collection(name) {
    readCollections.add(name);
    if (name === 'tm_barang') return { find(query, { projection }) {
      lookups++; assert.equal(projection.kode_intern, 1); assert.equal(projection.kadar, 1); assert.ok(query.kode_barcode.$in.includes('0011256038'));
      return { maxTimeMS() { return this; }, limit() { return this; }, async toArray() { return [
        { kode_barcode: '0011256038', kode_intern: enc(database === 'pusat' ? 'C5 16' : 'C5 17'), kadar: 99 },
        { kode_barcode: '11256039', kode_intern: enc('D7 16'), kadar: 88 },
        { kode_barcode: '11256040', kode_intern: enc('H04 8'), kadar: 38 },
        { kode_barcode: '11256041', kode_intern: enc('C8 16'), kadar: 81 },
      ]; } };
    } };
    assert.equal(name, 'tt_jual_detail', 'sales-only references never scan purchases');
    return { find(query, { projection }) {
      assert.equal(query.status_valid, 'DONE'); assert.equal(projection.harga_gram, 1);
      return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* records.filter(row => row.status_valid === 'DONE'); } };
    } };
  },
}; } };

(async () => {
  const scope = priceAuditScope('cek penjualan dengan file harga emas ini', refs);
  assert.equal(scope.needsTime, false); assert.equal(scope.selection.salesAutoBatch, true);
  assert.equal(scope.selection.salesMarketplaceOnly, true, 'new upload flows default to the requested marketplace audit');
  const report = await new PriceAuditService(mongo, { async read() { return structuredClone(refs); } }).report({ ...scope.selection, salesMarketplaceOnly: false }, sources, 'owner', 'session');
  assert.equal(lookups, 2, 'all master codes are batched once per store even with intact invoice grades');
  assert.deepEqual([...readCollections].sort(), ['tm_barang', 'tt_jual_detail']);
  const table = report.blocks.find(block => block.type === 'table' && block.title === 'Audit harga penjualan perhiasan');
  assert.equal(table.rows.length, 14);
  const cell = (row, column) => row[table.columns.indexOf(column)];
  for (const source of sources) {
    const rows = table.rows.filter(row => cell(row, 'Toko') === source.alias);
    const get = invoice => rows.find(row => cell(row, 'No. Faktur') === invoice);
    assert.equal(cell(get('c5'), 'Kode Intern'), source.databaseName === 'pusat' ? 'C5 16' : 'C5 17');
    assert.equal(cell(get('c5'), 'Kode Acuan'), 'C5'); assert.equal(cell(get('c5'), 'Batch Acuan'), 'Batch 1');
    assert.equal(cell(get('c5'), 'Kadar Barang'), 88, 'master grade never overwrites an existing invoice snapshot');
    assert.equal(cell(get('c5'), 'Ongkos Acuan (IDR)'), 40000); assert.equal(cell(get('c5'), 'Status Pemeriksaan'), 'Cocok');
    assert.equal(cell(get('d7'), 'Ongkos Acuan (IDR)'), 50000); assert.equal(cell(get('d7'), 'Status Pemeriksaan'), 'Cocok');
    assert.equal(cell(get('young-batch2'), 'Batch Acuan'), 'Batch 2'); assert.equal(cell(get('young-batch2'), 'Harga Transaksi per gram (IDR)'), 804000);
    assert.equal(cell(get('young-batch2'), 'Status Harga dan Kadar'), 'Cocok'); assert.equal(cell(get('young-batch2'), 'Status Ongkos'), 'Belum dapat diperiksa');
    assert.equal(cell(get('missing-master'), 'Kode Intern'), '-'); assert.equal(cell(get('missing-master'), 'Status Pemeriksaan'), 'Belum dapat diperiksa');
    assert.equal(cell(get('missing-master'), 'Harga Transaksi per gram (IDR)'), 1848000); assert.match(cell(get('missing-master'), 'Keterangan Pemeriksaan'), /tidak ditemukan/);
    assert.equal(cell(get('missing-grade'), 'Kadar Barang'), 88); assert.equal(cell(get('missing-grade'), 'Sumber Kadar'), 'Master barang (barcode)');
    assert.equal(cell(get('wrong-grade'), 'Status Harga dan Kadar'), 'Tidak cocok'); assert.equal(cell(get('wrong-grade'), 'Batch Acuan'), 'Batch 1');
    assert.equal(cell(get('wrong-code-price'), 'Batch Acuan'), 'Tidak teridentifikasi'); assert.equal(cell(get('wrong-code-price'), 'Status Pemeriksaan'), 'Tidak cocok');
    assert.ok(!get('cancelled'));
  }
  const referenceTable = report.blocks.find(block => block.type === 'table' && block.title === 'Daftar acuan pemeriksaan harga');
  assert.ok(referenceTable.columns.includes('Jenis Acuan')); assert.ok(!referenceTable.columns.some(column => /jam/i.test(column)));

  const originalFetch = global.fetch;
  let saved;
  const parser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache({ db: { collection() { return { async updateOne(_query, update) { saved = update.$set; } }; } } }), {
    async uploadPriceAttachment(_session, _owner, _buffer, filename) { return { id: '000000000000000000000001', filename, mime: 'image/jpeg' }; }, async deleteAttachment() {},
  }, { async resolveActorEmail() { return ''; }, async begin() { return 'fixture'; }, async finish() {} });
  try {
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.match(payload.messages[0].content, /MAIN DOCUMENT TITLE determines the type/);
      assert.match(payload.messages[0].content, /empty "Buyback 5% Kuning, 7% Putih" column/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ isJewelryPrice: true, date, batch: 2, complete: true, warnings: [], rows: [{ family: 'young', kind: 'sales', sourceCode: 'H04', kadar: 38, rateThousands: 804, maxRateThousands: null, feeText: '', condition: 'ANY', note: '' }] }) } }] }), { status: 200 });
    };
    const parsed = await parser.upload('000000000000000000000002', 'owner', Buffer.from('fixture'), 'Harga emas muda batch 2.jpeg');
    assert.equal(parsed.batch, 2); assert.equal(parsed.rows[0].sourceCode, 'H04'); assert.equal(parsed.rows[0].kind, 'sales');
    assert.equal(parsed.rows[0].rate, 804000); assert.equal(parsed.rows[0].fee, null); assert.equal(saved.parserVersion, PRICE_REFERENCE_PARSER_VERSION);
  } finally { global.fetch = originalFetch; }
  console.log('Sales code audit passed: encrypted master lookup, per-store caches, preserved grade snapshots, exact harga_gram and batches, code-specific fees, missing masters, cancelled records and document-title classification.');
})().catch(error => { console.error(error); process.exitCode = 1; });
