export type ItemCategory = 'X' | 'BIASA';

export const ITEM_CATEGORIES = ['X', 'BIASA'] as const;

export const MALL_BRANCH_IDS = new Set([
  'VDC',
  'GM',
  'GMC',
  'CSB',
  'GCM',
  'MID',
  'GRT',
  'GCP',
  'FCL',
  'CWK',
  'BIP',
]);

export function inferItemCategory(branchId: unknown): ItemCategory {
  const normalizedBranchId = typeof branchId === 'string' ? branchId.trim().toUpperCase() : '';
  return MALL_BRANCH_IDS.has(normalizedBranchId) ? 'X' : 'BIASA';
}

export function normalizeItemCategory(value: unknown, branchId: unknown): ItemCategory {
  return value === 'X' || value === 'BIASA' ? value : inferItemCategory(branchId);
}
