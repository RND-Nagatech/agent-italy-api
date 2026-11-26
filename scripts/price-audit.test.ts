import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditPriceTransaction, moneyWeight, roundedPerGramFee, resolveReferenceKadar, validatePriceWindows, type AuditTransaction, type PriceReference, type PriceRule } from '../src/agent/price-audit.logic';
import { explicitPriceHours, priceAuditScope } from '../src/agent/price-audit-scope';

const window = { date: '2026-11-20', fromTime: '09:00', toTime: '11:00', attachmentIds: ['one'] };
const rule: PriceRule = { family: 'old', kind: 'sales', kadar: 75, sourceCode: 'A1', rate: 1542000, maxRate: null, fee: 5000, feeType: 'nominal', condition: 'ANY', note: '' };
const ref = (rows: PriceRule[], complete = true): PriceReference => ({ id: 'one', filename: 'harga.png', date: window.date, complete, warnings: [], rows });
const tx: AuditTransaction = { id: '1', kind: 'sales', store: 'Italy Pusat', date: window.date, time: '10:59:59', invoice: 'J1', name: 'Cincin', kadar: 75, weight: 2, price: 3084000, pricePerGram: 1542000, fee: 10000, quantity: 1, condition: '', inputBy: 'Kasir' };

test('accepts adjacent intervals, rejects overlaps and invalid calendar/time ranges', () => {
  assert.equal(validatePriceWindows([window, { ...window, fromTime: '11:00', toTime: '24:00' }]), null);
  assert.match(validatePriceWindows([window, { ...window, fromTime: '10:00', toTime: '12:00' }])!, /bertumpuk/);
  assert.ok(validatePriceWindows([{ ...window, date: '2026-02-30' }]));
  assert.ok(validatePriceWindows([{ ...window, fromTime: '11:00' }]));
  assert.ok(validatePriceWindows([{ ...window, toTime: '25:00' }]));
});
test('uses file price per gram directly without multiplying kadar a second time', () => {
  const result = auditPriceTransaction(tx, window, [ref([rule])]);
  assert.equal(result.status, 'Cocok'); assert.equal(result.expectedRate, 1542000); assert.equal(result.actualRate, 1542000);
});
test('matches stored price per gram from image then verifies invoice snapshot kadar', () => {
  const imageRate = { ...rule, kadar: 90, rate: 1850000, fee: 25000 };
  const invoice = { ...tx, kadar: 85, weight: 2, price: 3700000, pricePerGram: 1850000, fee: 50000 };
  const mismatch = auditPriceTransaction(invoice, window, [ref([imageRate])]);
  assert.equal(mismatch.expectedRate, 1850000);
  assert.equal(mismatch.referenceKadar, 90);
  assert.equal(mismatch.status, 'Tidak cocok');
  assert.match(mismatch.reason, /acuan kadar 90.*kadar barang.*85/);
  assert.equal(mismatch.expectedFee, 50000);
  const verified = auditPriceTransaction({ ...invoice, kadar: 90 }, window, [ref([imageRate])]);
  assert.equal(verified.status, 'Cocok');
  assert.equal(verified.expectedRate, 1850000);
  assert.equal(verified.expectedFee, 50000);
});
test('fee is always per gram, including quantity, with no selectable basis', () => {
  assert.equal(auditPriceTransaction(tx, window, [ref([rule])]).status, 'Cocok');
  assert.equal(auditPriceTransaction({ ...tx, quantity: 2, fee: 20000 }, window, [ref([rule])]).status, 'Cocok');
  const result = auditPriceTransaction({ ...tx, fee: 3000 }, window, [ref([rule])]);
  assert.equal(result.status, 'Tidak cocok'); assert.equal(result.feeDifference, -7000); assert.match(result.reason, /Ongkos lebih rendah/);
});
test('kadar 79 rounds 2.980 grams up to 3 grams for the 20,000 fee', () => {
  const grade79 = { ...rule, kadar: 79, rate: 1624000, fee: 20000 };
  const result = auditPriceTransaction({ ...tx, id: '11249980', kadar: 79, weight: 2.98, price: 4840000, pricePerGram: 1624000, fee: 60000 }, window, [ref([grade79])]);
  assert.equal(result.status, 'Cocok'); assert.equal(result.weight, 2.98); assert.equal(result.billedWeight, 3); assert.equal(result.expectedFeeUnrounded, 59600); assert.equal(result.expectedFee, 60000); assert.equal(result.feeDifference, 0);
  assert.match(result.reason, /menjadi 3 gram/); assert.match(result.reason, /60\.000/);
  const low = auditPriceTransaction({ ...tx, kadar: 79, weight: 2.98, price: 4840000, pricePerGram: 1624000, fee: 59600 }, window, [ref([grade79])]);
  assert.equal(low.status, 'Tidak cocok'); assert.equal(low.feeDifference, -400);
});
test('fee uses whole grams rounded up per item, preserving original weight and currency precision', () => {
  assert.deepEqual(roundedPerGramFee(20000, 3), { raw: 60000, rounded: 60000, billedWeight: 3 });
  assert.deepEqual(roundedPerGramFee(30000, 2.09), { raw: 62700, rounded: 90000, billedWeight: 3 });
  assert.deepEqual(roundedPerGramFee(20000, 0.69), { raw: 13800, rounded: 20000, billedWeight: 1 });
  assert.deepEqual(roundedPerGramFee(5000, 0.200001), { raw: 1000.005, rounded: 5000, billedWeight: 1 });
  assert.deepEqual(roundedPerGramFee(1250, 1.71), { raw: 2137.5, rounded: 2500, billedWeight: 2 }, 'does not round the monetary result to Rp1,000');
  assert.deepEqual(roundedPerGramFee(20000, 1.01, 2), { raw: 40400, rounded: 80000, billedWeight: 4 });
  assert.deepEqual(roundedPerGramFee(20000, 1.000001), { raw: 20000.02, rounded: 40000, billedWeight: 2 });
  assert.deepEqual(roundedPerGramFee(0, 2.98), { raw: 0, rounded: 0, billedWeight: 3 });
  assert.equal(roundedPerGramFee(-20, 2), null);
});
test('user example: 1.71 grams bills 2 grams, so 40,000 matches and 35,000 is low', () => {
  const r = { ...rule, fee: 20000 };
  const correct = auditPriceTransaction({ ...tx, weight: 1.71, fee: 40000 }, window, [ref([r])]);
  assert.equal(correct.status, 'Cocok'); assert.equal(correct.weight, 1.71); assert.equal(correct.billedWeight, 2); assert.equal(correct.expectedFee, 40000);
  assert.match(correct.reason, /1,71 gram dibulatkan ke atas menjadi 2 gram/); assert.doesNotMatch(correct.reason, /kelipatan Rp1\.000/);
  const low = auditPriceTransaction({ ...tx, weight: 1.71, fee: 35000 }, window, [ref([r])]);
  assert.equal(low.status, 'Tidak cocok'); assert.equal(low.feeDifference, -5000);
});
test('does not choose a fee from duplicate kadar by matching the observed fee', () => {
  const result = auditPriceTransaction(tx, window, [ref([rule, { ...rule, fee: 25000, sourceCode: 'OTHER' }])]);
  assert.equal(result.status, 'Belum dapat diperiksa'); assert.match(result.reason, /ongkos baku/);
});
test('blank or percentage fees do not produce false matches', () => {
  for (const candidate of [{ ...rule, fee: null, feeType: 'unknown' as const }, { ...rule, fee: -7, feeType: 'percent' as const }]) assert.equal(auditPriceTransaction(tx, window, [ref([candidate])]).status, 'Belum dapat diperiksa');
});
test('reports independent price and fee discrepancies with correct signs', () => {
  const result = auditPriceTransaction({ ...tx, price: 3064000, pricePerGram: 1532000, fee: 15000 }, window, [ref([rule])]);
  assert.equal(result.status, 'Tidak cocok'); assert.equal(result.priceDifference, -10000); assert.equal(result.feeDifference, 5000);
  assert.match(result.reason, /Harga jual per gram lebih rendah/); assert.match(result.reason, /Ongkos lebih tinggi/);
});
test('reference codes only link files; ambiguous repeated codes never infer kadar', () => {
  const buyback = { ...rule, kind: 'buyback' as const, kadar: null };
  assert.equal(resolveReferenceKadar([ref([rule, buyback])])[1].kadar, 75);
  assert.equal(resolveReferenceKadar([ref([rule, { ...rule, kadar: 82 }, buyback])])[2].kadar, null);
  assert.equal(resolveReferenceKadar([ref([rule, { ...rule, sourceCode: 'A2' }, { ...buyback, sourceCode: 'A1 / A2' }])])[2].kadar, 75);
});
test('incomplete references, missing grades and missing timestamps stay unverified', () => {
  assert.equal(auditPriceTransaction(tx, window, [ref([rule], false)]).status, 'Belum dapat diperiksa');
  assert.equal(auditPriceTransaction({ ...tx, kadar: 82, pricePerGram: 1450000 }, window, [ref([rule])]).status, 'Belum dapat diperiksa');
  assert.equal(auditPriceTransaction({ ...tx, time: '' }, undefined, [ref([rule])]).status, 'Belum dapat diperiksa');
});
test('money calculation preserves decimal gram multiplication', () => {
  assert.equal(moneyWeight(1542000, 1.234), 1902828);
  assert.equal(moneyWeight(5000, 0.123), 615);
});

