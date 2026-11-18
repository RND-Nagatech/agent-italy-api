import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { BankStatementService } from './bank-statement.service';
import { accountDigits, accountIdentifier, bankIdentity, decryptBankField, encryptBankField, reconcileBankEntries, validBankDate } from './banking.logic';
import type { BankAccount, BankSelection, BankSource, BankStatement, BankTransaction } from './banking.types';
import type { BankingScopeDto } from './dto/banking.dto';
import type { AgentResponseBlock } from './response-blocks';

export const isBankingRequest = (prompt: string) => /\bbank(?:nya)?\b|\btransfer\b|rekening|rekonsiliasi|mutasi|transaksional|transaksi\s+bank/i.test(prompt);
const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const variants = (value: string) => [...new Set([value, encryptBankField(value)])];
const accountId = (branchId: string, account: string) => createHash('sha256').update(`${branchId}:${account}`).digest('hex').slice(0, 32);
const text = (value: unknown) => decryptBankField(value) || '—';
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const accountMatchesBank = (account: BankAccount, bank: string) => bankIdentity(account.bankCode) === bankIdentity(bank) || bankIdentity(account.bankName) === bankIdentity(bank);

@Injectable()
export class BankingService {
  constructor(private readonly mongo: MongoService, private readonly statements: BankStatementService) {}

  async directory(sources: BankSource[]) {
    const accounts: BankAccount[] = [], warnings: string[] = [];
    for (const source of sources) {
      try {
        const db = this.mongo.getDatabase(source.databaseName);
        const [rows, banks] = await Promise.all([
          db.collection('tm_rekening').find({}, { projection: { no_rekening: 1, kode_bank: 1, nama_rekening: 1 }, maxTimeMS: 10_000 }).limit(2001).toArray(),
          db.collection('tm_bank').find({}, { projection: { kode_bank: 1, nama_bank: 1 }, maxTimeMS: 10_000 }).limit(1000).toArray(),
        ]);
        if (rows.length > 2000) throw new Error('directory too large');
        for (const row of rows) {
          const number = accountIdentifier(decryptBankField(row.no_rekening));
          if (!number) continue;
          const bankCode = String(row.kode_bank ?? '');
          const bank = banks.find(item => String(item.kode_bank) === bankCode);
          accounts.push({ id: accountId(source.branchId, number), branchId: source.branchId, sourceAlias: source.alias, bankCode, bankName: decryptBankField(bank?.nama_bank) || bankCode, accountNumber: number, accountName: decryptBankField(row.nama_rekening) });
        }
      } catch { warnings.push(`Daftar rekening ${source.alias} belum dapat dibaca.`); }
    }
    return { accounts: [...new Map(accounts.map(account => [account.id, account])).values()], warnings };
  }

