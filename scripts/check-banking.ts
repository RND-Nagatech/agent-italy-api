import assert from 'node:assert/strict';
import type { BankEntry, BankSelection, BankSource, BankStatement, BankTransaction } from '../src/agent/banking.types';

// Isolated fixtures only: no connection to application databases or external model services.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'banking_test';
process.env.JWT_ACCESS_SECRET = 'banking-test-secret-at-least-32-characters';
process.env.ENC_KEY_DEC = 'banking-test-key';
process.env.DEEPSEEK_API_KEY = 'banking-test-no-network';

async function main() {
  const { reconcileBankEntries, encryptBankField, decryptBankField, accountIdentifier, bankIdentity, parseBankAmountText, bankDirectionFromMarker } = await import('../src/agent/banking.logic');
  const { BankingService } = await import('../src/agent/banking.service');
  const { BankStatementService } = await import('../src/agent/bank-statement.service');
  const transaction = (id: string, moneyIn = 1000, moneyOut = 0, date = '2026-11-01'): BankTransaction => ({ id, branchId: 'PUSAT', sourceAlias: 'ITALY PUSAT', accountId: 'a', bankCode: 'BCA', bankName: 'BCA', accountNumber: '0012345678', date, reference: id, invoices: ['ITY-FJ-01'], customer: 'Customer A', category: 'PENJUALAN', method: 'TRANSFER', description: '', moneyIn, moneyOut, inputBy: 'KASIR-1' });
  const entry = (id: string, amount = 1000, direction: BankEntry['direction'] = 'IN', date = '2026-11-01'): BankEntry => ({ id, date, amount, direction, description: 'TRSF', reference: '', balance: null, page: 1 });
  assert.equal(decryptBankField(encryptBankField('0012345678')), '0012345678');
  assert.equal(decryptBankField(encryptBankField('KASIR-1')), 'KASIR-1');
  assert.equal(accountIdentifier(' 001.234-5678 '), '0012345678');
  for (const code of ['BCA', 'TIKTOK', 'BCA-01', 'BCA01', 'BCA UTAMA', 'BCAUTAMA']) assert.equal(accountIdentifier(code), code);
  assert.equal(bankIdentity('PT BANK CENTRAL ASIA TBK'), bankIdentity('BCA'));
  assert.equal(parseBankAmountText('Rp 29.885.000', 29_885), 29_885_000);
  assert.equal(parseBankAmountText('Rp 1.234,50', 1234), 1234.5);
  assert.equal(parseBankAmountText('Rp 1,234.50', 1234), 1234.5);
  assert.equal(bankDirectionFromMarker('CR'), 'IN');
  assert.equal(bankDirectionFromMarker('DB'), 'OUT');
  assert.equal(bankDirectionFromMarker('TRANSFER'), null);
  assert.equal(reconcileBankEntries([transaction('a')], [entry('b')], true)[0].status, 'MATCHED');
  assert.equal(reconcileBankEntries([transaction('a', 0, 1000)], [entry('b', 1000, 'OUT')], true)[0].status, 'MATCHED');
  const sale2492 = reconcileBankEntries([transaction('sale-2492', 2_492_000, 0, '2026-11-12')], [entry('bank-2492', 2_492_000, 'IN', '2026-11-12')], true);
  assert.equal(sale2492[0].status, 'MATCHED', 'Rp 2.492.000 CR on the same date should match money-in transaction');
  const directionConflict = reconcileBankEntries([transaction('sale-direction', 2_492_000, 0, '2026-11-12')], [entry('bank-direction', 2_492_000, 'OUT', '2026-11-12')], true);
  assert.equal(directionConflict[0].status, 'REVIEW');
  assert.match(directionConflict[0].reason, /arah uang berbeda/i);
  const oppositeDirection = reconcileBankEntries([transaction('a')], [entry('b', 1000, 'OUT')], true);
  assert.equal(oppositeDirection[0].status, 'REVIEW', 'Same date and amount with an opposite direction should be flagged for review');
  assert.match(oppositeDirection[0].reason, /arah uang berbeda/i);
  const ambiguousTransaction = reconcileBankEntries([transaction('a'), transaction('c')], [entry('b')], true);
  assert(ambiguousTransaction.every(match => match.status === 'REVIEW'), 'Repeated exact transaction amounts must be reported as ambiguous, not missing');
  assert.match(ambiguousTransaction[0].reason, /lebih dari satu pasangan/i);
  const duplicateBankEntries = reconcileBankEntries([transaction('a')], [entry('b'), entry('c')], true);
  assert(duplicateBankEntries.every(match => match.status === 'REVIEW'), 'Duplicate exact statement movements must be reported as ambiguous');
  assert.match(duplicateBankEntries[0].reason, /lebih dari satu pasangan/i);
  assert(reconcileBankEntries([transaction('a')], [entry('b')], false).every(match => match.status === 'REVIEW'));
  assert.equal(reconcileBankEntries([transaction('a')], [entry('b', 1000, 'IN', '2026-11-02')], true)[0].status, 'REVIEW');
  const amountConflict = reconcileBankEntries([transaction('a', 1000.01)], [entry('b', 1000.02)], true);
  assert.equal(amountConflict[0].status, 'REVIEW');
  assert.match(amountConflict[0].reason, /nominal berbeda/i);
  assert(reconcileBankEntries([transaction('a'), transaction('b', 1000, 0, '2026-11-02')], [entry('x'), entry('y', 1000, 'IN', '2026-11-02')], true).every(match => match.status === 'MATCHED'));
  const sameAmountManyDays = Array.from({ length: 20 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
  assert(reconcileBankEntries(sameAmountManyDays.map((day, index) => transaction(`t${index}`, 1000, 0, day)), sameAmountManyDays.map((day, index) => entry(`e${index}`, 1000, 'IN', day)), true).every(match => match.status === 'MATCHED'));
  const noNarrativeMatch = reconcileBankEntries(
    [{ ...transaction('no-invoice-match'), invoices: ['FAKTUR-BERBEDA'], description: 'KETERANGAN SISTEM BERBEDA', accountNumber: 'BCA' }],
    [{ ...entry('statement-no-reference'), reference: 'REFERENSI LAIN', description: 'NAMA PENGIRIM BERBEDA' }],
    true,
  );
  assert.equal(noNarrativeMatch[0].status, 'MATCHED', 'Only date, direction, and amount determine a unique match; ignore invoices, description, references, and account number');
  const screenshotTransactions = [
    { ...transaction('sale-0006', 6_185_000, 0, '2026-11-12'), invoices: ['IT2-FJ-20261112-0006'] },
    { ...transaction('purchase-group', 0, 29_885_000, '2026-11-12'), invoices: Array.from({ length: 7 }, (_, index) => `IT2-FB-261112-${String(index + 1).padStart(4, '0')}`) },
  ];
  const screenshotEntries = [
    { ...entry('statement-sale', parseBankAmountText('Rp 6.185.000', 6185), 'IN', '2026-11-12'), description: 'IT2-FJ-20261112-0006 TRANSFER' },
    { ...entry('statement-purchase', parseBankAmountText('Rp 29.885.000', 29885), 'OUT', '2026-11-12'), description: 'IT2-FB-261112-0001, IT2-FB-261112-0002, IT2-FB-261112-0003, IT2-FB-261112-0004, IT2-FB-261112-0005, IT2-FB-261112-0006, IT2-FB-261112-0007 TRANSFER' },
  ];
  assert(reconcileBankEntries(screenshotTransactions, screenshotEntries, true).every(match => match.status === 'MATCHED'), 'The supplied BCA statement amount formatting, date, and direction should match exact system transfers');

  const sources: BankSource[] = [{ branchId: 'PUSAT', alias: 'ITALY PUSAT', databaseName: 'fixture', sourceType: 'central' }];
  const rows: Record<string, any[]> = {
    tm_rekening: [{ no_rekening: encryptBankField('0012345678'), kode_bank: 'BCA', nama_rekening: encryptBankField('TOKO PUSAT'), password: 'MUST_NOT_ESCAPE' }, { no_rekening: '9988776655', kode_bank: 'BCA', nama_rekening: 'TOKO KEDUA' }],
    tm_bank: [{ kode_bank: 'BCA', nama_bank: encryptBankField('BCA') }],
    tt_cash_daily: Array.from({ length: 250 }, (_, index) => ({ _id: `cash-${index}`, no_reff: `reference-${index}`, no_rekening: encryptBankField('0012345678'), tanggal: '2026-11-01', status: 'OPEN', jenis: encryptBankField('TRANSFER'), kategori: encryptBankField(index % 2 ? 'PEMBELIAN' : 'PENJUALAN'), jumlah_in: index % 2 ? 0 : 1100, jumlah_out: index % 2 ? 600 : 0, input_by: encryptBankField('KASIR-1'), no_faktur_list: ['FAKTUR-1', 'FAKTUR-2'], sale: [{ nama_customer: encryptBankField('Sari') }] })),
    th_cash_daily: [],
  };
  rows.th_cash_daily = [rows.tt_cash_daily[0]];
  rows.tt_cash_daily.push({ ...rows.tt_cash_daily[0], _id: 'cash-return', no_reff: 'cash-return', jenis: encryptBankField('CASH'), kategori: encryptBankField('KEMBALI TRANSFER'), jumlah_in: 0, jumlah_out: 100 });
  const pipelines: any[][] = [];
  const mongo = { db: { collection: () => ({ updateOne: async () => ({}) }) }, getDatabase: () => ({
    listCollections: ({ name }: { name: string }) => ({ hasNext: async () => name in rows }),
    collection: (name: string) => ({
      find: () => ({ limit: () => ({ toArray: async () => rows[name] ?? [] }) }),
      aggregate: (pipeline: any[]) => {
        pipelines.push(pipeline);
        const m = pipeline[0].$match;
        const filtered = (rows[name] ?? []).filter(row => row.status === m.status && row.tanggal >= m.tanggal.$gte && row.tanggal <= m.tanggal.$lte && m.no_rekening.$in.includes(row.no_rekening) && (m.jenis?.$in ? m.jenis.$in.includes(row.jenis) : !['CASH', 'BAYAR POIN', 'SALDO_AWAL_REKENNING'].map(encryptBankField).includes(row.jenis) || ['TAMBAH UANG BANK', 'AMBIL UANG BANK'].map(encryptBankField).includes(row.kategori)) && (m.kategori.$in ? m.kategori.$in.includes(row.kategori) : !m.kategori.$nin.includes(row.kategori)));
        return { async *[Symbol.asyncIterator]() { yield* filtered }, close: async () => undefined };
      },
    }),
  }) };
  let intent = { bank: '', accountNumbers: [] as string[], sourceHints: [] as string[], from: '', to: '', allAccounts: false, allStores: false, method: 'TRANSFER', category: 'ALL' };
  let documents: BankStatement[] = [];
  const reader = { queryIntent: async () => intent, extract: async () => documents };
  const service = new BankingService(mongo as any, reader as any);
  const directory = await service.directory(sources);
  assert.equal(directory.accounts[0].accountNumber, '0012345678');
  assert.equal(directory.accounts[0].accountName, 'TOKO PUSAT');
  assert(!JSON.stringify(directory).includes('MUST_NOT_ESCAPE'));
  let scope = await service.resolve({ prompt: 'cek transaksional transfer' }, sources, 'owner');
  assert(scope.handled && scope.needsSource && scope.needsDate && scope.needsAccounts);
  intent = { ...intent, bank: 'BCA', from: '2026-11-01', to: '2026-11-01' };
  scope = await service.resolve({ prompt: 'transfer BCA hari ini ITALY PUSAT' }, sources, 'owner');
  assert(scope.handled && !scope.needsSource && !scope.needsDate && scope.needsAccounts);
  intent = { ...intent, accountNumbers: ['0012345678'] };
  scope = await service.resolve({ prompt: 'transfer BCA rekening 0012345678' }, sources, 'owner');
  assert(scope.handled && scope.needsDate, 'Do not infer dates that the user did not provide');
  scope = await service.resolve({ prompt: 'transfer BCA rekening 0012345678 tanggal 1 November 2026' }, sources, 'owner');
  assert(scope.handled && !scope.needsSource && !scope.needsAccounts && !scope.needsDate);
  const selection = (scope as any).selection as BankSelection;
  const report = await service.report(selection, sources, 'owner');
  const table = report.blocks.find(block => block.type === 'table');
  assert(table?.type === 'table');
  assert.equal(table.rows.length, 250, 'Preserve >200 records; no invoice fan-out or historical duplicate');
  assert.equal(table.columns.at(-1), 'Input oleh');
  assert(table.rows.every(row => row.length === table.columns.length));
  assert.equal(table.rows[0].at(-1), 'KASIR-1');
  assert.equal(report.blocks.find(block => block.type === 'metric' && block.label === 'Total uang masuk')?.type, 'metric');
  assert.equal((report.blocks.find(block => block.type === 'metric' && block.label === 'Total uang masuk') as any).value, 125 * 1100, 'Use actual bank amount, do not net cash change or fee');
  assert(pipelines.every(pipeline => !pipeline.some(stage => '$unwind' in stage)));
  rows.tt_cash_daily.push({ ...rows.tt_cash_daily[0], _id: 'bank-deposit', no_reff: 'bank-deposit', jenis: encryptBankField('CASH'), kategori: encryptBankField('TAMBAH UANG BANK'), jumlah_in: 100, jumlah_out: 0 });
  const allBankMovements = await service.report({ ...selection, method: 'ALL' }, sources, 'owner');
  const allTable = allBankMovements.blocks.find(block => block.type === 'table');
  assert(allTable?.type === 'table' && allTable.rows.length === 251, 'Include bank deposit, exclude cash change even when its stored account is populated');
  await assert.rejects(() => service.report({ ...selection, branchIds: ['UNAUTHORIZED'] }, sources, 'owner'));
  await assert.rejects(() => service.report({ ...selection, accountIds: ['forged'] }, sources, 'owner'));
  await assert.rejects(() => service.report({ ...selection, from: '2026-02-30' }, sources, 'owner'));
  intent = { ...intent, accountNumbers: ['0012345678', '9999999999'] };
  scope = await service.resolve({ prompt: 'transfer BCA rekening 0012345678 dan 9999999999', sessionId: 'session' }, sources, 'owner');
  assert(scope.handled && scope.needsAccounts && scope.conflict, 'Do not silently ignore an unavailable requested account');
  documents = [{ id: 'doc', attachmentId: 'doc', filename: 'test.pdf', bankName: 'BANK CENTRAL ASIA', accountNumber: '0012345678', currency: 'IDR', from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1100, entries: [entry('bank-1', 1100)], complete: true, warnings: [] }];
  intent = { ...intent, bank: '', accountNumbers: [], sourceHints: [], from: '', to: '' };
  scope = await service.resolve({ prompt: 'analisis lampiran', sessionId: 'session', attachmentIds: ['doc'] }, sources, 'owner');
  assert(scope.handled && scope.selection.from === '2026-11-01' && scope.selection.method === 'ALL' && scope.needsAccounts && !scope.needsSource, 'Infer bank/store/dates from the uploaded statement, then ask which master BCA account(s) to include');
  assert(scope.accounts.every(account => bankIdentity(account.bankCode) === 'BCA'), 'Only accounts registered under the statement bank should be offered');
  const mismatchedHeaderAccount = await service.report({ ...selection, accountIds: [directory.accounts[1].id], statementIds: ['doc'] }, sources, 'owner', 'session');
  assert(mismatchedHeaderAccount.blocks.some(block => block.type === 'table'), 'Do not compare the statement physical account number with the program master no_rekening');

  // The original master accepts account codes; these are not physical numeric bank accounts.
  const masterCodes = ['BCA', 'TOKOPEDIA', 'MANDIRI', 'SHOPEE', 'BNI', 'BRI', 'TIKTOK'];
  const additionalCodes = ['BCA-01', 'BCA01', 'BCA UTAMA', 'BCAUTAMA'];
  for (const [index, code] of [...masterCodes, ...additionalCodes].entries()) {
    const bankCode = code.startsWith('BCA') ? 'BCA' : code;
    rows.tm_rekening.push({ no_rekening: index % 2 ? code : encryptBankField(code), kode_bank: bankCode, nama_rekening: encryptBankField(`REKENING ${code}`) });
    if (!rows.tm_bank.some(bank => bank.kode_bank === bankCode)) rows.tm_bank.push({ kode_bank: bankCode, nama_bank: encryptBankField(`BANK ${bankCode}`) });
    rows.tt_cash_daily.push({ ...rows.tt_cash_daily[0], _id: `alias-${code}`, no_reff: `alias-${code}`, no_rekening: index % 2 ? code : encryptBankField(code), jumlah_in: 100 + index, jumlah_out: 0 });
  }
  rows.tt_cash_daily.push({ ...rows.tt_cash_daily.at(-1), _id: 'alias-cancelled', no_reff: 'alias-cancelled', no_rekening: encryptBankField('BCA'), status: 'CLOSE', jumlah_in: 999999 });
  rows.tt_cash_daily.push({ ...rows.tt_cash_daily.at(-1), _id: 'alias-outside-period', no_reff: 'alias-outside-period', status: 'OPEN', tanggal: '2026-10-31' });
  documents = [];
  const legacyDirectory = await service.directory(sources);
  assert.equal(legacyDirectory.warnings.length, 0);
  for (const code of [...masterCodes, ...additionalCodes]) {
    const account = legacyDirectory.accounts.find(item => item.accountNumber === code);
    assert(account, `Show master account code ${code} in the picker`);
    assert.equal(account.accountName, `REKENING ${code}`);
    assert.equal(account.bankName, code.startsWith('BCA') ? 'BCA' : `BANK ${code}`);
  }
  assert.equal(new Set(legacyDirectory.accounts.map(account => account.id)).size, 2 + masterCodes.length + additionalCodes.length, 'Distinct code punctuation and spaces must not collapse account IDs');
  const aliasAccounts = legacyDirectory.accounts.filter(account => masterCodes.includes(account.accountNumber));
  const aliasSelection = { ...selection, accountIds: aliasAccounts.map(account => account.id), method: 'TRANSFER' as const, category: 'ALL' as const, statementIds: [] };
  const aliasReport = await service.report(aliasSelection, sources, 'owner');
  const aliasTables = aliasReport.blocks.filter(block => block.type === 'table');
  assert.equal(aliasTables.reduce((sum, table) => sum + table.rows.length, 0), 7, 'Read all seven master codes, exclude unselected codes, cancelled payments and other dates');
  assert.equal((aliasReport.blocks.find(block => block.type === 'metric' && block.label === 'Total uang masuk') as any).value, 721);
  for (const table of aliasTables) {
    assert.equal(table.columns.at(-1), 'Input oleh');
    assert(table.rows.every(row => masterCodes.includes(String(row[4]))));
  }
  const punctuated = legacyDirectory.accounts.find(account => account.accountNumber === 'BCA-01')!;
  const punctuationReport = await service.report({ ...aliasSelection, accountIds: [punctuated.id] }, sources, 'owner');
  const punctuationTable = punctuationReport.blocks.find(block => block.type === 'table');
  assert(punctuationTable?.type === 'table' && punctuationTable.rows.length === 1, 'BCA-01 must never include transactions from BCA01');
  assert.equal(punctuationTable.rows[0][4], 'BCA-01');
  intent = { ...intent, bank: '', accountNumbers: [], from: '2026-11-01', to: '2026-11-01' };
  scope = await service.resolve({ prompt: 'transaksi penjualan transfer italy pusat hari ini berapa' }, sources, 'owner');
  assert(scope.handled && !scope.needsSource && !scope.needsDate && scope.needsAccounts);
  const aliasScopeAccounts = scope.accounts;
  assert(masterCodes.every(code => aliasScopeAccounts.some(account => account.accountNumber === code)), 'Scope response must supply the master codes to the frontend');
  const savedMasters = rows.tm_rekening;
  rows.tm_rekening = savedMasters.filter(row => masterCodes.includes(accountIdentifier(decryptBankField(row.no_rekening))));
  documents = [{ id: 'doc', attachmentId: 'doc', filename: 'real-account.pdf', bankName: 'BCA', accountNumber: '0012345678', currency: 'IDR', from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1100, entries: [entry('bank-1', 1100)], complete: true, warnings: [] }];
  scope = await service.resolve({ prompt: 'periksa rekening koran italy pusat', sessionId: 'session', attachmentIds: ['doc'] }, sources, 'owner');
  assert(scope.handled && !scope.needsAccounts && scope.selection.accountIds.length === 1, 'Auto-select the sole master account for the statement bank even when its code differs from the physical account number');
  const aliasStatementReport = await service.report({ ...aliasSelection, statementIds: ['doc'] }, sources, 'owner', 'session');
  assert(aliasStatementReport.blocks.some(block => block.type === 'table'), 'A physical statement account may differ from the master account code');
  rows.tm_rekening = savedMasters;
  documents = [];

  // Exercise validated image extraction and cache with a stub gateway.
  const saved = new Map<string, any>();
  const statementMongo = { db: { collection: () => ({ findOne: async ({ _id }: any) => saved.get(_id) ?? null, updateOne: async ({ _id }: any, update: any) => { saved.set(_id, { ...update.$set, _id }) } }) } };
  let fileId = 'fixture-file', modelCalls = 0;
  const sessions = { bankingFiles: async () => [{ id: fileId, filename: 'fixture.png', mime: 'image/png', buffer: Buffer.from('isolated image fixture') }] };
  const audit = { resolveActorEmail: async () => 'test@example.invalid', begin: async () => 'audit', finish: async () => undefined };
  const statementReader = new BankStatementService(statementMongo as any, sessions as any, audit as any);
  let page = { isStatement: true, bankName: 'BCA', accountNumber: '0012345678', currency: 'IDR', from: '2026-11-01', to: '2026-11-30', pageNumber: 1, totalPages: 1, openingBalance: 100, closingBalance: 1100, complete: true, warnings: [], entries: [{ date: '2026-11-01', description: 'TRSF E-BANKING', reference: '', direction: 'OUT', directionMarker: 'CR', amount: 1, amountText: 'Rp 1.000', balance: 1100 }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { modelCalls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(page) } }] }), { status: 200 }) }) as typeof fetch;
  try {
    const parsed = await statementReader.extract('session', 'owner', [fileId]);
    assert.equal(parsed[0].complete, true);
    assert.equal(parsed[0].entries[0].direction, 'IN', 'Explicit CR marker overrides a conflicting model direction');
    assert.equal(parsed[0].entries[0].amount, 1000, 'Normalize the printed Indonesian thousand separator before matching');
    await statementReader.extract('session', 'owner', [fileId]);
    assert.equal(modelCalls, 1, 'Use owner/session scoped parser cache');
    fileId = 'partial'; page = { ...page, totalPages: 2 };
    const partial = await statementReader.extract('session', 'owner', [fileId]);
    assert.equal(partial[0].complete, false);
    fileId = 'mismatched-balance'; page = { ...page, totalPages: 1, closingBalance: 999 };
    assert.equal((await statementReader.extract('session', 'owner', [fileId]))[0].complete, false);
    fileId = 'unknown-direction'; page = { ...page, closingBalance: 1100, entries: [{ ...page.entries[0], direction: 'UNKNOWN', directionMarker: 'UNKNOWN' }] };
    assert.equal((await statementReader.extract('session', 'owner', [fileId]))[0].complete, false);
  } finally { globalThis.fetch = originalFetch }

  // Verify the installed PDF renderer can read and rasterize scan-like PDFs on this runtime.
  const { PDFParse } = await import('pdf-parse');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const parser = new PDFParse({ data: new Uint8Array(Buffer.from(pdf)), isEvalSupported: false });
  try {
    assert.equal((await parser.getInfo()).total, 1);
    const screenshots = await parser.getScreenshot({ partial: [1], desiredWidth: 800, imageDataUrl: true, imageBuffer: false });
    assert(screenshots.pages[0].dataUrl.startsWith('data:image/png;base64,'));
  } finally { await parser.destroy() }
  console.log('PASS banking: scope/modal requirements, encrypted masters, seven legacy master codes, exact alias filtering, leading zeros, account/store authorization, 250 payments, history dedupe, cash-change exclusion, actual amounts, IN/OUT, duplicate ambiguity, incomplete files, period drift, balances, image extraction and cache. No live data or model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1 });
