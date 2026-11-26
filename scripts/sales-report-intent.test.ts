import assert from 'node:assert/strict'
import test from 'node:test'
import { allStoreSalesTodayQuery } from '../src/agent/sales-report-intent'

test('recognizes Italy sales-today wording variants', () => {
  for (const prompt of [
    'penjualan italy hari ini',
    'penjualan hari ini di italy',
    'penjualan hari ini untuk italy',
    'penjualan untuk italy hari ini',
    'tolong tampilkan penjualan hari ini pada italy semua toko',
  ]) {
    assert.deepEqual(allStoreSalesTodayQuery(prompt, '2026-11-19'), {
      reportType: 'sales',
      from: '2026-11-19',
      to: '2026-11-19',
    })
  }
})

test('does not route specific locations or online sales to the all-store shortcut', () => {
  assert.equal(allStoreSalesTodayQuery('penjualan hari ini di Italy Otista', '2026-11-19'), null)
  assert.equal(allStoreSalesTodayQuery('penjualan online Italy hari ini', '2026-11-19'), null)
})
