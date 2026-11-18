import { normalizeProductDistributionCategory, type ProductDistributionCategory } from '../sources/product-category';

export type CentralStockOffer = {
  jenisCode: string;
  availablePcs: number;
  sourceBranchId: string | undefined;
  productCategory?: ProductDistributionCategory;
};

// Preserve an explicit stock offer even if the model omits the allocation arguments.
export function centralStockOffer(prompt: string, sources: Array<{ branchId: string; sourceType: string }>): CentralStockOffer | null {
  if (!/\b(?:kirim|distribusi|bagikan|alokasi|mutasi)\b/i.test(prompt) || !/\b(?:di|dari)\s+pusat\b/i.test(prompt)) return null;
  const match = prompt.match(/\b(?:punya|ada|tersedia|stok|stock)\s+(?:jenis\s+)?([a-z][a-z0-9_-]{0,31})\s+(\d+(?:[.,]\d{3})*)\s*(?:pcs|buah)\b/i);
  if (!match) return null;
  const central = sources.filter(source => source.sourceType === 'central');
  return {
    jenisCode: match[1].toUpperCase(),
    availablePcs: Number(match[2].replace(/[.,]/g, '')),
    sourceBranchId: central.length === 1 ? central[0].branchId : undefined,
    productCategory: parseProductCategory(prompt),
  };
}

export function isProductCategoryAnswer(prompt: string): ProductDistributionCategory | null {
  const normalized = prompt.trim().replace(/[.!?]+$/, '').trim();
  const answer = normalized.match(/^(?:kategori\s+|kelas\s+)?(XB|X|B|BIASA)(?:\s+(?:aja|saja|ya))?$/i);
  return answer ? normalizeProductDistributionCategory(answer[1].toUpperCase() === 'BIASA' ? 'B' : answer[1].toUpperCase()) ?? null : null;
}

function parseProductCategory(prompt: string): ProductDistributionCategory | undefined {
  const match = prompt.match(/\b(?:kategori|kelas)\s+(?:barang\s+)?(XB|X|B|BIASA)\b/i);
  if (!match) return undefined;
  return normalizeProductDistributionCategory(match[1].toUpperCase() === 'BIASA' ? 'B' : match[1].toUpperCase());
}
