import type { AgentResponseBlock } from './response-blocks';

export type ProductDistributionCategory = 'X' | 'XB' | 'B';
export type ItemCategory = 'X' | 'BIASA';

export type OfferedStockAllocationContext = {
  kind: 'offered-stock-allocation';
  requestId: string;
  jenisCode: string;
  productCategory: ProductDistributionCategory;
  sourceBranchId: string;
  sourceAlias: string;
  offeredPcs: number;
  allocatedPcs: number;
  remainingOfferedPcs: number;
  eligibleRecipientShortagePcs?: number;
  unfilledEligibleShortagePcs?: number;
  sources: Array<{ alias: string; branchId: string }>;
  branches: Array<{
    branchId: string;
    alias: string;
    itemCategory: ItemCategory;
    distributionPriority: string;
    shortageBeforeTransfersPcs: number;
    receivedPcs: number;
    unfilledShortagePcs: number;
  }>;
};

export type OfferedStockFollowUpIntent = 'purchasing' | 'cleaning' | 'shortfall';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;

export function makeOfferedStockAllocationContext(
  result: Row,
  requestId: string,
  sources: Array<{ alias: string; branchId: string }>,
): OfferedStockAllocationContext | undefined {
  const allocation = record(result.allocation);
  const productCategory = text(allocation.productCategory);
  if (result.mode !== 'network-restock-plan' || !['X', 'XB', 'B'].includes(productCategory)) return undefined;

  const jenisCode = text(allocation.jenisCode).trim().toUpperCase();
  const sourceBranchId = text(allocation.sourceBranchId).trim();
  if (!jenisCode || !sourceBranchId) return undefined;

  const receiptsByBranch = new Map<string, number>();
  for (const transfer of rows(result.transfers)) {
    const to = record(transfer.to);
    const branchId = text(to.branchId);
    if (branchId) receiptsByBranch.set(branchId, (receiptsByBranch.get(branchId) ?? 0) + number(transfer.quantity));
  }

  const branches = rows(result.branches).flatMap((branch) => {
    const branchId = text(branch.branchId).trim();
    if (!branchId || !['X', 'BIASA'].includes(text(branch.itemCategory))) return [];
    return [{
      branchId,
      alias: text(branch.alias, branchId),
      itemCategory: text(branch.itemCategory) as ItemCategory,
      distributionPriority: text(branch.distributionPriority, 'none'),
      shortageBeforeTransfersPcs: number(branch.shortageBeforeTransfersUnits),
      receivedPcs: receiptsByBranch.get(branchId) ?? 0,
      unfilledShortagePcs: number(branch.unfilledShortageUnits),
    }];
  });

  return {
    kind: 'offered-stock-allocation',
    requestId,
    jenisCode,
    productCategory: productCategory as ProductDistributionCategory,
    sourceBranchId,
    sourceAlias: text(allocation.sourceAlias, sourceBranchId),
    offeredPcs: number(allocation.offeredPcs),
    allocatedPcs: number(allocation.allocatedPcs),
    remainingOfferedPcs: number(allocation.remainingOfferedPcs),
    ...(Number.isFinite(Number(allocation.eligibleRecipientShortagePcs)) ? { eligibleRecipientShortagePcs: number(allocation.eligibleRecipientShortagePcs) } : {}),
    ...(Number.isFinite(Number(allocation.unfilledEligibleShortagePcs)) ? { unfilledEligibleShortagePcs: number(allocation.unfilledEligibleShortagePcs) } : {}),
    sources: sources.slice(0, 100).map(source => ({ alias: source.alias, branchId: source.branchId })),
    branches,
  };
}

