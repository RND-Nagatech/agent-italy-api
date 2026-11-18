export const PRODUCT_DISTRIBUTION_CATEGORIES = ['X', 'XB', 'B'] as const;
export type ProductDistributionCategory = typeof PRODUCT_DISTRIBUTION_CATEGORIES[number];

export function normalizeProductDistributionCategory(value: unknown): ProductDistributionCategory | undefined {
  return PRODUCT_DISTRIBUTION_CATEGORIES.includes(value as ProductDistributionCategory)
    ? value as ProductDistributionCategory
    : undefined;
}

export function productCategoryLabel(value: ProductDistributionCategory): string {
  return value === 'X' ? 'X · baru dari pabrik' : value === 'XB' ? 'XB · satu kali buyback dan dicuci' : 'B · sudah lebih dari dua kali dicuci';
}
