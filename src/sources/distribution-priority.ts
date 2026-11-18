export const DISTRIBUTION_PRIORITIES = ['profit_bagus', 'opening', 'boost', 'none'] as const;
export type DistributionPriority = typeof DISTRIBUTION_PRIORITIES[number];
export function normalizeDistributionPriority(value: unknown): DistributionPriority {
  return value === 'profit_bagus' || value === 'opening' || value === 'boost' ? value : 'none';
}
export function distributionPriorityRank(value: unknown): number {
  return DISTRIBUTION_PRIORITIES.indexOf(normalizeDistributionPriority(value));
}
export function distributionPriorityLabel(value: unknown): string {
  return ({ profit_bagus: 'Exclusive', opening: 'Opening', boost: 'Boost', none: 'Tanpa flag' })[normalizeDistributionPriority(value)];
}
// Apply only after filtering real shortages; a flag must not create demand.
export function compareDistributionPriority(left: { distributionPriority?: unknown }, right: { distributionPriority?: unknown }): number {
  return distributionPriorityRank(left.distributionPriority) - distributionPriorityRank(right.distributionPriority);
}
