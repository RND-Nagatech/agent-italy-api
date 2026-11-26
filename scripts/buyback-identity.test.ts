import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBuybackBatches, auditBuybackTransaction, type BuybackTransaction } from '../src/agent/buyback-audit.logic';
import { buybackReportTable } from '../src/agent/buyback-report.logic';
import type { PriceReference, PriceRule } from '../src/agent/price-audit.logic';

const date = '2026-11-21';
const rule = (sourceCode: string, sourceLabel: string, condition: PriceRule['condition'], rate: number, maxRate: number | null = null, sourceRow = sourceCode): PriceRule => ({ family: 'old', kind: 'buyback', sourceCode, sourceLabel, condition, rate, maxRate, sourceRow, kadar: null, fee: null, feeType: 'unknown', note: '' });
const shine = [rule('C5', 'SHINE', 'GOOD', 1507000), rule('C5', 'SHINE', 'STONE', 1466000, 1497000), rule('C5', 'SHINE', 'SCRAP', 1425000)];
const ref = (rows = shine, batch = 1): PriceReference => ({ id: `b${batch}`, filename: `acuan-${batch}.jpeg`, date, batch, complete: true, warnings: [], rows });
const tx = (internalCode: string, pricePerGram = 1490000): BuybackTransaction => ({ id: 'legacy', kind: 'buyback', store: 'Italy', date, time: '10:00:00', invoice: 'BB', name: 'Cincin', internalCode, masterSource: 'MariaDB (RDS)', condition: 'CUCI 16K / 17K', printedKadar: '', pricePerGram, price: 9999999, weight: 1.71, fee: null, quantity: 1, kadar: null, inputBy: 'Kasir' });

test('legacy size/model suffixes match the printed label without inventing abbreviations', () => {
  for (const name of ['SHINE 50', 'SHINE 34 1M']) assert.equal(auditBuybackBatches(tx(name), [ref()]).code, 'C5');
  const star = ref([rule('C4', 'STAR', 'GOOD', 1502000), rule('C4', 'STAR', 'STONE', 1466000, 1497000)]);
  assert.equal(auditBuybackBatches(tx('STAR 6R'), [star]).code, 'C4');
  const eg = ref([rule('C3', 'EG 900', 'GOOD', 1497000), rule('C3', 'EG 900', 'STONE', 1466000, 1497000)]);
  for (const name of ['EG900 54 1M', 'EG 900', 'EG900 12']) assert.equal(auditBuybackBatches(tx(name), [eg]).code, 'C3');
  const elite = ref([rule('C6', 'Korea / Elite', 'GOOD', 1513000), rule('C6', 'Korea / Elite', 'STONE', 1466000, 1497000)]);
  assert.equal(auditBuybackBatches(tx('ELITE 20'), [elite]).code, 'C6');
  for (const name of ['SHINE FAKE', 'SHINESTONE 50', 'ETER', 'ITY CH 9']) assert.equal(auditBuybackBatches(tx(name), [ref()]).status, 'Perlu diperhatikan');
});

test('legacy SHINE resolves from its printed label and uses 1466–1507 outside RUSAK', () => {
  for (const price of [1466000, 1490000, 1507000]) {
    const result = auditBuybackBatches(tx(' shine ', price), [ref()]);
    assert.equal(result.code, 'C5'); assert.equal(result.minimum, 1466000); assert.equal(result.maximum, 1507000);
    assert.equal(result.status, 'Masih dalam batas range acuan');
  }
  assert.equal(auditBuybackBatches(tx('SHINE', 1465999), [ref()]).status, 'Di luar range acuan');
  assert.equal(auditBuybackBatches(tx('SHINE', 1425000), [ref()]).status, 'Di luar range acuan');
  const damaged = auditBuybackBatches({ ...tx('SHINE', 1425000), condition: 'RUSAK 16K / 17K' }, [ref()]);
  assert.equal(damaged.status, 'Masih dalam batas range acuan'); assert.equal(damaged.minimum, 1425000);
  const result = auditBuybackBatches(tx('SHINE'), [ref()]);
  const table = buybackReportTable([result], [ref()], true);
  assert.equal(table.rows[0][table.columns.indexOf('Kode Intern')], 'SHINE');
  assert.equal(table.rows[0][table.columns.indexOf('Kode Acuan')], 'C5');
  assert.equal(table.columns.includes('Sumber Barang'), false);
  assert.equal(table.rows[0][table.columns.indexOf('Range Batch 1 (IDR/gram)')], 'Rp1.466.000–Rp1.507.000');
  assert.equal(table.rows[0].length, table.columns.length);
});