test('uses harga_gram directly and never derives or rounds it from nominal totals', () => {
  const r = { ...rule, kadar: 86, rate: 1768000, fee: 20000 };
  const matching = auditPriceTransaction({ ...tx, kadar: 86, weight: 1.73, price: 3059000, pricePerGram: 1768000, fee: 40000 }, window, [ref([r])]);
  assert.equal(matching.status, 'Cocok'); assert.equal(matching.priceDifference, 0); assert.equal(matching.actualRate, 1768000);
  assert.match(matching.reason, /ke atas/);
  const nominalOnlyChange = auditPriceTransaction({ ...tx, kadar: 86, weight: 1.73, price: 9999999, pricePerGram: 1768000, fee: 40000 }, window, [ref([r])]);
  assert.equal(nominalOnlyChange.status, 'Cocok'); assert.equal(nominalOnlyChange.actualRate, 1768000);
  const changedRate = auditPriceTransaction({ ...tx, kadar: 86, weight: 1.73, price: 3059000, pricePerGram: 1768208.09, fee: 40000 }, window, [ref([r])]);
  assert.equal(changedRate.status, 'Tidak cocok'); assert.equal(changedRate.priceDifference, 208.09);
  const missing = auditPriceTransaction({ ...tx, pricePerGram: null }, window, [ref([rule])]);
  assert.equal(missing.status, 'Belum dapat diperiksa'); assert.equal(missing.actualRate, null); assert.match(missing.reason, /harga_gram/);
  const withoutTotal = auditPriceTransaction({ ...tx, price: null }, window, [ref([rule])]);
  assert.equal(withoutTotal.status, 'Cocok');
});
test('chat attachments share image date and all four references in automatic daily mode', () => {
  const references = Array.from({ length: 4 }, (_, i) => ({ ...ref([rule]), id: String(i) }));
  const missing = priceAuditScope('tolong cek data ini dengan transaksi', references);
  assert.equal(missing.handled, true); assert.equal(missing.needsTime, false); assert.equal(missing.needsDate, false);
  assert.equal(missing.selection?.salesAutoBatch, true); assert.equal(missing.windows[0].date, '2026-11-20'); assert.equal(missing.windows[0].attachmentIds.length, 4);
  const ready = priceAuditScope('tolong cek data ini dengan transaksi jam 9 pagi sampai 5 sore', references);
  assert.equal(ready.selection?.windows[0].date, '2026-11-20'); assert.equal(ready.selection?.windows[0].fromTime, '00:00'); assert.equal(ready.selection?.windows[0].toTime, '24:00');
  const conflict = priceAuditScope('cek tanggal 23/11/2026 jam 9–17', references);
  assert.equal(conflict.dateConflict, true); assert.equal(conflict.selection, undefined);
  assert.equal(priceAuditScope('cek jam 9–17', [{ ...references[0], date: '' }]).needsDate, true);
  const multiDate = priceAuditScope('cek jam 09:00-17:00', [...references, { ...references[0], id: 'other', date: '2026-11-21' }]);
  assert.equal(multiDate.selection?.windows.length, 2); assert.equal(multiDate.selection?.windows[1].attachmentIds.length, 1);
});
test('hour parser accepts explicit Indonesian ranges, rejects guessed or ambiguous ranges', () => {
  for (const text of ['jam 9 sampai jam 17', 'pukul 09.00 s/d 17.00 WIB', '09:00–17:00', 'jam 9 pagi sampai 5 sore']) assert.deepEqual(explicitPriceHours(text), { fromTime: '09:00', toTime: '17:00' }, text);
  assert.deepEqual(explicitPriceHours('jam 9-24'), { fromTime: '09:00', toTime: '24:00' });
  for (const text of ['20/11/2026 batch 2', 'jam 9', 'jam 9-3', 'jam 09:70-17:00', 'jam 9-11 lalu jam 12-15']) assert.equal(explicitPriceHours(text), null, text);
});

test('sales engine cannot accidentally audit buyback by grade or derived total', () => {
  const result = auditPriceTransaction({ ...tx, kind: 'buyback' }, window, [ref([rule])]);
  assert.equal(result.status, 'Belum dapat diperiksa'); assert.match(result.reason, /harga_rata dan kode intern/);
});