  async resolve(dto: BankingScopeDto, sources: BankSource[], ownerId: string) {
    if (dto.attachmentIds?.length && !dto.sessionId) throw new BadRequestException('Lampiran rekening koran harus berada dalam percakapan.');
    const documents = dto.attachmentIds?.length && dto.sessionId ? await this.statements.extract(dto.sessionId, ownerId, dto.attachmentIds) : [];
    if (!documents.length && (!isBankingRequest(dto.prompt) || dto.attachmentIds?.length)) return { handled: false as const };
    const [intent, directory] = await Promise.all([this.statements.queryIntent(dto.prompt, ownerId, dto.sessionId), this.directory(sources)]);
    const normalizedPrompt = plain(dto.prompt);
    const promptMentions = (label: string) => {
      const normalized = plain(label);
      return normalized.length > 1 && ` ${normalizedPrompt} `.includes(` ${normalized} `);
    };
    const namedSources = sources.filter(source => [source.alias, source.branchId, source.alias.replace(/^ITALY\s+/i, '')].filter(label => plain(label).length > 1).some(label => new RegExp(`(?:^| )${plain(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(normalizedPrompt)));
    // The intent model can suggest a bank, but only a bank named by the user may narrow the account list.
    const explicitBanks = new Set(directory.accounts.filter(account => promptMentions(account.bankCode) || promptMentions(account.bankName)).map(account => bankIdentity(account.bankCode || account.bankName)));
    const documentBanks = new Set(documents.map(document => bankIdentity(document.bankName)).filter(Boolean));
    const bankScope = explicitBanks.size ? explicitBanks : documentBanks;
    const bankConflict = explicitBanks.size > 0 && [...documentBanks].some(bank => !explicitBanks.has(bank));
    const allStores = intent.allStores && /(?:semua|seluruh)\s+(?:toko|cabang|sumber)/i.test(dto.prompt);
    let branchIds = allStores ? sources.map(source => source.branchId) : namedSources.map(source => source.branchId);
    const promptDigits = dto.prompt.replace(/[\s.-]/g, '');
    const numbers = intent.accountNumbers.map(accountDigits).filter(number => /^[0-9]{5,40}$/.test(number) && promptDigits.includes(number));
    const warnings = [...directory.warnings, ...documents.flatMap(document => document.warnings.map(warning => `${document.filename}: ${warning}`))];
    let conflict = bankConflict;
    if (bankConflict) warnings.push('Bank pada chat berbeda dari bank di rekening koran. Pilih rekening dari bank yang sesuai.');
    const bankMatches = (account: BankAccount) => !bankScope.size || [...bankScope].some(bank => accountMatchesBank(account, bank));
    const explicit = numbers.length ? directory.accounts.filter(account => numbers.includes(account.accountNumber) && bankMatches(account)) : [];
    const detected = documents.length ? directory.accounts.filter(account => documents.some(document => accountMatchesBank(account, document.bankName))) : [];
    if (!branchIds.length && !allStores) {
      const inferred = explicit.length ? explicit : detected;
      const inferredSources = [...new Set(inferred.map(account => account.branchId))];
      if (inferredSources.length === 1) branchIds = inferredSources;
    }
    const scopedAccounts = directory.accounts.filter(account => (!branchIds.length || branchIds.includes(account.branchId)) && bankMatches(account));
    let selected = scopedAccounts;
    if (numbers.length) selected = selected.filter(account => numbers.includes(account.accountNumber));
    else if (!(intent.allAccounts && /(?:semua|seluruh)\s+(?:rekening|bank|bca|bni|bri|mandiri|bsi)/i.test(dto.prompt)) && !(bankScope.size && selected.length === 1)) selected = [];
    if (numbers.length && numbers.some(number => !selected.some(account => account.accountNumber === number))) { conflict = true; warnings.push('Satu atau beberapa rekening yang diminta tidak tersedia di master.'); }
    const unregisteredDocumentBanks = [...new Set(documents.filter(document => !directory.accounts.some(account => accountMatchesBank(account, document.bankName))).map(document => document.bankName))];
    if (unregisteredDocumentBanks.length) warnings.push(`Bank pada lampiran (${unregisteredDocumentBanks.join(', ')}) belum terdaftar di master rekening yang dapat diakses.`);
    const hasDateExpression = /hari\s+ini|kemarin|tadi|sekarang|besok|lusa|(?:minggu|pekan|bulan|tahun)\s+(?:ini|lalu|kemarin|terakhir|\d)|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/i.test(dto.prompt);
    const documentDateConflict = documents.some(document => document.dateConflict);
    let from = hasDateExpression ? intent.from : '', to = hasDateExpression ? intent.to : '';
    if (!from && !to && documents.length) { from = documents.map(document => document.from).filter(Boolean).sort()[0] ?? ''; to = documents.map(document => document.to).filter(Boolean).sort().at(-1) ?? ''; }
    if (from && !to) to = from;
    if (to && !from) from = to;
    const periodConflict = documents.length > 0 && Boolean(from && to) && !this.coveredPeriod(documents, from, to);
    if (periodConflict) { conflict = true; warnings.push('Periode yang diminta tidak seluruhnya tercakup pada rekening koran. Sesuaikan periode atau lampiran.'); }
    const selection: BankSelection = { branchIds, accountIds: selected.map(account => account.id), from, to, method: intent.method === 'TRANSFER' && /\btransfer\b/i.test(dto.prompt) ? 'TRANSFER' : 'ALL', category: intent.category === 'PENJUALAN' && /penjualan/i.test(dto.prompt) ? 'PENJUALAN' : intent.category === 'PEMBELIAN' && /pembelian/i.test(dto.prompt) ? 'PEMBELIAN' : 'ALL', statementIds: documents.map(document => document.id) };
    return { handled: true as const, selection, needsSource: !branchIds.length, needsDate: !from || !to || periodConflict || documentDateConflict, needsAccounts: !selected.length || conflict, conflict, accounts: scopedAccounts, warnings, documents: documents.map(({ entries, ...document }) => ({ ...document, entryCount: entries.length })) };
  }

  async report(selection: BankSelection, sources: BankSource[], ownerId: string, sessionId?: string, requestId?: string) {
    if (!validBankDate(selection.from) || !validBankDate(selection.to) || selection.from > selection.to || (Date.parse(selection.to) - Date.parse(selection.from)) / 86_400_000 > 365) throw new BadRequestException('Pilih rentang tanggal yang valid, maksimal 366 hari.');
    if (!selection.branchIds.length || selection.branchIds.some(branch => !sources.some(source => source.branchId === branch))) throw new BadRequestException('Toko yang dipilih tidak tersedia untuk akun ini.');
    const selectedSources = sources.filter(source => selection.branchIds.includes(source.branchId));
    const directory = await this.directory(selectedSources);
    const accounts = directory.accounts.filter(account => selection.accountIds.includes(account.id));
    if (new Set(accounts.map(account => account.id)).size !== new Set(selection.accountIds).size || !accounts.length) throw new BadRequestException('Rekening yang dipilih tidak tersedia. Muat ulang daftar rekening.');
    const documents = selection.statementIds.length && sessionId ? await this.statements.extract(sessionId, ownerId, selection.statementIds) : [];
    if (selection.statementIds.length && (!sessionId || documents.length !== selection.statementIds.length)) throw new BadRequestException('Lampiran rekening koran tidak ditemukan di percakapan ini.');
    for (const document of documents) {
      if (!accounts.some(account => bankIdentity(account.bankCode) === bankIdentity(document.bankName) || bankIdentity(account.bankName) === bankIdentity(document.bankName))) throw new BadRequestException(`Bank pada ${document.filename} berbeda dari bank rekening yang dipilih. Sesuaikan pilihan atau hapus lampiran tersebut.`);
      if (document.currency.toUpperCase() !== 'IDR') throw new BadRequestException('Pencocokan saat ini mendukung rekening IDR.');
    }
    if (documents.length && !this.coveredPeriod(documents, selection.from, selection.to)) throw new BadRequestException('Rekening koran belum mencakup seluruh periode yang dipilih untuk setiap rekening.');
    const transactions: BankTransaction[] = [];
    for (const source of selectedSources) {
      const sourceAccounts = accounts.filter(account => account.branchId === source.branchId);
      if (!sourceAccounts.length) continue;
      transactions.push(...await this.readTransactions(source, sourceAccounts, selection));
      if (transactions.length > 25_000) throw new BadRequestException('Total transaksi melebihi 25.000 data. Persempit periode atau jumlah rekening agar seluruh data bisa diperiksa.');
    }
    const blocks: AgentResponseBlock[] = [{ type: 'text', variant: 'heading', text: documents.length ? 'Pencocokan rekening koran' : 'Transaksi rekening bank' }, { type: 'text', variant: 'muted', text: `Periode ${selection.from} s/d ${selection.to}. ${accounts.map(account => `${account.bankName} ${account.accountNumber} · ${account.sourceAlias}`).join('; ')}.` }];
    const totalIn = transactions.reduce((sum, transaction) => sum + transaction.moneyIn, 0), totalOut = transactions.reduce((sum, transaction) => sum + transaction.moneyOut, 0);
    blocks.push({ type: 'metric', label: 'Total uang masuk', value: totalIn, unit: 'IDR', tone: 'teal' }, { type: 'metric', label: 'Total uang keluar', value: totalOut, unit: 'IDR', tone: 'navy' });
    if (directory.warnings.length) blocks.push({ type: 'callout', tone: 'warning', title: 'Sebagian sumber belum terbaca', text: directory.warnings.join(' ') });
    const matches: Array<{ bankName: string; documentIds: string[]; results: ReturnType<typeof reconcileBankEntries> }> = [];
    if (documents.length) {
      for (const groupKey of [...new Set(documents.map(document => bankIdentity(document.bankName)))]) {
        const group = documents.filter(document => bankIdentity(document.bankName) === groupKey);
        const bankName = group[0].bankName;
        const entries = group.flatMap(document => document.entries.filter(entry => entry.date >= selection.from && entry.date <= selection.to));
        if (entries.length > 25_000) throw new BadRequestException('Mutasi rekening koran melebihi 25.000 data. Pecah pemeriksaan per periode.');
        const seenDocuments = new Set<string>();
        for (const document of group) {
          const fingerprint = createHash('sha256').update(JSON.stringify(document.entries.map(({ id, page, ...entry }) => entry))).digest('hex');
          if (seenDocuments.has(fingerprint)) throw new BadRequestException('Ada rekening koran yang terunggah ganda. Hapus salah satu sebelum mencocokkan.');
          seenDocuments.add(fingerprint);
        }
        const rows = transactions.filter(transaction => bankIdentity(transaction.bankCode || transaction.bankName) === groupKey);
        const complete = group.every(document => document.complete) && directory.warnings.length === 0;
        const results = reconcileBankEntries(rows, entries, complete);
        matches.push({ bankName, documentIds: group.map(document => document.id), results });
        blocks.push(...this.reconciliationBlocks(group, rows, entries, results));
      }
      const uncoveredBanks = [...new Set(accounts.filter(account => !documents.some(document => accountMatchesBank(account, document.bankName))).map(account => account.bankName))];
      if (uncoveredBanks.length) blocks.push({ type: 'callout', tone: 'warning', title: 'Belum ada rekening koran', text: `Belum ada dokumen mutasi untuk bank ${uncoveredBanks.join(', ')}. Transaksinya belum diperiksa.` });
      this.assertResultSize(blocks);
      if (requestId) {
        const id = createHash('sha256').update(`${ownerId}:${sessionId ?? ''}:${requestId}`).digest('hex');
        await this.mongo.db.collection<Document & { _id: string }>('agent_bank_reconciliations').updateOne({ _id: id, ownerId, sessionId, requestId }, { $set: { selection, matches, totalIn, totalOut, transactionCount: transactions.length, createdAt: new Date() } }, { upsert: true });
      }
    } else {
      for (const account of accounts) {
        const rows = transactions.filter(transaction => transaction.accountId === account.id);
        blocks.push({ type: 'table', title: `${account.bankName} · ${account.accountNumber} — ${account.sourceAlias}`, columns: ['Tanggal', 'No. Faktur / Referensi', 'Customer / Pihak terkait', 'Kode Bank', 'Rekening Toko', 'Kategori', 'Jenis Transaksi', 'Uang Masuk (IDR)', 'Uang Keluar (IDR)', 'Keterangan', 'Input oleh'], rows: rows.map(transaction => [transaction.date, transaction.invoices.join(', ') || transaction.reference, transaction.customer, transaction.bankCode, transaction.accountNumber, transaction.category, transaction.method, transaction.moneyIn || null, transaction.moneyOut || null, transaction.description, transaction.inputBy]) });
        if (!rows.length) blocks.push({ type: 'text', variant: 'muted', text: `Tidak ada transaksi sesuai pilihan pada ${account.bankName} ${account.accountNumber}.` });
      }
    }
    this.assertResultSize(blocks);
    return { blocks, usedSources: selectedSources.filter(source => accounts.some(account => account.branchId === source.branchId)).map(({ alias, branchId }) => ({ alias, branchId })) };
  }

  private assertResultSize(blocks: AgentResponseBlock[]) {
    if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 10 * 1024 * 1024) throw new BadRequestException('Rincian laporan terlalu besar untuk satu percakapan. Persempit periode atau jumlah rekening; data tidak dipotong diam-diam.');
  }

  private coveredPeriod(documents: BankStatement[], from: string, to: string) {
    return [...new Set(documents.map(document => bankIdentity(document.bankName)))].every(groupKey => {
      let coveredThrough = Date.parse(from) - 86_400_000;
      for (const document of documents.filter(item => bankIdentity(item.bankName) === groupKey).sort((left, right) => left.from.localeCompare(right.from))) {
        const start = Date.parse(document.from), end = Date.parse(document.to);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        if (start <= coveredThrough + 86_400_000) coveredThrough = Math.max(coveredThrough, end);
      }
      return coveredThrough >= Date.parse(to);
    });
  }

  private async readTransactions(source: BankSource, accounts: BankAccount[], selection: BankSelection): Promise<BankTransaction[]> {
    const db = this.mongo.getDatabase(source.databaseName);
    const seen = new Set<string>(), result: BankTransaction[] = [];
    const existing: string[] = [];
    try {
      const masterAccounts = await db.collection('tm_rekening').find({}, { projection: { no_rekening: 1 }, maxTimeMS: 10_000 }).limit(2001).toArray();
      const storedAccountValues = masterAccounts.filter(row => accounts.some(account => account.accountNumber === accountIdentifier(decryptBankField(row.no_rekening)))).flatMap(row => typeof row.no_rekening === 'string' ? [row.no_rekening, decryptBankField(row.no_rekening)] : []);
      for (const collection of ['tt_cash_daily', 'th_cash_daily']) if (await db.listCollections({ name: collection }, { nameOnly: true }).hasNext()) existing.push(collection);
      if (!existing.length) throw new Error('missing cash collections');
      for (const collection of existing) {
        const match: Document = { tanggal: { $gte: selection.from, $lte: selection.to }, status: 'OPEN', no_rekening: { $in: [...new Set([...accounts.flatMap(account => variants(account.accountNumber)), ...storedAccountValues])] }, ...(selection.method === 'TRANSFER' ? { jenis: { $in: variants('TRANSFER') } } : { $and: [{ $or: [{ jenis: { $nin: ['CASH', 'BAYAR POIN', 'SALDO_AWAL_REKENNING'].flatMap(variants) } }, { kategori: { $in: ['TAMBAH UANG BANK', 'AMBIL UANG BANK'].flatMap(variants) } }] }] }), kategori: selection.category === 'ALL' ? { $nin: ['SALDO AWAL', 'SALDO_AWAL_REKENNING', 'SALDO AWAL REKENING'].flatMap(variants) } : { $in: variants(selection.category) }, $or: [{ jumlah_in: { $gt: 0 } }, { jumlah_out: { $gt: 0 } }] };
        const pipeline: Document[] = [{ $match: match }, { $sort: { tanggal: 1, _id: 1 } }, { $lookup: { from: 'tt_jual_detail', let: { group: '$deskripsi' }, pipeline: [{ $match: { $expr: { $eq: ['$no_faktur_group', '$$group'] } } }, { $project: { nama_customer: 1, no_faktur_jual: 1 } }], as: 'sale' } }, { $lookup: { from: 'tt_beli_detail', let: { group: '$deskripsi' }, pipeline: [{ $match: { $expr: { $eq: ['$no_faktur_group', '$$group'] } } }, { $project: { nama_customer: 1, no_faktur_beli: 1 } }], as: 'purchase' } }];
        const cursor = db.collection(collection).aggregate(pipeline, { maxTimeMS: 30_000, allowDiskUse: true, batchSize: 500 });
        try {
          for await (const row of cursor) {
            if (result.length >= 25_000) throw new BadRequestException('Data rekening melebihi 25.000 transaksi. Persempit periode; tidak ada hasil terpotong yang dinyatakan lengkap.');
            const number = accountIdentifier(decryptBankField(row.no_rekening));
            const account = accounts.find(item => item.accountNumber === number);
            if (!account) continue;
            const identity = `${source.branchId}:${String(row.no_reff || row._id)}:${number}:${row.tanggal}:${row.jumlah_in}:${row.jumlah_out}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const details: Document[] = [...(Array.isArray(row.sale) ? row.sale : []), ...(Array.isArray(row.purchase) ? row.purchase : [])];
            const cashDetails: Document[] = Array.isArray(row.detail_transaction) ? row.detail_transaction : [];
            const invoices = [...new Set([...(Array.isArray(row.no_faktur_list) ? row.no_faktur_list.filter((value: unknown): value is string => typeof value === 'string') : []), ...cashDetails.map(detail => String(detail.no_faktur ?? '')).filter(Boolean), ...details.map(detail => String(detail.no_faktur_jual ?? detail.no_faktur_beli ?? '')).filter(Boolean)])];
            result.push({ id: identity, branchId: source.branchId, sourceAlias: source.alias, accountId: account.id, bankCode: account.bankCode, bankName: account.bankName, accountNumber: number, date: String(row.tanggal), reference: String(row.no_reff || row.deskripsi || '—'), invoices, customer: [...new Set(details.map(detail => decryptBankField(detail.nama_customer)).filter(Boolean))].join(', ') || '—', category: text(row.kategori), method: text(row.jenis), description: text(row.keterangan), moneyIn: numeric(row.jumlah_in), moneyOut: numeric(row.jumlah_out), inputBy: text(row.input_by) });
          }
        } finally { await cursor.close(); }
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(`Transaksi ${source.alias} belum dapat dibaca lengkap. Coba lagi; sumber gagal tidak dianggap kosong.`);
    }
    return result;
  }

