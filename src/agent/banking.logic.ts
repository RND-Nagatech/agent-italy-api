import { env } from '../config/env';
import { decryptLegacyAscii, encryptLegacyAscii } from '../config/legacy-ascii';
import type { BankEntry, BankMatch, BankTransaction } from './banking.types';

export function encryptBankField(value: string): string {
  return encryptLegacyAscii(value, env.encKeyDec);
}

export function decryptBankField(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim(), key = env.encKeyDec;
  if (!key || !/^(?:[0-9a-f]{2})+$/i.test(text)) return text;
  const result = decryptLegacyAscii(text, key);
  if (!result || !result.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(result)) return text;
  return encryptBankField(result) === text.toUpperCase() ? result.trim() : text;
}

export const accountDigits = (value: string) => value.replace(/[\s.-]/g, '');
/** Legacy no_rekening can be a code (BCA, TIKTOK, BCA-01), not just a bank account number. */
export function accountIdentifier(value: string): string {
  const identifier = value.trim();
  return /^[\d\s.-]+$/.test(identifier) ? accountDigits(identifier) : identifier;
}
export function isValidAccountIdentifier(value: string): boolean {
  const identifier = accountIdentifier(value);
  return /^[0-9]{5,40}$/.test(identifier) || /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/.test(identifier);
}
export function bankIdentity(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  if (/\bBCA\b|BANK CENTRAL ASIA/.test(normalized)) return 'BCA';
  if (/MANDIRI/.test(normalized)) return 'MANDIRI';
  if (/\bBRI\b|BANK RAKYAT INDONESIA/.test(normalized)) return 'BRI';
  if (/\bBNI\b|BANK NEGARA INDONESIA/.test(normalized)) return 'BNI';
  if (/\bBSI\b|BANK SYARIAH INDONESIA/.test(normalized)) return 'BSI';
  return normalized.replace(/^PT\s+/, '').replace(/^BANK\s+/, '');
}
export const moneyCents = (value: number) => Math.round(value * 100);
export const validBankDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Parse printed currency text without treating Indonesian thousand separators as decimals. */
export function parseBankAmountText(text: string, fallback: number): number {
  const value = text.trim().replace(/\s/g, '').replace(/^(?:Rp|IDR)/i, '').replace(/[^\d.,+-]/g, '');
  if (!value || !/\d/.test(value)) return fallback;
  let normalized = value;
  if (/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(value)) normalized = value.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value)) normalized = value.replace(/,/g, '');
  else if (/^[+-]?\d{1,3}(?:[.,]\d{3})+$/.test(value)) normalized = value.replace(/[.,]/g, '');
  else if (/^[+-]?\d+[,.]\d{1,2}$/.test(value)) normalized = value.replace(',', '.');
  else normalized = value.replace(/[.,]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** CR is money into the statement account; DB is money leaving it. */
export function bankDirectionFromMarker(value: string): 'IN' | 'OUT' | null {
  const normalized = value.toUpperCase();
  if (/(?:^|\b)(?:CR|CREDIT)(?:\b|$)/.test(normalized)) return 'IN';
  if (/(?:^|\b)(?:DB|DEBIT)(?:\b|$)/.test(normalized)) return 'OUT';
  return null;
}

/** Matching is deterministic and bidirectional. A statement entry can never settle two payments. */
export function reconcileBankEntries(transactions: BankTransaction[], entries: BankEntry[], complete: boolean): BankMatch[] {
  const key = (direction: string, amount: number, date: string) => `${direction}:${moneyCents(amount)}:${date}`;
  const dateAmountKey = (amount: number, date: string) => `${moneyCents(amount)}:${date}`;
  const dateDirectionKey = (direction: string, date: string) => `${direction}:${date}`;
  const directionOf = (transaction: BankTransaction) => transaction.moneyIn > 0 && transaction.moneyOut === 0 ? 'IN' : transaction.moneyOut > 0 && transaction.moneyIn === 0 ? 'OUT' : 'UNKNOWN';
  const bankBuckets = new Map<string, BankEntry[]>();
  const entriesByDateAmount = new Map<string, BankEntry[]>();
  const entriesByDateDirection = new Map<string, BankEntry[]>();
  for (const entry of entries) {
    const bucket = key(entry.direction, entry.amount, entry.date);
    const items = bankBuckets.get(bucket) ?? [];
    items.push(entry);
    bankBuckets.set(bucket, items);
    const amountDateBucket = dateAmountKey(entry.amount, entry.date);
    const sameDateAmount = entriesByDateAmount.get(amountDateBucket) ?? [];
    sameDateAmount.push(entry);
    entriesByDateAmount.set(amountDateBucket, sameDateAmount);
    const directionDateBucket = dateDirectionKey(entry.direction, entry.date);
    const sameDateDirection = entriesByDateDirection.get(directionDateBucket) ?? [];
    sameDateDirection.push(entry);
    entriesByDateDirection.set(directionDateBucket, sameDateDirection);
  }
  const used = new Set<string>(), resolved = new Map<string, BankMatch>(), reviewEntries = new Set<string>(), ambiguousTransactions = new Set<string>();
  // A match depends only on direction, date, and amount within the selected store/bank scope.
  for (const transaction of transactions) {
    const bucket = key(directionOf(transaction), transaction.moneyIn || transaction.moneyOut, transaction.date);
    const candidates = (bankBuckets.get(bucket) ?? []).filter(entry => !used.has(entry.id));
    const competingTransactions = transactions.filter(other => key(directionOf(other), other.moneyIn || other.moneyOut, other.date) === bucket);
    if (complete && directionOf(transaction) !== 'UNKNOWN' && candidates.length === 1 && competingTransactions.length === 1) {
      const chosen = candidates[0];
      used.add(chosen.id);
      resolved.set(transaction.id, { transactionId: transaction.id, entryId: chosen.id, status: 'MATCHED', reason: 'Tanggal, nominal, dan status uang masuk/keluar cocok; hanya ada satu pasangan pada bank dan toko yang dipilih.' });
    } else if (directionOf(transaction) !== 'UNKNOWN' && candidates.length > 0 && (candidates.length > 1 || competingTransactions.length > 1)) {
      ambiguousTransactions.add(transaction.id);
      for (const candidate of candidates) reviewEntries.add(candidate.id);
    }
  }
  for (const transaction of transactions) {
    if (resolved.has(transaction.id)) continue;
    let possible = false;
    for (let offset = -3; offset <= 3; offset++) {
      if (offset === 0) continue;
      const date = new Date(Date.parse(transaction.date) + offset * 86_400_000).toISOString().slice(0, 10);
      const bucket = key(directionOf(transaction), transaction.moneyIn || transaction.moneyOut, date);
      for (const entry of bankBuckets.get(bucket) ?? []) {
        if (used.has(entry.id)) continue;
        possible = true;
        reviewEntries.add(entry.id);
      }
    }
    const amount = transaction.moneyIn || transaction.moneyOut;
    const sameDateAmount = (entriesByDateAmount.get(dateAmountKey(amount, transaction.date)) ?? []).filter(entry => !used.has(entry.id));
    const directionConflict = sameDateAmount.filter(entry => entry.direction !== directionOf(transaction));
    const sameDateDirection = (entriesByDateDirection.get(dateDirectionKey(directionOf(transaction), transaction.date)) ?? []).filter(entry => !used.has(entry.id) && moneyCents(entry.amount) !== moneyCents(amount));
    for (const entry of [...directionConflict, ...sameDateDirection]) reviewEntries.add(entry.id);
    const hasDirectionConflict = directionConflict.length > 0;
    const hasAmountConflict = sameDateDirection.length > 0;
    const needsReview = possible || hasDirectionConflict || hasAmountConflict || ambiguousTransactions.has(transaction.id) || !complete || directionOf(transaction) === 'UNKNOWN';
    const reason = !complete ? 'Dokumen belum lengkap; pasangan belum disahkan.'
      : ambiguousTransactions.has(transaction.id) ? 'Tanggal, nominal, dan status uang masuk/keluar cocok dengan lebih dari satu mutasi. Periksa kemungkinan data ganda.'
      : possible ? 'Nominal dan status uang masuk/keluar cocok, tetapi tanggal mutasi berbeda. Periksa tanggal.'
      : hasDirectionConflict ? 'Tanggal dan nominal sama, tetapi satu data tercatat sebagai uang masuk dan data lainnya sebagai uang keluar.'
      : hasAmountConflict ? 'Tanggal dan status uang masuk/keluar cocok, tetapi nominalnya berbeda.'
      : 'Belum ditemukan pasangan dengan tanggal, nominal, dan status uang masuk/keluar yang sama.';
    resolved.set(transaction.id, { transactionId: transaction.id, entryId: null, status: needsReview ? 'REVIEW' : 'SYSTEM_ONLY', reason });
  }
  const matches = transactions.map(transaction => resolved.get(transaction.id)!);
  for (const entry of entries) if (!used.has(entry.id)) matches.push({ transactionId: null, entryId: entry.id, status: entry.direction === 'UNKNOWN' || !complete || reviewEntries.has(entry.id) ? 'REVIEW' : 'BANK_ONLY', reason: entry.direction === 'UNKNOWN' ? 'Belum jelas apakah mutasi ini uang masuk atau uang keluar.' : 'Belum ditemukan transaksi dengan tanggal, nominal, dan status uang masuk/keluar yang sama.' });
  return matches;
}
