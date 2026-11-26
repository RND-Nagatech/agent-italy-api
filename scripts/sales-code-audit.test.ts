import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSalesCodeBatches } from '../src/agent/sales-code-audit.logic';
import { priceAuditScope } from '../src/agent/price-audit-scope';
import type { AuditTransaction, PriceReference, PriceRule } from '../src/agent/price-audit.logic';

const date = '2026-11-23';
const rule = (sourceCode: string, kadar: number, rate: number, fee: number | null = 20000): PriceRule => ({ family: kadar <= 60 ? 'young' : 'old', kind: 'sales', sourceCode, kadar, rate, maxRate: null, fee, feeType: fee === null ? 'unknown' : 'nominal', condition: 'ANY', note: '' });
const ref = (id: string, batch: number | null, rows: PriceRule[]): PriceReference => ({ id, date, batch, filename: `${id}.jpeg`, complete: true, warnings: [], rows });
const young1 = ref('muda1', 1, [rule('H04', 38, 798000, null)]);
const young2 = ref('muda2', 2, [rule('H04', 38, 804000, null)]);
const old1 = ref('tua1', 1, [rule('C5', 88, 1848000), rule('D7', 88, 1848000, 25000), rule('C6', 90, 1890000), rule('D8', 90, 1890000, 25000), rule('C8', 65, 1365000), rule('C8', 81, 1701000), rule('D3', 96, 2016000, 25000)]);
// Synthetic sales batch for testing. The supplied fourth image is BUYBACK,
// not evidence for any old-gold sales price in Batch 2.
const old2 = ref('synthetic-tua2', 2, [rule('C5', 88, 1861000), rule('D7', 88, 1861000, 25000)]);
const tx = (internalCode: string, kadar: number, pricePerGram: number, fee = 40000): AuditTransaction => ({ id: 'sale', kind: 'sales', store: 'Italy Pusat', date, time: '', invoice: 'J1', name: 'Cincin', internalCode, kadar, kadarSource: 'Detail transaksi', printedKadar: '750', barcode: '11256038', pricePerGram, fee, weight: 1.71, quantity: 1, price: 99999999, condition: '', inputBy: 'Kasir' });