  private reconciliationBlocks(documents: BankStatement[], transactions: BankTransaction[], entries: BankStatement['entries'], results: ReturnType<typeof reconcileBankEntries>): AgentResponseBlock[] {
    const warnings = documents.flatMap(document => document.warnings);
    const label = documents[0].bankName;
    const blocks: AgentResponseBlock[] = [
      { type: 'text', variant: 'heading', text: label },
      { type: 'metric', label: 'Uang masuk di rekening koran', value: entries.filter(entry => entry.direction === 'IN').reduce((sum, entry) => sum + entry.amount, 0), unit: 'IDR', tone: 'teal' },
      { type: 'metric', label: 'Uang keluar di rekening koran', value: entries.filter(entry => entry.direction === 'OUT').reduce((sum, entry) => sum + entry.amount, 0), unit: 'IDR', tone: 'navy' },
      { type: 'metric', label: 'Transaksi cocok', value: results.filter(match => match.status === 'MATCHED').length, unit: 'data', tone: 'teal' },
      { type: 'metric', label: 'Perlu diperiksa', value: results.filter(match => match.status !== 'MATCHED').length, unit: 'data', tone: 'amber' },
    ];
    if (warnings.length) blocks.push({ type: 'callout', tone: 'warning', title: 'Periksa kelengkapan dokumen', text: [...new Set(warnings)].join(' ') });
    const statuses = { MATCHED: '✓ Cocok', REVIEW: 'Perlu dicek', SYSTEM_ONLY: 'Belum ditemukan di mutasi', BANK_ONLY: 'Belum ditemukan di program' };
    const transactionById = new Map(transactions.map(transaction => [transaction.id, transaction])), entryById = new Map(entries.map(entry => [entry.id, entry]));
    blocks.push({ type: 'table', title: `Hasil pemeriksaan ${label}`, columns: ['Tanggal', 'No. Faktur / Referensi', 'Customer / Pihak terkait', 'Toko', 'Kategori', 'Uang Masuk (IDR)', 'Uang Keluar (IDR)', 'Nominal Bank (IDR)', 'Status Pemeriksaan', 'Keterangan Transaksi', 'Keterangan Pemeriksaan', 'Input oleh'], rows: results.map(match => {
      const transaction = match.transactionId ? transactionById.get(match.transactionId) : undefined, entry = match.entryId ? entryById.get(match.entryId) : undefined;
      return [transaction?.date ?? entry?.date ?? '—', transaction?.invoices.join(', ') || transaction?.reference || entry?.reference || '—', transaction?.customer ?? '—', transaction?.sourceAlias ?? '—', transaction?.category ?? 'Mutasi bank', transaction?.moneyIn || (entry?.direction === 'IN' ? entry.amount : null), transaction?.moneyOut || (entry?.direction === 'OUT' ? entry.amount : null), entry?.amount ?? null, statuses[match.status], transaction?.description ?? entry?.description ?? '—', match.reason, transaction?.inputBy ?? '—'];
    }) });
    return blocks;
  }
}
