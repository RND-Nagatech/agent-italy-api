import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createPool, type Pool, type PoolConfig } from 'mariadb';
import { env } from '../config/env';
import { parseRdsEndpoint } from '../config/rds-options';
import { decryptBankField } from '../agent/banking.logic';

export type LegacyBarangMatch = { status: 'found'; internalCode: string } | { status: 'not-found' | 'ambiguous' | 'unreadable' | 'unavailable' | 'disabled' };
export type LegacyBarangLookup = { lookupMany(barcodes: string[]): Promise<Map<string, LegacyBarangMatch>> };
type LegacyRow = { kode_barcode: unknown; kode_intern: unknown };
const SAFE_ERROR_CODES = new Set(['ER_GET_CONNECTION_TIMEOUT', 'ER_CONNECTION_TIMEOUT', 'ER_SOCKET_TIMEOUT',
  'ER_TIMEOUT_NOT_SUPPORTED', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
  'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_QUERY_TIMEOUT', 'RDS_QUERY_TIMEOUT',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ER_SSL_NOT_SUPPORTED',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function safeFailureCodes(error: unknown): string {
  const codes: string[] = [], seen = new Set<object>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current) && seen.size < 4;) {
    seen.add(current);
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && SAFE_ERROR_CODES.has(item.code) && !codes.includes(item.code)) codes.push(item.code);
    current = item.cause;
  }
  return codes.join(' -> ') || 'UNKNOWN';
}

@Injectable()
export class LegacyBarangService implements LegacyBarangLookup, OnModuleDestroy {
  private pool?: Pool;
  private unavailableUntil = 0;
  private readonly logger = new Logger(LegacyBarangService.name);

  // The module supplies the default factory; offline checks can use a fake pool.
  constructor(private readonly poolFactory: (options: PoolConfig) => Pool = createPool, private readonly queryDeadlineMs = 5000) { }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = this.poolFactory({ ...parseRdsEndpoint(env.rds.url, env.rds.database), database: env.rds.database,
        user: env.rds.username, password: env.rds.password, connectionLimit: 4, minimumIdle: 0,
        connectTimeout: 5000, acquireTimeout: 6000, initializationTimeout: 6000, socketTimeout: 7000,
        idleTimeout: 60, multipleStatements: false, rowsAsArray: false });
      this.pool.on('error', error => this.markUnavailable(error));
    }
    return this.pool;
  }

  private markUnavailable(error: unknown) {
    if (Date.now() >= this.unavailableUntil) this.logger.warn(`Lookup barang lama MariaDB belum tersedia (kode: ${safeFailureCodes(error)}); koneksi dicoba kembali setelah jeda.`);
    this.unavailableUntil = Date.now() + 30000;
  }

  private async readRows(candidates: string[]): Promise<LegacyRow[]> {
    const connection = await this.getPool().getConnection();
    let deadline: ReturnType<typeof setTimeout> | undefined, expired = false;
    try {
      // Connector queryTimeout/timeout require MariaDB's max_statement_time and reject MySQL.
      // A client deadline closes an overdue connection on either server engine.
      return await Promise.race([
        connection.query<LegacyRow[]>({
          sql: `SELECT kode_barcode, kode_intern FROM tm_barang WHERE kode_barcode IN (${candidates.map(() => '?').join(',')}) LIMIT ?`,
        }, [...candidates, candidates.length * 2 + 1]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            expired = true;
            reject(Object.assign(new Error('Legacy item query deadline exceeded'), { code: 'RDS_QUERY_TIMEOUT' }));
            try { connection.destroy(); } catch { /* Already closed connections must not delay the timeout. */ }
          }, this.queryDeadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (!expired) await connection.release();
    }
  }

  async lookupMany(input: string[]): Promise<Map<string, LegacyBarangMatch>> {
    const barcodes = [...new Set(input.filter(value => value && value !== '-'))];
    const results = new Map<string, LegacyBarangMatch>();
    if (!env.rds.url || Date.now() < this.unavailableUntil) {
      for (const barcode of barcodes) results.set(barcode, { status: env.rds.url ? 'unavailable' : 'disabled' });
      return results;
    }
    for (let offset = 0; offset < barcodes.length; offset += 200) {
      const batch = barcodes.slice(offset, offset + 200);
      if (Date.now() < this.unavailableUntil) { for (const barcode of batch) results.set(barcode, { status: 'unavailable' }); continue; }
      try {
        // SQL can match padded legacy strings while returning their original trailing
        // spaces. Compare the same trimmed identity without removing leading zeroes,
        // casting numbers or guessing a nearby barcode.
        const candidates = [...new Set(batch.map(barcode => barcode.trim()))];
        const limit = candidates.length * 2 + 1;
        const rows = await this.readRows(candidates);
        for (const barcode of batch) {
          const matches = rows.filter(row => (typeof row.kode_barcode === 'string' || typeof row.kode_barcode === 'number' || typeof row.kode_barcode === 'bigint') && String(row.kode_barcode).trim() === barcode.trim());
          if (rows.length >= limit || matches.length > 1) { results.set(barcode, { status: 'ambiguous' }); continue; }
          if (!matches.length) { results.set(barcode, { status: 'not-found' }); continue; }
          const raw = typeof matches[0].kode_intern === 'string' ? matches[0].kode_intern.trim() : '';
          const internalCode = /^[A-Z]\d{1,2}(?:$|[\s./_-])|^[A-Z]{2,3}$|[G-Z]/i.test(raw) ? raw : decryptBankField(raw);
          results.set(barcode, !internalCode || internalCode === '-' || /^(?:[a-f0-9]{2}){4,}$/i.test(internalCode)
            ? { status: 'unreadable' } : { status: 'found', internalCode });
        }
      } catch (error) {
        this.markUnavailable(error);
        for (const barcode of batch) results.set(barcode, { status: 'unavailable' });
      }
    }
    return results;
  }

  async onModuleDestroy(): Promise<void> { if (this.pool) await this.pool.end(); }
}