test('sales references select daily code/batch mode without any hour form', () => {
  const scope = priceAuditScope('cek transaksi penjualan dengan file ini', [young1, young2, old1]);
  assert.equal(scope.needsTime, false); assert.equal(scope.salesAutoBatch, true); assert.equal(scope.selection?.salesAutoBatch, true);
  assert.equal(scope.selection?.windows[0].fromTime, '00:00'); assert.equal(scope.selection?.windows[0].toTime, '24:00');
});
test('actual H04 sales prices 798/804 identify their header batch, not the buyback prices 790/795', () => {
  const buyback = ref('misnamed-harga-emas', 2, [{ ...rule('H04', 38, 795000), kind: 'buyback' }]);
  for (const [price, batch] of [[798000, 1], [804000, 2]] as const) {
    const result = auditSalesCodeBatches(tx('H04 8', 38, price), [buyback, young2, old1, young1]);
    assert.equal(result.batch, `Batch ${batch}`); assert.equal(result.actualRate, price); assert.equal(result.priceStatus, 'Cocok');
    assert.equal(result.feeStatus, 'Belum dapat diperiksa', 'blank young-gold ongkos is not assumed zero');
    assert.doesNotMatch(result.reference, /misnamed/);
  }
  const wrongPrice = auditSalesCodeBatches(tx('H04 8', 38, 795000), [buyback, young1, young2]);
  assert.equal(wrongPrice.batch, 'Tidak teridentifikasi'); assert.equal(wrongPrice.status, 'Tidak cocok');
});
test('code distinguishes same-grade C5/D7 and C6/D8 fees, with whole-gram billing', () => {
  for (const [code, grade, price, fee] of [['C5', 88, 1848000, 40000], ['D7', 88, 1848000, 50000], ['C6', 90, 1890000, 40000], ['D8', 90, 1890000, 50000]] as const) {
    const result = auditSalesCodeBatches(tx(`${code} 16`, grade, price, fee), code === 'C5' || code === 'D7' ? [old1, old2] : [old1]);
    assert.equal(result.code, code); assert.equal(result.batch, 'Batch 1'); assert.equal(result.expectedFee, fee); assert.equal(result.billedWeight, 2); assert.equal(result.status, 'Cocok');
  }
});
test('wrong invoice grade and incorrect fee remain discrepancies even after the batch is known', () => {
  const grade = auditSalesCodeBatches(tx('C6 16', 88, 1890000), [old1]);
  assert.equal(grade.batch, 'Batch 1'); assert.equal(grade.priceStatus, 'Tidak cocok'); assert.match(grade.reason, /kadar barang.*88/);
  const fee = auditSalesCodeBatches(tx('D8 16', 90, 1890000, 40000), [old1]);
  assert.equal(fee.batch, 'Batch 1'); assert.equal(fee.feeDifference, -10000); assert.equal(fee.status, 'Tidak cocok');
});
test('prices never switch to another internal code or derive the price from the total', () => {
  const wrong = auditSalesCodeBatches(tx('C5 16', 88, 2016000), [old1]);
  assert.equal(wrong.batch, 'Tidak teridentifikasi'); assert.equal(wrong.expectedRate, null); assert.equal(wrong.status, 'Tidak cocok');
  const missing = auditSalesCodeBatches({ ...tx('C5', 88, 1848000), pricePerGram: null }, [old1]);
  assert.equal(missing.status, 'Belum dapat diperiksa'); assert.match(missing.reason, /harga_gram/);
});
test('same repeated code C8 is checked against the invoice grade after matching the code and batch', () => {
  const correct = auditSalesCodeBatches(tx('C8 16', 81, 1701000), [old1]);
  assert.equal(correct.status, 'Cocok'); assert.equal(correct.referenceKadar, 81);
  const wrong = auditSalesCodeBatches(tx('C8 16', 65, 1701000), [old1]);
  assert.equal(wrong.priceStatus, 'Tidak cocok'); assert.equal(wrong.referenceKadar, 81);
});
test('missing master code stays unverified even when the grade and price match', () => {
  const result = auditSalesCodeBatches({ ...tx('-', 88, 1848000), lookupNote: 'Barang tidak ditemukan di tm_barang.' }, [old1]);
  assert.equal(result.status, 'Belum dapat diperiksa'); assert.equal(result.internalCode, '-'); assert.equal(result.batch, 'Tidak diketahui'); assert.equal(result.actualRate, 1848000);
  assert.match(result.reason, /tidak ditemukan/);
});
test('batch is not chosen by matching the observed fee when both batches share a price', () => {
  const other = ref('same-price-other-fee', 2, [rule('C5', 88, 1848000, 25000)]);
  const result = auditSalesCodeBatches(tx('C5', 88, 1848000, 40000), [old1, other]);
  assert.equal(result.batch, 'Batch 1 / 2 — belum pasti'); assert.equal(result.status, 'Belum dapat diperiksa');
  assert.equal(result.feeStatus, 'Belum dapat diperiksa'); assert.equal(result.expectedFee, null);
});
test('batch identity uses exact harga_gram, ignores invoice timestamps, and does not widen by sales tolerance', () => {
  assert.equal(auditSalesCodeBatches(tx('H04', 38, 804000), [young1, young2], 10000).batch, 'Batch 2');
  assert.equal(auditSalesCodeBatches(tx('H04', 38, 800000), [young1, young2], 10000).batch, 'Tidak teridentifikasi');
  assert.equal(auditSalesCodeBatches({ ...tx('C5', 88, 1848000), time: '23:59:59' }, [old1]).batch, 'Batch 1');
  const otherDate = { ...old2, date: '2026-11-24' };
  assert.equal(auditSalesCodeBatches(tx('C5', 88, 1861000), [old1, otherDate]).batch, 'Tidak teridentifikasi');
});
test('an unreadable header batch cannot identify a batch from the filename or matching amount', () => {
  const result = auditSalesCodeBatches(tx('C5', 88, 1848000), [{ ...old1, batch: null, filename: 'BATCH-2.jpeg' }]);
  assert.equal(result.batch, 'Tidak diketahui'); assert.equal(result.status, 'Belum dapat diperiksa');
});
test('a companion batch lacking the required code prevents a false assertion of a unique batch', () => {
  const result = auditSalesCodeBatches(tx('C6', 90, 1890000), [old1, old2]);
  assert.equal(result.batch, 'Batch 1 — belum pasti'); assert.equal(result.status, 'Belum dapat diperiksa');
  assert.match(result.batchReason!, /belum lengkap/);
});