export function restoreOfferedStockAllocationContextFromBlocks(
  blocks: AgentResponseBlock[] | undefined,
  requestId: string,
  sources: Array<{ alias: string; branchId: string }>,
): OfferedStockAllocationContext | undefined {
  if (!blocks?.length) return undefined;
  const heading = blocks.find((block): block is Extract<AgentResponseBlock, { type: 'text' }> => block.type === 'text' && block.variant === 'heading')?.text ?? '';
  const match = heading.match(/^Alokasi Jenis ([A-Z0-9_-]+) · kategori (X|XB|B) · (.+) pcs dari (.+)$/i);
  if (!match) return undefined;
  const [, jenisCode, rawCategory, offeredText, sourceAlias] = match;
  const productCategory = rawCategory.toUpperCase() as ProductDistributionCategory;
  const metrics = new Map(blocks.filter((block): block is Extract<AgentResponseBlock, { type: 'metric' }> => block.type === 'metric').map(block => [block.label, numberFromCell(block.value)]));
  const positionTable = blocks.find((block): block is Extract<AgentResponseBlock, { type: 'table' }> => block.type === 'table' && block.title === `Posisi Jenis ${jenisCode} per cabang`);
  if (!positionTable) return undefined;

  const index = (column: string) => positionTable.columns.indexOf(column);
  const branchIndex = index('Cabang');
  const groupIndex = index('Kelompok cabang');
  const priorityIndex = index('Flag prioritas');
  const shortageIndex = index('Kekurangan (pcs)');
  const receivedIndex = index('Rencana terima (pcs)');
  if ([branchIndex, groupIndex, priorityIndex, shortageIndex, receivedIndex].some(value => value < 0)) return undefined;

  const branches = positionTable.rows.flatMap(row => {
    const alias = String(row[branchIndex] ?? '').trim();
    const rawGroup = String(row[groupIndex] ?? '');
    if (!alias || !['X', 'BIASA'].includes(rawGroup)) return [];
    const source = sources.find(item => item.alias === alias || item.branchId === alias);
    const priorityLabel = String(row[priorityIndex] ?? '');
    const distributionPriority = priorityLabel === 'Exclusive' ? 'profit_bagus'
      : priorityLabel === 'Opening' ? 'opening'
        : priorityLabel === 'Boost' ? 'boost' : 'none';
    const shortageBeforeTransfersPcs = numberFromCell(row[shortageIndex]);
    const receivedPcs = numberFromCell(row[receivedIndex]);
    return [{
      branchId: source?.branchId ?? alias,
      alias,
      itemCategory: rawGroup as ItemCategory,
      distributionPriority,
      shortageBeforeTransfersPcs,
      receivedPcs,
      unfilledShortagePcs: Math.max(0, shortageBeforeTransfersPcs - receivedPcs),
    }];
  });
  if (!branches.length) return undefined;

  const source = sources.find(item => item.alias === sourceAlias || item.branchId === sourceAlias);
  return {
    kind: 'offered-stock-allocation',
    requestId,
    jenisCode: jenisCode.toUpperCase(),
    productCategory,
    sourceBranchId: source?.branchId ?? sourceAlias,
    sourceAlias,
    offeredPcs: metrics.get('Stok ditawarkan') || parseCount(offeredText),
    allocatedPcs: metrics.get('Disarankan dikirim') ?? 0,
    remainingOfferedPcs: metrics.get('Sisa penawaran') ?? 0,
    sources,
    branches,
  };
}

export function detectOfferedStockFollowUpIntent(prompt: string): OfferedStockFollowUpIntent | null {
  const normalized = prompt.toLocaleLowerCase('id-ID').normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ');
  const asksAboutShortfall = /\b(kurang(?:nya|an)?|kekurangan|belum\s+(?:terpenuhi|kebagian)|sisa\s+kebutuhan|yang\s+belum)\b/.test(normalized);
  const asksHowMuchToSupply = /\b(berapa|jumlah|total)\b/.test(normalized)
    && /\b(stok|stock|pcs|barang|unit)\b/.test(normalized)
    && /\b(sedia(?:kan)?|disedia(?:kan)?|siap(?:kan)?|disiap(?:kan)?|beli|dibeli|pengadaan|restock|order)\b/.test(normalized);
  const asksProcurementAmount = /\b(berapa|jumlah|total)\b/.test(normalized)
    && /\b(purchasing|pembelian|pengadaan|supplier|pemasok|order|beli|dibeli)\b/.test(normalized);
  if (!asksAboutShortfall && !asksHowMuchToSupply && !asksProcurementAmount) return null;
  if (/\b(purchasing|pembelian|pengadaan|supplier|pemasok|order|beli|dibeli)\b/.test(normalized)) return 'purchasing';
  if (/\b(cuci|cucian|pencucian|sepuh(?:an)?)\b/.test(normalized)) return 'cleaning';
  return 'shortfall';
}

