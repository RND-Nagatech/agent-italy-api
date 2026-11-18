// Isolated database/model fixtures; no live database or API calls.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'italy_sales_check';
process.env.JWT_ACCESS_SECRET = 'offline-italy-sales-check-secret-32-characters';
process.env.ENC_KEY_DEC = 'qa-key';
process.env.DEEPSEEK_API_KEY = 'offline-model';
const assert = require('node:assert/strict');
const { TransactionReportService } = require('../dist/src/agent/transaction-report.service');
const { transactionReportBlocks } = require('../dist/src/agent/transaction-report.blocks');
const { salesTransactionsPipeline } = require('../dist/src/agent/sales-transactions.pipeline');
const { BranchSalesService } = require('../dist/src/agent/branch-sales.service');
const { branchSalesTools } = require('../dist/src/agent/branch-sales.tools');
const { AtomicDataService } = require('../dist/src/agent/atomic-data.service');
const { atomicTools } = require('../dist/src/agent/atomic-tools');
const { SalesReportService } = require('../dist/src/sales/sales-report.service');
const { AgentService } = require('../dist/src/agent/agent.service');
const { transactionReportTools } = require('../dist/src/agent/transaction-report.tools');
const { allStoreSalesTodayQuery } = require('../dist/src/agent/sales-report-intent');
const sources = [
  { branchId: 'PUSAT', alias: 'ITALY PUSAT', databaseName: 'fixture_pusat', sourceType: 'central' },
  { branchId: 'IT2', alias: 'ITALY OTISTA', databaseName: 'fixture_otista', sourceType: 'branch' },
];
const range = { from: '2026-11-18', to: '2026-11-18' };
const encrypt = value => {
  const key = process.env.ENC_KEY_DEC;
  let result = '', index = 0;
  for (const char of value) {
    result += (char.charCodeAt(0) + key.charCodeAt(index)).toString(16);
    if (index === key.length - 1) index = 0;
    index += 1;
  }
  return result.toUpperCase();
};
const queried = [];
const mongoFor = (facet, missing) => ({ getDatabase: database => {
  queried.push(database);
  return {
    listCollections: () => ({ hasNext: async () => database !== missing }),
    collection: () => ({
      aggregate: () => ({ toArray: async () => [facet] }),
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
  };
} });

(async () => {
  for (const question of ['penjualan hari ini', 'penjualan hari ini berapa', 'tolong tampilkan penjualan italy hari ini berapa bro?']) {
    assert.deepEqual(allStoreSalesTodayQuery(question, range.from), { reportType: 'sales', ...range });
  }
  for (const question of ['penjualan italy pusat hari ini', 'penjualan transfer hari ini', 'otorisasi penjualan hari ini', 'bandingkan penjualan hari ini dan kemarin']) assert.equal(allStoreSalesTodayQuery(question, range.from), null);
  const pipeline = salesTransactionsPipeline(range, 201);
  assert.deepEqual(pipeline[0].$match, { status_kembali: 'OPEN', status_valid: 'DONE', status_tukar: { $ne: true }, trs_barang_tukar: { $ne: true }, tgl_system: { $gte: range.from, $lte: range.to } });
  assert.equal(pipeline[1].$facet.rows[1].$limit, 201);
  assert(!JSON.stringify(pipeline[1].$facet.totals).includes('$limit'));
  assert.equal(pipeline[1].$facet.rows[2].$project.no_faktur_group_user, undefined);

  const facet = {
    rows: Array.from({ length: 201 }, (_, index) => ({ tgl_system: range.from, no_faktur_jual: `FJ-${index}`, kode_barcode: String(index), nama_barang: encrypt('CINCIN'), input_by: encrypt('KASIR'), berat: 1, harga_total: 10 })),
    totals: [{ invoiceCount: 300, detailCount: 300, salesAmountIdr: 3000, weightGram: 300 }],
  };
  const service = new TransactionReportService(mongoFor(facet));
  const report = await service.read({ reportType: 'sales', ...range }, sources);
  assert.deepEqual(report.sources.map(source => source.branchId), ['PUSAT', 'IT2']);
  assert.deepEqual(queried, ['fixture_pusat', 'fixture_otista']);
  assert.equal(report.sources[0].rows.length, 200);
  assert.equal(report.sources[0].rows[0].input_by, 'KASIR');
  assert.equal(report.sources[0].rows[0].nama_barang, 'CINCIN');
  assert.equal(report.sources[0].truncated, true);
  const blocks = transactionReportBlocks(report);
  assert.equal(blocks.find(block => block.type === 'metric' && block.label === 'Total penjualan').value, 6000);
  const tables = blocks.filter(block => block.type === 'table');
  assert.equal(tables.length, 2);
  assert.equal(tables[0].columns.at(-1), 'Input oleh');
  assert(!tables[0].columns.some(column => /group/i.test(column)));
  assert(blocks.some(block => block.type === 'callout' && /seluruh periode/.test(block.text)));

  const selected = await service.read({ reportType: 'sales', ...range, branchIds: ['PUSAT'] }, sources);
  assert.deepEqual(selected.sources.map(source => source.branchId), ['PUSAT']);
  await assert.rejects(service.read({ reportType: 'sales', ...range, branchIds: ['PUSAT'] }, [sources[1]]));
  const partial = await new TransactionReportService(mongoFor(facet, 'fixture_pusat')).read({ reportType: 'sales', ...range }, sources);
  assert.equal(partial.partial, true);
  assert.equal(partial.sources[0].status, 'unavailable');
  assert(transactionReportBlocks(partial).some(block => block.type === 'callout' && /tidak ikut dihitung/.test(block.text)));

  const grouped = { rows: [], totals: [{ weightGram: 12, salesAmountIdr: 100, recordsWithoutWeight: 0, groupCount: 0, groups: 0 }] };
  const branchService = new BranchSalesService(mongoFor(grouped));
  assert.deepEqual((await branchService.read(false, range, sources)).branches.map(source => source.branchId), ['PUSAT', 'IT2']);
  assert.deepEqual((await branchService.read(true, { ...range, branchIds: ['PUSAT'] }, sources)).branches.map(source => source.branchId), ['PUSAT']);
  const atomic = await new AtomicDataService(mongoFor(grouped)).read('sales', range, sources);
  assert.deepEqual(atomic.branches.map(source => source.branchId), ['PUSAT', 'IT2']);

  const filters = [];
  const periodMongo = { db: { collection: () => ({ find: filter => {
    filters.push(filter);
    return { sort: () => ({ limit: () => ({ toArray: async () => sources.filter(source => (!filter.branchId || source.branchId === filter.branchId) && (!filter.sourceType || source.sourceType !== 'central')) }) }) };
  } }) } };
  const periodService = new SalesReportService(periodMongo, { getOrLoad: async (_key, loader) => loader() });
  periodService.loadReport = async selectedSources => selectedSources.map(source => source.branchId);
  assert.deepEqual(await periodService.report(range, { role: 'admin' }), ['PUSAT', 'IT2']);
  assert.equal(filters[0].sourceType, undefined);
  assert.deepEqual(await periodService.report({ ...range, branchId: 'PUSAT' }, { role: 'pusat' }), ['PUSAT']);
  assert.deepEqual(await periodService.report(range, { role: 'cabang', branchId: 'IT2' }), ['IT2']);
  await assert.rejects(periodService.report({ ...range, branchId: 'PUSAT' }, { role: 'cabang', branchId: 'IT2' }));

  const agent = Object.create(AgentService.prototype);
  const definitions = [...transactionReportTools, ...branchSalesTools, ...atomicTools];
  const validate = (name, args, allowed = sources) => agent.validateToolPlan([{ id: 'check', type: 'function', function: { name, arguments: JSON.stringify(args) } }], definitions, allowed, 'admin', false, []);
  assert.equal(validate('get_transaction_report', { ...range, reportType: 'sales' }), null);
  for (const name of ['get_branch_sales', 'get_sales_by_salesperson', 'get_sales_period']) assert.equal(validate(name, { ...range, branchIds: ['PUSAT'] }), null);
  assert(validate('get_sales_period', { ...range, branchIds: ['PUSAT'] }, [sources[1]]));
  assert(validate('get_shipments_period', { ...range, branchIds: ['PUSAT'] }));
  agent.getAllowedSources = async () => sources;
  agent.setChatProgress = () => {};
  agent.agentRunTraces = { recordPlan: async () => {} };
  agent.transactionReports = service;
  let modelCalls = 0;
  agent.requestModel = async () => {
    modelCalls += 1;
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'old-branch-choice', type: 'function', function: { name: 'get_branch_sales', arguments: JSON.stringify({ ...range, branchIds: ['IT2'] }) } }] } }] };
  };
  const answer = await agent.runChat({ messages: [{ role: 'user', content: 'penjualan hari ini berapa' }] }, { sub: 'qa', role: 'admin' });
  assert.equal(modelCalls, 1);
  assert.deepEqual(answer.usedSources.map(source => source.branchId), ['PUSAT', 'IT2']);
  assert.equal(answer.blocks.filter(block => block.type === 'table').length, 2);
  assert.match(answer.answer, /ITALY PUSAT/);
  assert.match(answer.answer, /ITALY OTISTA/);
  console.log('PASS Italy sales: central + branches, explicit store filters, authorization, all-period totals, limited detail rows, decryption, deterministic tables, partial failures, atomic/grouped sales and tool validation. No live database/model.');
})().catch(error => { console.error(error); process.exitCode = 1; });
