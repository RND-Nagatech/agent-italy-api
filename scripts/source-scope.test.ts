import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAgentSourceScopeToToolArgs, resolveAgentSourceScope } from '../src/agent/source-scope'

const sources = [
  { alias: 'ITALY PUSAT (ITY)', branchId: 'ITY', sourceType: 'central' as const },
  { alias: 'ITALY OTISTA (IT2)', branchId: 'IT2', sourceType: 'branch' as const },
]

test('Italy brand and connector variants resolve to all allowed sources', () => {
  assert.deepEqual(resolveAgentSourceScope('penjualan Italy hari ini', sources), {})
  assert.deepEqual(resolveAgentSourceScope('penjualan hari ini di Italy', sources), {})
  assert.deepEqual(resolveAgentSourceScope('penjualan untuk Italy', sources), {})
  assert.deepEqual(resolveAgentSourceScope('pembelian di Italy', sources), {})
  assert.deepEqual(resolveAgentSourceScope('stok untuk Italy', sources), {})
  assert.deepEqual(resolveAgentSourceScope('pengiriman dari Italy', sources), {})
})

test('specific Italy locations resolve to their source IDs', () => {
  assert.deepEqual(resolveAgentSourceScope('penjualan Italy Pusat', sources), { branchIds: ['ITY'], sourceType: 'central' })
  assert.deepEqual(resolveAgentSourceScope('stok Italy Otista', sources), { branchIds: ['IT2'], sourceType: 'branch' })
  assert.deepEqual(resolveAgentSourceScope('penjualan Italy Pusat dan Italy Otista', sources), { branchIds: ['ITY', 'IT2'] })
})

test('resolved scope overrides model-selected subsets for scoped tools', () => {
  assert.deepEqual(
    applyAgentSourceScopeToToolArgs('get_transaction_report', { branchIds: ['IT2'], reportType: 'sales' }, {},),
    { reportType: 'sales' },
  )
  assert.deepEqual(
    applyAgentSourceScopeToToolArgs('get_current_stock', { branchIds: ['IT2'], sourceType: 'central' }, { branchIds: ['ITY'], sourceType: 'central' }),
    { branchIds: ['ITY'], sourceType: 'central' },
  )
  assert.deepEqual(
    applyAgentSourceScopeToToolArgs('get_shipments_period', { branchIds: ['IT2'], from: '2026-11-19', to: '2026-11-19' }, {}),
    { from: '2026-11-19', to: '2026-11-19' },
  )
  assert.deepEqual(
    applyAgentSourceScopeToToolArgs('get_buyback_period', { branchIds: ['IT2'], from: '2026-11-19', to: '2026-11-19' }, {}),
    { from: '2026-11-19', to: '2026-11-19' },
  )
  assert.deepEqual(
    applyAgentSourceScopeToToolArgs('analyze_sales_period_report', { branchId: 'IT2', from: '2026-11-19', to: '2026-11-19' }, {}),
    { from: '2026-11-19', to: '2026-11-19' },
  )
})
