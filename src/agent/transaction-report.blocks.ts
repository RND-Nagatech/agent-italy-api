import type { AgentResponseBlock } from './response-blocks';

type UnknownRecord = Record<string, unknown>;
type NonCashMethod = 'DEBET' | 'CREDIT' | 'TRANSFER';

const NON_CASH_METHODS: NonCashMethod[] = ['DEBET', 'CREDIT', 'TRANSFER'];
const NON_CASH_METHOD_LABELS: Record<NonCashMethod, string> = {
  DEBET: 'Debet',
  CREDIT: 'Credit',
  TRANSFER: 'Transfer',
};

const REPORT_TYPE_LABELS: Record<string, string> = {
  authorization_sales: 'Rincian Otorisasi Penjualan',
  sales_non_cash: 'Laporan Penjualan Non-Cash',
  online_marketplace_price: 'Harga Online Marketplace',
  purchase_damaged_condition: 'Data - Rongsok Pembelian',
  login_activity: 'Login Akun Hari Ini',
};

/**
 * Build transaction-report tables from trusted backend output.
 * The model may still provide a short narrative, but it cannot change the
 * shape of these detail tables into inline prose.
 */
export function transactionReportBlocks(result: UnknownRecord): AgentResponseBlock[] {
  const reportType = stringValue(result.reportType) ?? '';
  const title = stringValue(result.title) ?? REPORT_TYPE_LABELS[reportType] ?? 'Laporan transaksi';
  const period = isRecord(result.period) ? result.period : {};
  const from = stringValue(period.from);
  const to = stringValue(period.to);
  const sources = Array.isArray(result.sources) ? result.sources.filter(isRecord) : [];
  const blocks: AgentResponseBlock[] = [{ type: 'text', text: title, variant: 'heading' }];
  if (from && to) blocks.push({ type: 'text', text: `Periode ${from} s/d ${to} (inklusif, Asia/Jakarta).`, variant: 'muted' });

  const availableSources = sources.filter((source) => source.status === 'available');
  const unavailableSources = sources.filter((source) => source.status !== 'available');
  if (!availableSources.length) {
    blocks.push({
      type: 'callout',
      tone: 'critical',
      title: 'Data belum dapat dibaca',
      text: unavailableSources.length
        ? `Sumber ${unavailableSources.map(sourceLabel).join(', ')} tidak tersedia atau pembacaannya gagal. Angka nol tidak boleh ditafsirkan sebagai tidak ada transaksi.`
        : 'Tidak ada sumber data yang tersedia untuk laporan ini.',
    });
    return blocks;
  }

  if (reportType === 'purchase_damaged_condition') {
    addPurchaseBlocks(blocks, availableSources);
  } else if (reportType === 'authorization_sales') {
    addAuthorizationBlocks(blocks, availableSources);
  } else if (reportType === 'sales_non_cash') {
    addNonCashBlocks(blocks, availableSources, result);
  } else if (reportType === 'online_marketplace_price') {
    addMarketplaceBlocks(blocks, availableSources);
  } else if (reportType === 'login_activity') {
    addLoginActivityBlocks(blocks, availableSources);
  }

  if (unavailableSources.length) {
    blocks.push({
      type: 'callout',
      tone: 'warning',
      title: 'Sebagian sumber tidak tersedia',
      text: `${unavailableSources.map(sourceLabel).join(', ')} tidak ikut dihitung karena koleksi tidak tersedia atau pembacaan gagal/melewati batas waktu.`,
    });
  }
  return blocks;
}

function addPurchaseBlocks(blocks: AgentResponseBlock[], sources: UnknownRecord[]) {
  const allRows = sources.flatMap((source) => rowsOf(source));
  const totalHargaBeli = allRows.reduce((sum, row) => sum + numberValue(row.harga_beli), 0);
  const totalHargaNota = allRows.reduce((sum, row) => sum + numberValue(row.harga_nota), 0);
  blocks.push(
    metric('Total baris', allRows.length, 'baris', 'teal'),
    metric('Total harga beli', totalHargaBeli, 'IDR', 'navy'),
    metric('Total harga nota', totalHargaNota, 'IDR', 'violet'),
  );
  for (const source of sources) {
    const rows = rowsOf(source);
    blocks.push({
      type: 'table',
      title: `Data ${sourceLabel(source)}`,
      columns: ['No. Faktur', 'Barcode', 'Kondisi', 'Harga Nota (IDR)', 'Harga Beli (IDR)', 'Input oleh'],
      rows: rows.map((row) => [
        cell(row.no_faktur_beli),
        cell(row.kode_barcode),
        cell(row.kondisi),
        numberCell(row.harga_nota),
        numberCell(row.harga_beli),
        cell(row.input_by),
      ]),
    });
  }
}

