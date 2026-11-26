// Offline integration fixtures: never connect to MongoDB or an AI provider.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'price_audit_fixture';
process.env.JWT_ACCESS_SECRET = 'offline-price-audit-fixture-secret-32-characters';
process.env.ENC_KEY_DEC = 'price-fixture-key';
process.env.DEEPSEEK_API_KEY = 'offline-fixture-not-a-real-key';
const assert = require('node:assert/strict');
const { PriceAuditService, priceAuditTransaction, priceAuditDetails, fillMissingSaleKadar } = require('../dist/src/agent/price-audit.service');
const { encryptBankField } = require('../dist/src/agent/banking.logic');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');

const rule = { family: 'old', kind: 'sales', kadar: 75, sourceCode: 'A1', rate: 1542000, maxRate: null, fee: 5000, feeType: 'nominal', condition: 'ANY', note: '' };
const references = [
  { id: 'one', filename: 'pagi.png', date: '2026-11-20', complete: true, warnings: [], rows: [rule] },
  { id: 'two', filename: 'siang.png', date: '2026-11-20', complete: true, warnings: [], rows: [{ ...rule, rate: 1562000 }] },
];
const dto = { windows: [{ date: '2026-11-20', fromTime: '09:00', toTime: '11:00', attachmentIds: ['one'] }, { date: '2026-11-20', fromTime: '11:00', toTime: '24:00', attachmentIds: ['two'] }] };
const sale = (id, jam, rate) => ({ _id: id, tgl_system: '2026-11-20', jam: encryptBankField(jam), nama_barang: encryptBankField('Cincin'), no_faktur_jual: id, barang: { kadar: 75 }, berat: 2, harga_jual: rate * 2, harga_gram: rate, ongkos: 10000, qty: 1 });
const records = [sale('early', '10:59:59', 1542000), sale('boundary', '11:00:00', 1562000), sale('last', '23:59:59', 1562000), sale('outside', '08:59:59', 1542000)];
const sources = [{ databaseName: 'pusat', alias: 'Italy Pusat', branchId: 'ITY', sourceType: 'central' }, { databaseName: 'otista', alias: 'Italy Otista', branchId: 'IT2', sourceType: 'branch' }];
let failSales = false;
const collectionsRead = new Set();
const mongo = {
  getDatabase(database) {
    return {
      listCollections() { return { async hasNext() { return true; } }; },
      collection(collection) {
        collectionsRead.add(collection); return {
          find(query, options) {
            assert.equal(options.projection['barang.kadar'], 1);
            assert.equal(options.projection['detail_barang.barang.kadar'], 1);
            assert.equal(options.projection.harga_gram, 1); assert.equal(options.projection['detail_barang.harga_gram'], 1);
            if (database === 'otista' && collection === 'tt_jual_detail' && failSales) throw new Error('fixture offline');
            return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() { }, async *[Symbol.asyncIterator]() { for (const record of collection === 'tt_jual_detail' ? records : []) yield record; } };
          }
        };
      },
    };
  }
};
const referenceReader = { async read(session, owner, ids) { assert.equal(owner, 'owner'); assert.equal(session, 'session'); return structuredClone(references.filter(ref => ids.includes(ref.id))); } };

