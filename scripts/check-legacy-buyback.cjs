// Offline database/credential fixtures. No connection to a real RDS server.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'legacy_fixture';
process.env.JWT_ACCESS_SECRET = 'offline-legacy-fixture-secret-at-least-32-characters';
process.env.ENC_KEY_DEC = 'offline-fixture-key';
process.env.DEEPSEEK_API_KEY = 'offline-model-fixture';
const assert = require('node:assert/strict');
const { withPriceCache } = require('./price-cache-fixture.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { encryptLegacyAscii } = require('../dist/src/config/legacy-ascii');
const enc = value => encryptLegacyAscii(value, process.env.ENC_KEY_DEC);
for (const [key, value] of Object.entries({ RDS_URLDB_API: 'mariadb://archive.invalid:3307?ssl=true', RDS_DB_NAME: 'legacy_items', RDS_USERNAME: 'reader', RDS_PASSWORD: ' fixture:password ' })) process.env[key] = enc(value);
const { env } = require('../dist/src/config/env');
const { LegacyBarangService } = require('../dist/src/database/legacy-barang.service');
const { PriceAuditService, buybackAuditTransaction, fillBuybackMaster } = require('../dist/src/agent/price-audit.service');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');

const date = '2026-11-21';
const rule = (code, label, condition, rate, maxRate = null) => ({ family: 'old', kind: 'buyback', sourceCode: code, sourceLabel: label, sourceRow: code, condition, rate, maxRate, kadar: null, fee: null, feeType: 'unknown', note: '' });
const references = [{ id: 'one', filename: 'acuan.jpeg', date, batch: 1, complete: true, warnings: [], rows: [rule('C5', 'SHINE', 'GOOD', 1507000), rule('C5', 'SHINE', 'STONE', 1466000, 1497000), rule('C5', 'SHINE', 'SCRAP', 1425000), ...['D1', 'E1'].flatMap(code => [rule(code, 'Eternity', 'GOOD', 1518000), rule(code, 'Eternity', 'STONE', 1466000, 1497000)])] }];
let creates = 0, ends = 0, releases = 0, queries = [];
const fakePool = {
  on() { return this; }, async end() { ends++; },
  async getConnection() { return { query: this.query.bind(this), async release() { releases++; }, destroy() { assert.fail('successful queries must not destroy their connection'); } }; },
  async query(options, values) {
    queries.push({ sql: options.sql, values });
    assert.equal(options.timeout, undefined, 'MySQL rejects MariaDB server-side query timeout'); assert.match(options.sql, /^SELECT kode_barcode, kode_intern FROM tm_barang WHERE kode_barcode IN \(/);
    assert.doesNotMatch(options.sql, /INSERT|UPDATE|DELETE|SELECT \*/i);
    assert.equal((options.sql.match(/\?/g) || []).length, values.length);
    const barcodes = values.slice(0, -1);
    assert.ok(!options.sql.includes('OR 1=1'));
    return barcodes.flatMap(barcode => barcode === '000125' ? [{ kode_barcode: `${barcode} `, kode_intern: 'SHINE 50' }]
      : barcode === '000126' ? [{ kode_barcode: barcode, kode_intern: 'SHINE' }, { kode_barcode: `${barcode} `, kode_intern: 'SHINE' }]
      : barcode === '000123' ? [{ kode_barcode: barcode, kode_intern: 'SHINE' }]
      : barcode === '000124' ? [{ kode_barcode: barcode, kode_intern: 'Eternity' }]
        : barcode === 'duplicate' ? [{ kode_barcode: barcode, kode_intern: 'SHINE' }, { kode_barcode: barcode, kode_intern: 'Eternity' }]
          : barcode === 'encoded' ? [{ kode_barcode: barcode, kode_intern: enc('SHINE') }]
            : barcode === 'empty' ? [{ kode_barcode: barcode, kode_intern: '' }] : []);
  },
};
const legacy = new LegacyBarangService(options => {
  creates++; assert.equal(options.host, 'archive.invalid'); assert.equal(options.port, 3307); assert.equal(options.database, 'legacy_items');
  assert.equal(options.user, 'reader'); assert.equal(options.password, ' fixture:password '); assert.equal(options.ssl, true);
  assert.equal(options.minimumIdle, 0); assert.equal(options.multipleStatements, false); assert.equal(options.queryTimeout, undefined, 'pool initialization must work on MySQL');
  assert.equal(options.socketTimeout, 7000); assert.equal(options.acquireTimeout, 6000);
  return fakePool;
});

(async () => {
  assert.equal(creates, 0, 'pool is lazy');
  const matches = await legacy.lookupMany(['000123', '000123', '000124', 'duplicate', 'encoded', 'empty', 'missing', '1") OR 1=1 --']);
  assert.equal(matches.get('000123').internalCode, 'SHINE'); assert.equal(matches.get('encoded').internalCode, 'SHINE');
  assert.equal(matches.get('duplicate').status, 'ambiguous'); assert.equal(matches.get('empty').status, 'unreadable'); assert.equal(matches.get('missing').status, 'not-found');
  assert.ok(queries[0].values.includes('1") OR 1=1 --')); assert.equal(creates, 1);
  await legacy.lookupMany(['000123']); assert.equal(creates, 1, 'pool is reused'); assert.equal(releases, 2, 'completed queries release their connection');
  const paddedBarcodes = await legacy.lookupMany(['000125', '000126']);
  assert.equal(paddedBarcodes.get('000125').status, 'found'); assert.equal(paddedBarcodes.get('000125').internalCode, 'SHINE 50', 'trailing SQL barcode padding must not reject a matching row');
  assert.equal(paddedBarcodes.get('000126').status, 'ambiguous', 'duplicate padded SQL barcodes must not silently choose a row');
  queries = [];
  const purchase = (id, barcode, rate = 1490000, extra = {}) => ({ _id: id, no_faktur_beli: id, tgl_system: date, jam: enc('10:00:00'), nama_barang: enc('Cincin'), kondisi: enc('CUCI 16K / 17K'), kode_barcode: barcode, harga_rata: rate, harga: 9999999, berat: 1.71, status_valid: 'DONE', ...extra });
  const records = [purchase('modern', 'modern'), purchase('old-shine', '000123'), purchase('repeat-shine', '000123'), purchase('old-eternity', '000124'), purchase('missing', 'missing'), purchase('duplicate', 'duplicate'), purchase('mongo-duplicate', 'mongo-duplicate'), purchase('cancelled', 'cancel-only', 1490000, { status_valid: 'CANC' })];
  const sources = [{ databaseName: 'pusat', alias: 'Italy Pusat', branchId: 'ITY' }, { databaseName: 'otista', alias: 'Italy Otista', branchId: 'IT2' }];
  const mongo = { getDatabase() { return {
    listCollections() { return { async hasNext() { return true; } }; },
    collection(name) {
      if (name === 'tm_barang') return { find() { return { maxTimeMS() { return this; }, limit() { return this; }, async toArray() { return [{ kode_barcode: 'modern', kode_intern: enc('C5 16') }, { kode_barcode: 'mongo-duplicate', kode_intern: enc('C5 16') }, { kode_barcode: 'mongo-duplicate', kode_intern: enc('D1 16') }]; } }; } };
      assert.equal(name, 'tt_beli_detail');
      return { find(query) { assert.equal(query.status_valid.$ne, 'CANC'); return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* records; } }; } };
    },
  }; } };
  const report = await new PriceAuditService(mongo, { async read() { return structuredClone(references); } }, legacy).report({ windows: [{ date, fromTime: '00:00', toTime: '24:00', attachmentIds: ['one'] }], buybackAutoBatch: true }, sources, 'owner', 'session');
  const table = report.blocks.find(block => block.type === 'table' && block.title === 'Audit harga buyback perhiasan');
  const cell = (row, name) => row[table.columns.indexOf(name)];
  assert.equal(table.rows.length, 14); assert.equal(queries.length, 1, 'legacy lookup/cache is batched across all stores in one report');
  assert.deepEqual(queries[0].values.slice(0, -1).sort(), ['000123', '000124', 'duplicate', 'missing']);
  for (const source of sources) {
    const row = name => table.rows.find(item => cell(item, 'Toko') === source.alias && cell(item, 'No. Faktur') === name);
    assert.equal(table.columns.includes('Sumber Barang'), false); assert.equal(cell(row('modern'), 'Kode Intern'), 'C5 16');
    assert.equal(cell(row('old-shine'), 'Kode Intern'), 'SHINE'); assert.equal(cell(row('old-shine'), 'Kode Acuan'), 'C5');
    assert.equal(cell(row('old-shine'), 'Range Batch 1 (IDR/gram)'), 'Rp1.466.000–Rp1.507.000');
    assert.equal(cell(row('old-shine'), 'Harga Rata per gram (IDR)'), 1490000); assert.equal(cell(row('old-shine'), 'Hasil Pemeriksaan'), 'Masih dalam batas range acuan');
    assert.equal(cell(row('old-eternity'), 'Kode Acuan'), 'D1 / E1'); assert.equal(cell(row('old-eternity'), 'Hasil Pemeriksaan'), 'Masih dalam batas range acuan');
    for (const name of ['missing', 'duplicate', 'mongo-duplicate']) assert.equal(cell(row(name), 'Hasil Pemeriksaan'), 'Perlu diperhatikan');
    assert.match(cell(row('missing'), 'Keterangan Pemeriksaan'), /Kode intern barang belum diketahui/);
    assert.match(cell(row('duplicate'), 'Keterangan Pemeriksaan'), /beberapa data barang/);
    for (const item of table.rows) assert.doesNotMatch(cell(item, 'Keterangan Pemeriksaan'), /mongo\s*db|maria\s*db|mysql|rds/i);
    assert.ok(!row('cancelled'));
  }
  const brokenMongo = { collection() { return { find() { throw new Error('offline'); } }; } };
  let forbidden = 0;
  await fillBuybackMaster([{ record: records[1], tx: buybackAuditTransaction(records[1], 'Italy') }], brokenMongo, new Map(), { async lookupMany() { forbidden++; return new Map(); } });
  assert.equal(forbidden, 0, 'a MongoDB outage is not treated as an absent barcode');

  let failureCalls = 0, warnings = [];
  const failing = new LegacyBarangService(() => ({ on() { return this; }, async getConnection() { failureCalls++; throw Object.assign(new Error('private SQL and password must not be logged'), { code: 'ER_GET_CONNECTION_TIMEOUT', cause: { code: 'ER_ACCESS_DENIED_ERROR', message: 'private user and password' } }); }, async end() {} }));
  failing.logger.warn = value => warnings.push(value);
  assert.equal((await failing.lookupMany(['one'])).get('one').status, 'unavailable');
  assert.equal((await failing.lookupMany(['two'])).get('two').status, 'unavailable');
  assert.equal(failureCalls, 1); assert.equal(warnings.length, 1); assert.doesNotMatch(warnings.join(''), /private SQL|password|private user/);
  assert.match(warnings[0], /ER_GET_CONNECTION_TIMEOUT -> ER_ACCESS_DENIED_ERROR/, 'safe cause codes explain the failure');
  await failing.onModuleDestroy();
  let destroyed = 0, lateReleases = 0;
  const stalled = new LegacyBarangService(() => ({ on() { return this; }, async getConnection() { return {
    query() { return new Promise(() => {}); }, destroy() { destroyed++; }, async release() { lateReleases++; },
  }; }, async end() {} }), 10);
  const timeoutWarnings = []; stalled.logger.warn = value => timeoutWarnings.push(value);
  assert.equal((await stalled.lookupMany(['slow'])).get('slow').status, 'unavailable');
  assert.equal(destroyed, 1, 'a query exceeding the client deadline closes its connection');
  assert.equal(lateReleases, 0, 'timed out connections must not return to the pool');
  assert.match(timeoutWarnings[0], /RDS_QUERY_TIMEOUT/);
  await stalled.onModuleDestroy();
  let failedReleases = 0;
  const badSchema = new LegacyBarangService(() => ({ on() { return this; }, async getConnection() { return {
    async query() { throw Object.assign(new Error('private table/schema'), { code: 'ER_BAD_FIELD_ERROR' }); }, destroy() { assert.fail('query failure is released normally'); }, async release() { failedReleases++; },
  }; }, async end() {} }));
  const schemaWarnings = []; badSchema.logger.warn = value => schemaWarnings.push(value);
  assert.equal((await badSchema.lookupMany(['bad-schema'])).get('bad-schema').status, 'unavailable');
  assert.equal(failedReleases, 1); assert.match(schemaWarnings[0], /ER_BAD_FIELD_ERROR/); assert.doesNotMatch(schemaWarnings[0], /private table/);
  await badSchema.onModuleDestroy();
  await legacy.onModuleDestroy(); assert.equal(ends, 1);
  const originalRds = env.rds; env.rds = { url: '', database: '', username: '', password: '' };
  const disabled = new LegacyBarangService(() => { throw new Error('must not create a pool'); });
  assert.equal((await disabled.lookupMany(['one'])).get('one').status, 'disabled'); env.rds = originalRds;
  const invalid = spawnSync(process.execPath, ['-e', 'require("./dist/src/config/env")'], { cwd: process.cwd(), env: { ...process.env, RDS_PASSWORD: '' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /RDS_PASSWORD/); assert.doesNotMatch(invalid.stderr, /fixture:password|archive.invalid/);
  execFileSync(process.execPath, ['-e', 'require("./dist/src/config/env")'], { cwd: process.cwd(), env: { ...process.env, RDS_URLDB_API: '', RDS_DB_NAME: '', RDS_USERNAME: '', RDS_PASSWORD: '', ENC_KEY_DEC: '' } });

  let saved;
  const originalFetch = global.fetch;
  const modelReply = require('./price-cell-fixture.cjs').withPriceCellVerification;
  const parser = new PriceReferenceService(withPriceCache({ db: { collection() { return { async updateOne(_q, update) { saved = update.$set; } }; } } }), { async uploadPriceAttachment() { return { id: '000000000000000000000001', filename: 'reference.png', mime: 'image/png' }; }, async deleteAttachment() {} }, { async resolveActorEmail() { return ''; }, async begin() { return 'fixture'; }, async finish() {} });
  try {
    global.fetch = modelReply(async (_url, options) => {
      assert.match(JSON.parse(options.body).messages[0].content, /descriptive first-column label in sourceLabel/);
      const compact = (sourceCode, sourceLabel, goodThousands) => ({ family: 'old', sourceCode, sourceLabel, printedKadar: '', goodThousands, scrapThousands: 1425, stoneMinThousands: 1466, stoneMaxThousands: 1497 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ isJewelryPrice: true, date, batch: 1, complete: true, warnings: [], buybackRows: [compact('C5', 'SHINE', 1507), compact('D1/E1', 'Eternity', 1518)] }) } }] }), { status: 200 });
    });
    const parsed = await parser.upload('000000000000000000000002', 'owner', Buffer.from('fixture'), 'reference.png');
    assert.equal(saved.parserVersion, PRICE_REFERENCE_PARSER_VERSION);
    assert.ok(parsed.rows.filter(row => row.sourceCode === 'C5').every(row => row.sourceLabel === 'SHINE'));
    assert.ok(parsed.rows.filter(row => ['D1', 'E1'].includes(row.sourceCode)).every(row => row.sourceLabel === 'Eternity'));
  } finally { global.fetch = originalFetch; }
  console.log('Legacy buyback passed: encrypted env, MySQL/MariaDB-compatible client deadlines, timeout connection disposal, safe cause codes, parameterized barcode batches, negative/duplicate caches, Mongo priority, named reference labels and CANC exclusion.');
})().catch(error => { console.error(error); process.exitCode = 1; });