function addAuthorizationBlocks(blocks: AgentResponseBlock[], sources: UnknownRecord[]) {
  for (const source of sources) {
    const rows = rowsOf(source);
    blocks.push({
      type: 'table',
      title: `Data ${sourceLabel(source)}`,
      columns: ['Tanggal', 'No. Faktur', 'Barcode', 'Keterangan', 'Deskripsi', 'Berat Awal (gram)', 'Berat (gram)', 'Input oleh'],
      rows: rows.map((row) => [
        dateOnlyCell(row.datetime),
        cell(row.no_faktur),
        cell(row.kode_barcode),
        cell(row.keterangan),
        cell(row.description),
        numberCell(row.berat_awal),
        numberCell(row.berat),
        cell(row.input_by),
      ]),
    });
  }
}

function addNonCashBlocks(blocks: AgentResponseBlock[], sources: UnknownRecord[], result: UnknownRecord) {
  const allRows = sources.flatMap((source) => rowsOf(source));
  const grandTotal = allRows.reduce((sum, row) => sum + numberValue(row.grand_total_transaksi), 0);
  const filters = isRecord(result.filters) ? result.filters : {};
  const requestedMethod = stringValue(filters.paymentMethod);
  const selectedMethod = requestedMethod && NON_CASH_METHODS.includes(requestedMethod as NonCashMethod)
    ? requestedMethod as NonCashMethod
    : undefined;
  const methodTotals = allRows.reduce<Record<NonCashMethod, number>>((totals, row) => {
    const payments = paymentTotals(row.pembayaran);
    for (const method of NON_CASH_METHODS) totals[method] += payments[method];
    return totals;
  }, { DEBET: 0, CREDIT: 0, TRANSFER: 0 });
  const totalLebihBayarTransfer = allRows.reduce((sum, row) => sum + numberValue(row.lebih_bayar_transfer), 0);
  blocks.push(metric('Grand total transaksi', grandTotal, 'IDR', 'navy'));
  const totalNonCash = NON_CASH_METHODS.reduce((sum, method) => sum + methodTotals[method], 0);
  if (selectedMethod) {
    blocks.push(metric(`Total ${NON_CASH_METHOD_LABELS[selectedMethod]}`, methodTotals[selectedMethod], 'IDR', 'teal'));
  } else {
    blocks.push(metric('Total non-cash', totalNonCash, 'IDR', 'teal'));
    for (const method of NON_CASH_METHODS) {
      if (methodTotals[method] > 0) blocks.push(metric(NON_CASH_METHOD_LABELS[method], methodTotals[method], 'IDR', 'violet'));
    }
  }
  const showTransferReturn = totalLebihBayarTransfer > 0
    && (selectedMethod === 'TRANSFER' || (!selectedMethod && methodTotals.TRANSFER > 0));
  if (showTransferReturn) blocks.push(metric('Total lebih bayar transfer', totalLebihBayarTransfer, 'IDR', 'amber'));
  const methodsToShow = selectedMethod ? [selectedMethod] : NON_CASH_METHODS.filter((method) => methodTotals[method] > 0);
  for (const source of sources) {
    const rows = rowsOf(source);
    blocks.push({
      type: 'table',
      title: `Data ${sourceLabel(source)}`,
      columns: [
        'No. Faktur',
        'Barcode',
        'Grand Total Transaksi (IDR)',
        ...methodsToShow.map((method) => `${NON_CASH_METHOD_LABELS[method]} (IDR)`),
        ...(showTransferReturn ? ['Lebih Bayar Transfer (IDR)'] : []),
        'Input oleh',
      ],
      rows: rows.map((row) => {
        const payments = paymentTotals(row.pembayaran);
        return [
          cell(Array.isArray(row.no_faktur_list) ? row.no_faktur_list.filter((value) => typeof value === 'string' && value.trim()).join(', ') : row.no_faktur),
          cell(Array.isArray(row.kode_barcode) ? row.kode_barcode.join(', ') : row.kode_barcode),
          numberCell(row.grand_total_transaksi),
          ...methodsToShow.map((method) => positiveNumberCell(payments[method])),
          ...(showTransferReturn ? [positiveNumberCell(row.lebih_bayar_transfer)] : []),
          cell(row.input_by),
        ];
      }),
    });
  }
}