(async () => {
  const normalized = priceAuditTransaction(records[1], 'sales', 'Italy');
  assert.equal(normalized.time, '11:00:00'); assert.equal(normalized.kadar, 75);
  const separateFees = priceAuditTransaction({ ...records[0], berat: 2, harga_jual: 4566000, ongkos: 2500, harga_total: 4568500, harga_gram: 2283000 }, 'sales', 'Italy');
  assert.equal(separateFees.pricePerGram, 2283000, 'uses stored harga_gram without adding fees');
  assert.equal(separateFees.price + separateFees.fee, 4568500, 'combined amount is not rounded again');
  assert.equal(priceAuditTransaction({ ...records[0], harga_gram: undefined }, 'sales', 'Italy').pricePerGram, null, 'never falls back to harga_jual divided by weight');
  for (const kind of ['sales', 'buyback']) {
    assert.equal(priceAuditTransaction({ barang: { kadar: 79 }, kadar: 82, berat: 2.98 }, kind, 'Italy').kadar, 79);
    assert.equal(priceAuditTransaction({ barang: { kadar: 82 }, berat: 0.69 }, kind, 'Italy').weight, 0.69);
    assert.equal(priceAuditTransaction({ kadar: 82 }, kind, 'Italy').kadar, kind === 'buyback' ? 82 : null, 'sales without a snapshot must use the authorized barcode fallback');
    assert.equal(priceAuditTransaction({ barang: [{ kadar: 79 }, { kadar: 82 }] }, kind, 'Italy').kadar, null, 'mixed item grades are never collapsed to the first grade');
    const grouped = priceAuditDetails({ _id: 'group', tgl_system: '2026-11-20', barang: { kadar: 99 }, berat: 20, detail_barang: [{ barang: { kadar: 79 }, berat: 2.98, harga_jual: 4839520 }, { barang: { kadar: 82 }, berat: 0.69, harga_jual: 1163340 }, { barang: { kadar: 79 }, status_valid: 'CANC' }] }, kind);
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped.map(row => priceAuditTransaction(row, kind, 'Italy').kadar), [79, 82]);
    assert.deepEqual(grouped.map(row => priceAuditTransaction(row, kind, 'Italy').weight), [2.98, 0.69]);
    const rates = priceAuditDetails({ _id:'rates', harga_gram:9999999, harga_rata:9999999, detail_barang:[{harga_gram:1850000,harga_rata:1850000},{berat:2}] }, kind);
    assert.deepEqual(rates.map(row=>priceAuditTransaction(row,kind,'Italy').pricePerGram),[1850000,null],'each array detail uses its own rate; parent price is never inherited');
  }
  let masterQueries = 0;
  const masterDb = masterRows => ({ collection(name) {
    assert.equal(name,'tm_barang');
    return { find(query,options) {
      masterQueries++; assert.equal(options.projection.kadar,1); assert.equal(options.projection.kode_barcode,1);
      assert.deepEqual(query.kode_barcode.$in,['0011249980'],'stored barcode identity and leading zeroes are preserved');
      return { maxTimeMS(ms){assert.equal(ms,5000);return this;},limit(){return this;},async toArray(){return masterRows;} };
    } };
  } });
  const rawFallback = { ...records[0], kode_barcode:'0011249980', barang:undefined, kadar:12, harga_gram:1850000 };
  const prepared = [rawFallback,{...rawFallback,_id:'another-invoice'}].map(record=>({record,tx:priceAuditTransaction(record,'sales','Italy')}));
  const masterCache = new Map();
  await fillMissingSaleKadar(prepared,masterDb([{kode_barcode:'0011249980',kadar:90}]),masterCache);
  assert.equal(masterQueries,1,'missing grades are batched, not queried once per invoice');
  assert.ok(prepared.every(({tx})=>tx.kadar===90&&tx.kadarSource==='Master barang (barcode)'&&tx.pricePerGram===1850000));
  assert.equal(rawFallback.barang,undefined,'lookup never changes the transaction snapshot');
  await fillMissingSaleKadar([{record:rawFallback,tx:priceAuditTransaction(rawFallback,'sales','Italy')}],masterDb([]),masterCache);
  assert.equal(masterQueries,1,'repeated barcodes use the per-source cache');
  const intact = { ...rawFallback,barang:{kadar:79} };
  const intactItem = {record:intact,tx:priceAuditTransaction(intact,'sales','Italy')};
  await fillMissingSaleKadar([intactItem],masterDb([]),new Map()); assert.equal(intactItem.tx.kadar,79); assert.equal(masterQueries,1,'snapshot grade prevents any master lookup');
  const differentStore = {record:rawFallback,tx:priceAuditTransaction(rawFallback,'sales','Other store')};
  await fillMissingSaleKadar([differentStore],masterDb([{kode_barcode:'0011249980',kadar:88}]),new Map());
  assert.equal(differentStore.tx.kadar,88,'the other store uses its own master and cache');
  const duplicateBarcode = {record:rawFallback,tx:priceAuditTransaction(rawFallback,'sales','Italy')};
  await fillMissingSaleKadar([duplicateBarcode],masterDb([{kode_barcode:'0011249980',kadar:79},{kode_barcode:'0011249980',kadar:82}]),new Map());
  assert.equal(duplicateBarcode.tx.kadar,null); assert.match(duplicateBarcode.tx.kadarNote,/beberapa barang/);
  const noBarcode = {record:{barang:null},tx:priceAuditTransaction({barang:null},'sales','Italy')};
  const beforeNoBarcode=masterQueries;await fillMissingSaleKadar([noBarcode],masterDb([]),new Map());
  assert.equal(masterQueries,beforeNoBarcode);assert.match(noBarcode.tx.kadarNote,/barcode tidak tercatat/);
  const ambiguousRaw={...rawFallback,barang:[{kadar:79},{kadar:82}]};
  const ambiguousItem={record:ambiguousRaw,tx:priceAuditTransaction(ambiguousRaw,'sales','Italy')};
  await fillMissingSaleKadar([ambiguousItem],masterDb([]),new Map());assert.equal(masterQueries,beforeNoBarcode);assert.equal(ambiguousItem.tx.kadar,null);
  const service = new PriceAuditService(mongo, referenceReader);
  const result = await service.report(dto, sources, 'owner', 'session');
  const table = result.blocks.find(block => block.type === 'table' && block.title === 'Audit harga penjualan perhiasan');
  assert.equal(table.rows.length, 6, 'every in-window record from both stores is included exactly once');
  const status = table.columns.indexOf('Status Pemeriksaan');
  assert.ok(table.rows.every(row => row[status] === 'Cocok'));
  assert.equal(new Set(table.rows.map(row => row[2])).size, 2);
  assert.deepEqual([...collectionsRead].sort(), ['tt_jual_detail'], 'sales-only audit never reads purchase transactions or tm_barang');
  assert.ok(!result.blocks.some(block => block.type === 'table' && /buyback/i.test(block.title)));
  const fallbackInvoice = { ...records[0], no_faktur_jual:'J90', kode_barcode:'0011249980', barang:undefined, harga_gram:1850000, berat:1.71, ongkos:40000 };
  const fallbackMongo = { getDatabase(name) {
    assert.equal(name,'pusat');
    return { listCollections(){return{async hasNext(){return true;}};},collection(collection){
      if(collection==='tm_barang') return masterDb([{kode_barcode:'0011249980',kadar:90}]).collection(collection);
      assert.equal(collection,'tt_jual_detail');
      return {find(){return{maxTimeMS(){return this;},batchSize(){return this;},async close(){},async *[Symbol.asyncIterator](){yield fallbackInvoice;}};}};
    }};
  }};
  const fallbackReferences = { async read(){return [{...references[0],rows:[{...rule,kadar:90,rate:1850000,fee:20000}]}];} };
  const fallbackReport = await new PriceAuditService(fallbackMongo,fallbackReferences).report({windows:[dto.windows[0]]},[sources[0]],'owner','session');
  const fallbackTable = fallbackReport.blocks.find(block=>block.type==='table'&&block.title==='Audit harga penjualan perhiasan');
  const fallbackRow = fallbackTable.rows[0];
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Harga Transaksi per gram (IDR)')],1850000);
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Kadar Barang')],90);
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Sumber Kadar')],'Master barang (barcode)');
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Berat (gram)')],1.71);
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Berat Acuan Ongkos (gram)')],2);
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Ongkos Acuan (IDR)')],40000);
  assert.equal(fallbackRow[fallbackTable.columns.indexOf('Status Pemeriksaan')],'Cocok');
  failSales = true;
  const partial = await service.report(dto, sources, 'owner', 'session');
  assert.ok(partial.blocks.some(block => block.type === 'callout' && /gagal dibaca/.test(block.text)));
  await assert.rejects(() => service.report({ ...dto, windows: [{ ...dto.windows[0], date: '2026-11-21' }] }, sources, 'owner', 'session'), /berbeda/);
  const originalFetch = global.fetch;
  let inserted = null, cleaned = false;
  const uploadSessions = { async uploadPriceAttachment() { return { id: '000000000000000000000001', filename: 'fixture.png', mime: 'image/png' }; }, async deleteAttachment() { cleaned = true; } };
  const storage = { db: { collection() { return { async updateOne(_query, update) { inserted = update.$set; } }; } } };
  const audit = { async resolveActorEmail() { return 'fixture@example.test'; }, async begin() { return 'audit'; }, async finish() { } };
  const parser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache(storage), uploadSessions, audit);
  const modelPage = { isJewelryPrice: true, date: '2026-11-20', complete: true, warnings: [], rows: [{ family: 'old', kind: 'sales', kadar: 75, sourceCode: 'A1', rateThousands: 1542, maxRateThousands: null, feeText: '5', condition: 'ANY', note: '' }] };
  try {
    global.fetch = async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.messages[1].content[0].type, 'image_url');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelPage) } }] }), { status: 200 });
    };
    const parsed = await parser.upload('000000000000000000000002', 'owner', Buffer.from('fixture'), 'fixture.png');
    assert.equal(parsed.rows[0].rate, 1542000); assert.equal(parsed.rows[0].fee, 5000); assert.ok(inserted);
    let providerCalls = 0;
    const progressEvents = [];
    const retrySessions = { async priceFiles() { return [{ id: parsed.id, filename: parsed.filename, mime: 'image/png', buffer: Buffer.from('fixture') }]; } };
    const retryStorage = { db: { collection() { return { find() { return { async toArray() { return []; } }; }, async updateOne() { } }; } } };
    const retryParser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache(retryStorage), retrySessions, audit);
    global.fetch = async () => {
      if (++providerCalls === 1) throw new Error('fixture temporary timeout');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelPage) } }] }), { status: 200 });
    };
    await retryParser.scope({ sessionId: '000000000000000000000002', prompt: 'cek', attachmentIds: [parsed.id] }, 'owner', async event => { progressEvents.push(event.message); });
    assert.equal(providerCalls, 2); assert.ok(progressEvents.some(text => /ulang otomatis/.test(text))); assert.ok(progressEvents.some(text => /Menyimpan/.test(text)));
    const grouped = {
      ...modelPage, rows: [
        { ...modelPage.rows[0], sourceCode: 'C8', kadar: 65, rateThousands: 1336 },
        { ...modelPage.rows[0], sourceCode: 'C8', kadar: 81, rateThousands: 1665 },
        { ...modelPage.rows[0], sourceCode: 'C7', kadar: 67, rateThousands: 1377 },
        { ...modelPage.rows[0], sourceCode: 'C7', kadar: 80, rateThousands: 1644 },
        { ...modelPage.rows[0], sourceCode: 'L1', kadar: 101, rateThousands: 2076, feeText: '-7%' },
        { ...modelPage.rows[0], sourceCode: 'L1', kadar: 110, rateThousands: 2261, feeText: '-20%' },
        { ...modelPage.rows[0], sourceCode: 'C6', kadar: 90, rateThousands: 1850, feeText: '25' },
        { ...modelPage.rows[0], sourceCode: 'N1', rateThousands: null },
      ]
    };
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(grouped) } }] }), { status: 200 });
    const expanded = await parser.upload('000000000000000000000002', 'owner', Buffer.from('grouped fixture'), 'fixture.png');
    assert.deepEqual(expanded.rows.map(row => row.kadar), [65, 81, 67, 80, 101, 110, 90]);
    assert.equal(expanded.rows[6].rate, 1850000, '1850 on the image means Rp1,850,000 per gram');
    assert.equal(expanded.rows[6].fee, 25000);
    assert.ok(!expanded.warnings.some(text => /Lebih dari satu tarif/.test(text)), 'repeated sales codes at different grades are not conflicts');
    assert.match(expanded.warnings.join(' '), /sel harga kosong/);
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...modelPage, rows: [{ ...modelPage.rows[0], kind: 'buyback' }] }) } }] }), { status: 200 });
    const held = await retryParser.scope({ sessionId: '000000000000000000000002', prompt: 'cek', attachmentIds: [parsed.id] }, 'owner');
    assert.equal(held.handled, true, 'buyback references are now supported');

    const files = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1).padStart(24, '0'), filename: `ref-${i}.png`, mime: 'image/png', buffer: Buffer.from('fixture') }));
    const cached = files.map(file => ({ ...parsed, id: file.id, filename: file.filename, parserVersion: PRICE_REFERENCE_PARSER_VERSION }));
    let ownerChecked = false;
    const chatSessions = { async priceFiles(_session, owner) { if (owner !== 'owner') throw new Error('wrong owner'); ownerChecked = true; return files; }, async deleteAttachment() { throw new Error('must not delete chat attachments'); } };
    const cacheStore = { db: { collection() { return { find(query) { assert.equal(query.ownerId, 'owner'); return { async toArray() { return cached; } }; } }; } } };
    const scopeParser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache(cacheStore), chatSessions, audit);
    global.fetch = async () => { throw new Error('cached references must not call gateway'); };
    const scopeInput = { sessionId: '000000000000000000000002', prompt: 'tolong cek data ini dengan transaksi', attachmentIds: files.map(file => file.id) };
    const missingHours = await scopeParser.scope(scopeInput, 'owner');
    assert.equal(ownerChecked, true); assert.equal(missingHours.needsTime, false); assert.equal(missingHours.references.length, 4);
    const direct = await scopeParser.scope({ ...scopeInput, prompt: 'cek data ini jam 9-17' }, 'owner');
    assert.equal(direct.selection.windows[0].date, '2026-11-20'); assert.equal(direct.selection.windows[0].attachmentIds.length, 4);
    await assert.rejects(() => scopeParser.scope(scopeInput, 'other-owner'), /wrong owner/);

    global.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { status: 200 });
    await assert.rejects(() => parser.upload('000000000000000000000002', 'owner', Buffer.from('truncated fixture'), 'fixture.png'), error => error.getStatus() === 502);
    assert.equal(cleaned, true, 'failed extraction cleans up the staged attachment');
  } finally { global.fetch = originalFetch; }
  console.log('Price audit integration: both stores, encrypted time, exact boundary, end of day, partial source and date validation passed.');
  console.log('Price reference extraction: validated model payload, thousand-rupiah normalization, persistence and truncated-response cleanup passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