export function offeredStockFollowUpBlocks(
  context: OfferedStockAllocationContext,
  intent: OfferedStockFollowUpIntent,
  prompt: string,
): AgentResponseBlock[] {
  const xBranches = context.branches.filter(branch => branch.itemCategory === 'X');
  const ordinaryBranches = context.branches.filter(branch => branch.itemCategory === 'BIASA');
  const eligibleOrdinaryBranches = ordinaryBranches.filter(branch => branch.distributionPriority !== 'profit_bagus');
  const xUnfilled = sum(xBranches);
  const ordinaryUnfilled = sum(ordinaryBranches);
  const eligibleOrdinaryUnfilled = sum(eligibleOrdinaryBranches);
  const targetOrdinary = /\b(?:biasa|non[- ]?exclusive)\b/i.test(prompt);
  const useCleaning = context.productCategory === 'B' || context.productCategory === 'XB';

  let targetBranches = xBranches;
  let unresolvedPcs = xUnfilled;
  let label = 'Saran Purchasing prioritas';
  let routeName = 'Purchasing';
  let stageNote = '';

  if (useCleaning) {
    targetBranches = eligibleOrdinaryBranches;
    unresolvedPcs = context.unfilledEligibleShortagePcs ?? eligibleOrdinaryUnfilled;
    label = 'Saran ke bagian Cuci';
    routeName = 'bagian Cuci';
  } else if (context.productCategory === 'X') {
    if (targetOrdinary) {
      targetBranches = ordinaryBranches;
      unresolvedPcs = ordinaryUnfilled;
      label = 'Kekurangan cabang BIASA';
      routeName = 'tahap BIASA';
      stageNote = xUnfilled > 0
        ? `Tahap BIASA belum boleh dipenuhi: kelompok X masih kekurangan ${formatPcs(xUnfilled)} pcs.`
        : 'Kebutuhan kelompok X sudah terpenuhi; angka ini menunjukkan sisa kekurangan pada tahap BIASA.';
    } else if (xUnfilled === 0) {
      targetBranches = ordinaryBranches;
      unresolvedPcs = ordinaryUnfilled;
      label = 'Saran Purchasing tahap BIASA';
      routeName = 'Purchasing tahap berikutnya';
      stageNote = 'Kebutuhan kelompok X sudah terpenuhi. Kekurangan BIASA dihitung sebagai tahap berikutnya.';
    } else {
      stageNote = ordinaryUnfilled > 0
        ? `Kekurangan BIASA ${formatPcs(ordinaryUnfilled)} pcs belum masuk prioritas Purchasing karena kebutuhan kelompok X masih tersisa.`
        : '';
    }
  }

  if (intent === 'cleaning' && !useCleaning) {
    label = 'Sisa kebutuhan belum dialihkan ke Cuci';
    routeName = 'Purchasing';
    stageNote = 'Kategori produk X mengikuti jalur Purchasing; bagian Cuci berlaku untuk kategori B dan XB.';
  } else if (intent === 'purchasing' && useCleaning) {
    label = 'Saran ke bagian Cuci';
    routeName = 'bagian Cuci';
    stageNote = `Kategori produk ${context.productCategory} diarahkan ke bagian Cuci sesuai aturan distribusi. ${formatPcs(unresolvedPcs)} pcs adalah kekurangan eligible yang tersisa.`;
  }

  const detailRows = targetBranches
    .filter(branch => branch.unfilledShortagePcs > 0)
    .sort((left, right) => left.unfilledShortagePcs - right.unfilledShortagePcs || left.alias.localeCompare(right.alias))
    .map(branch => [branch.alias, branch.itemCategory, branch.shortageBeforeTransfersPcs, branch.receivedPcs, branch.unfilledShortagePcs]);

  const summary = unresolvedPcs > 0
    ? `${formatPcs(unresolvedPcs)} pcs Jenis ${context.jenisCode} belum terpenuhi setelah rencana alokasi ${formatPcs(context.allocatedPcs)} pcs. Angka ini menjadi tindak lanjut ${routeName}; tidak perlu menghitung ulang dari stok awal.`
    : `Tidak ada kekurangan yang perlu diteruskan ke ${routeName} untuk Jenis ${context.jenisCode} pada hasil alokasi terakhir.`;
  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: `${label} · Jenis ${context.jenisCode} · kategori ${context.productCategory}` },
    { type: 'metric', label, value: unresolvedPcs, unit: 'pcs', tone: unresolvedPcs > 0 ? 'amber' : 'teal' },
    { type: 'text', text: `Dari penawaran ${formatPcs(context.offeredPcs)} pcs di ${context.sourceAlias}, backend menyarankan kirim ${formatPcs(context.allocatedPcs)} pcs; sisa penawaran ${formatPcs(context.remainingOfferedPcs)} pcs. ${summary}` },
    ...(stageNote ? [{ type: 'callout' as const, tone: unresolvedPcs > 0 ? 'info' as const : 'success' as const, title: 'Urutan tindak lanjut', text: stageNote }] : []),
    {
      type: 'table',
      title: `Rincian kekurangan untuk ${routeName}`,
      columns: ['Cabang', 'Kelompok', 'Kebutuhan sebelum transfer (pcs)', 'Diterima (pcs)', 'Belum terpenuhi (pcs)'],
      rows: detailRows.length ? detailRows : [['Tidak ada cabang dengan sisa kebutuhan', '—', 0, 0, 0]],
    },
    { type: 'text', variant: 'muted', text: 'Ini tindak lanjut dari hasil alokasi terakhir di room ini, bukan analisis ulang atau transaksi pembelian/pengiriman.' },
  ];
  return blocks;
}

function sum(branches: OfferedStockAllocationContext['branches']): number {
  return branches.reduce((total, branch) => total + branch.unfilledShortagePcs, 0);
}

function formatPcs(value: number): string {
  return Math.round(value).toLocaleString('id-ID');
}

function numberFromCell(value: unknown): number {
  if (typeof value === 'number') return number(value);
  const textValue = String(value ?? '').trim();
  if (!textValue) return 0;
  const normalized = textValue.includes(',')
    ? textValue.replace(/\./g, '').replace(',', '.')
    : textValue.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseCount(value: string): number {
  return numberFromCell(value);
}