function addMarketplaceBlocks(blocks: AgentResponseBlock[], sources: UnknownRecord[]) {
  const allRows = sources.flatMap((source) => rowsOf(source));
  const totalFinal = allRows.reduce((sum, row) => sum + numberValue(row.harga_online_final), 0);
  blocks.push(metric('Total harga online (semua toko)', totalFinal, 'IDR', 'navy'));
  for (const source of sources) {
    const sourceTotal = rowsOf(source).reduce((sum, row) => sum + numberValue(row.harga_online_final), 0);
    blocks.push(metric(`Total harga online — ${sourceLabel(source)}`, sourceTotal, 'IDR', 'teal'));
  }
  for (const source of sources) {
    const rows = rowsOf(source);
    blocks.push({
      type: 'table',
      title: `Data ${sourceLabel(source)}`,
      columns: ['No. Faktur Utama', 'Marketplace', 'Harga Jual (IDR)', 'Ongkos (IDR)', 'Biaya Admin (IDR)', 'Packing (IDR)', 'Plastik Bening (IDR)', 'Total Harga Online (IDR)', 'Lebih Bayar (IDR)', 'Input oleh'],
      rows: rows.map((row) => [
        cell(row.no_faktur_utama),
        cell(row.kode_marketplace),
        numberCell(row.harga_jual_barang),
        numberCell(row.ongkos_barang),
        numberCell(row.biaya_admin),
        numberCell(row.harga_packing_nota),
        numberCell(row.harga_plastik_bening_nota),
        numberCell(row.harga_online_final),
        numberCell(row.lebih_bayar),
        cell(row.input_by),
      ]),
    });
  }
}

function addLoginActivityBlocks(blocks: AgentResponseBlock[], sources: UnknownRecord[]) {
  for (const source of sources) {
    const rows = rowsOf(source);
    blocks.push({
      type: 'table',
      title: `Data ${sourceLabel(source)}`,
      columns: ['User ID', 'Status Login', 'Login Terakhir'],
      rows: rows.map((row) => [
        cell(row.user_id),
        cell(row.status_login),
        dateTimeCell(row.login_terakhir),
      ]),
    });
  }
}

function metric(label: string, value: number, unit: string, tone: 'navy' | 'teal' | 'amber' | 'violet'): AgentResponseBlock {
  return { type: 'metric', label, value, unit, tone };
}

function paymentTotals(value: unknown): Record<NonCashMethod, number> {
  const totals: Record<NonCashMethod, number> = { DEBET: 0, CREDIT: 0, TRANSFER: 0 };
  if (!Array.isArray(value)) return totals;
  for (const payment of value) {
    if (!isRecord(payment)) continue;
    const method = stringValue(payment.metode);
    if (method && NON_CASH_METHODS.includes(method as NonCashMethod)) {
      totals[method as NonCashMethod] += numberValue(payment.nominal);
    }
  }
  return totals;
}

function rowsOf(source: UnknownRecord): UnknownRecord[] {
  return Array.isArray(source.rows) ? source.rows.filter(isRecord) : [];
}

function sourceLabel(source: UnknownRecord): string {
  const alias = stringValue(source.alias) ?? stringValue(source.branchId) ?? 'Sumber tidak dikenal';
  const branchId = stringValue(source.branchId);
  return branchId && branchId !== alias ? `${alias} (${branchId})` : alias;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberCell(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumberCell(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function cell(value: unknown): string | number | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function dateOnlyCell(value: unknown): string | number | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return cell(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateTimeCell(value: unknown): string | number | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return cell(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(parsed).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
