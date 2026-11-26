import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInventoryIntent } from '../src/agent/inventory-intent'

const sources = [
  { alias: 'ITALY PUSAT (ITY)', branchId: 'ITY', sourceType: 'central' as const },
  { alias: 'ITALY OTISTA (IT2)', branchId: 'IT2', sourceType: 'branch' as const },
]

test('generic stock questions include every allowed source', () => {
  assert.deepEqual(resolveInventoryIntent('jumlah stock saat ini', sources), {})
  assert.deepEqual(resolveInventoryIntent('stok Italy ada berapa', sources), {})
})

test('Italy Pusat resolves to ITY', () => {
  assert.deepEqual(resolveInventoryIntent('stock barang Italy Pusat ada berapa', sources), { branchId: 'ITY' })
  assert.deepEqual(resolveInventoryIntent('berapa stok Pusat', sources), { branchId: 'ITY' })
})

test('Italy Otista resolves to IT2', () => {
  assert.deepEqual(resolveInventoryIntent('stok Italy Otista ada berapa', sources), { branchId: 'IT2' })
  assert.deepEqual(resolveInventoryIntent('berapa stok Otista', sources), { branchId: 'IT2' })
})

test('a location-only follow-up inherits only the immediately previous stock intent', () => {
  assert.deepEqual(resolveInventoryIntent('kalo Italy Pusat', sources, 'jumlah stock saat ini'), { branchId: 'ITY' })
  assert.deepEqual(resolveInventoryIntent('kalo Italy Otista', sources, 'jumlah stock saat ini'), { branchId: 'IT2' })
  assert.deepEqual(resolveInventoryIntent('kalo Italy Pusat', sources, 'penjualan transfer tanggal 12'), null)
})

test('non-summary and detail questions remain available to the model router', () => {
  assert.equal(resolveInventoryIntent('stok vs penjualan Italy', sources), null)
  assert.equal(resolveInventoryIntent('stok Jenis CN di Italy Pusat', sources), null)
})
