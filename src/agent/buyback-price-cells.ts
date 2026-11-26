export type PriceCell = { condition: 'GOOD' | 'SCRAP' | 'STONE'; fromRow: number; toRow: number; rateThousands: number | null; maxRateThousands: number | null };
export type CompactPrices = { goodThousands: number | null; scrapThousands: number | null; stoneMinThousands: number | null; stoneMaxThousands: number | null };

/** Expand independently read physical price cells; each column must cover each row exactly once. */
export function applyBuybackPriceCells<T extends CompactPrices>(rows: T[], cells: PriceCell[]): T[] {
  const result = rows.map(row => ({ ...row }));
  for (const condition of ['GOOD', 'SCRAP', 'STONE'] as const) {
    const coverage = rows.map(() => 0);
    for (const cell of cells.filter(cell => cell.condition === condition)) {
      if (!Number.isInteger(cell.fromRow) || !Number.isInteger(cell.toRow) || cell.fromRow < 0 || cell.toRow < cell.fromRow || cell.toRow >= rows.length
        || (cell.rateThousands === null && cell.maxRateThousands !== null)
        || (condition !== 'STONE' && cell.maxRateThousands !== null)
        || (condition === 'STONE' && cell.rateThousands !== null && (cell.maxRateThousands === null || cell.maxRateThousands < cell.rateThousands))) throw new Error('Invalid physical price cell');
      for (let index = cell.fromRow; index <= cell.toRow; index++) {
        coverage[index]++;
        if (condition === 'GOOD') result[index].goodThousands = cell.rateThousands;
        else if (condition === 'SCRAP') result[index].scrapThousands = cell.rateThousands;
        else { result[index].stoneMinThousands = cell.rateThousands; result[index].stoneMaxThousands = cell.maxRateThousands; }
      }
    }
    if (coverage.some(count => count !== 1)) throw new Error('Missing or overlapping physical price cells');
  }
  return result;
}