test('labels are dynamic document data rather than a fixed brand/code/price mapping', () => {
  const changed = [rule('Q7', 'SHINE', 'GOOD', 2050000), rule('Q7', 'SHINE', 'STONE', 2000000, 2030000)];
  const result = auditBuybackBatches(tx('SHINE', 2010000), [ref(changed)]);
  assert.equal(result.code, 'Q7'); assert.equal(result.minimum, 2000000); assert.equal(result.maximum, 2050000);
  const unlabeled = shine.map(row => ({ ...row, sourceLabel: '' }));
  const unknown = auditBuybackBatches(tx('SHINE'), [ref(unlabeled)]);
  assert.equal(unknown.status, 'Perlu diperhatikan'); assert.match(unknown.reason, /label intern SHINE.*file acuan/);
  assert.equal(auditBuybackBatches(tx('C5 16'), [ref(unlabeled)]).status, 'Masih dalam batas range acuan', 'modern codes still work without labels');
});

test('Eternity can cover the joint D1/E1 reference only while both printed ranges agree', () => {
  const rows = ['D1', 'E1'].flatMap(code => [rule(code, 'Eternity', 'GOOD', 1518000, null, code), rule(code, 'Eternity', 'STONE', 1466000, 1497000, code)]);
  const result = auditBuybackBatches(tx('ETERNITY'), [ref(rows)]);
  assert.equal(result.code, 'D1 / E1'); assert.equal(result.status, 'Masih dalam batas range acuan');
  const conflict = rows.map(row => row.sourceCode === 'E1' && row.condition === 'GOOD' ? { ...row, rate: 1600000 } : row);
  assert.equal(auditBuybackBatches(tx('ETERNITY'), [ref(conflict)]).status, 'Perlu diperhatikan', 'do not choose an alias variant by matching its price');
  const elite = [rule('C6', 'Korea / Elite', 'GOOD', 1513000), rule('C6', 'Korea / Elite', 'STONE', 1466000, 1497000)];
  assert.equal(auditBuybackBatches(tx('Elite'), [ref(elite)]).code, 'C6');
});

test('legacy names obey effective hours, date isolation and explicit missing-label failures', () => {
  const first = { ...ref(), effectiveFrom: '08:00' };
  const second = { ...ref([rule('C5', 'SHINE', 'GOOD', 1550000), rule('C5', 'SHINE', 'STONE', 1520000, 1540000)], 2), effectiveFrom: '12:00' };
  const result = auditBuybackBatches({ ...tx('SHINE'), time: '13:00:00' }, [first, second]);
  assert.equal(result.batch, 'Batch 2'); assert.equal(result.status, 'Di luar range acuan');
  assert.equal(result.minimum, 1520000);
  assert.equal(auditBuybackBatches(tx('SHINE'), [{ ...ref(), date: '2026-11-22' }]).status, 'Perlu diperhatikan');
  const unknown = auditBuybackTransaction(tx('UNLISTED'), { date, fromTime: '00:00', toTime: '24:00', attachmentIds: ['b1'] }, [ref()]);
  assert.equal(unknown.status, 'Perlu diperhatikan'); assert.equal(unknown.internalCode, 'UNLISTED'); assert.match(unknown.reason, /UNLISTED.*file acuan/);
});
