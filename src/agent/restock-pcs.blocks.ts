import { compareDistributionPriority, distributionPriorityLabel } from '../sources/distribution-priority';
import type { AgentResponseBlock } from './response-blocks';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const num = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const name = (row: Row): string => String(row.alias || row.branchId || '—');
const jenisName = (row: Row): string => [row.kode, row.nama].filter(Boolean).join(' · ');
const urgency = (need: unknown, target: unknown): number => num(need) > 0 && num(target) > 0 ? Math.min(10, Math.max(1, Math.ceil(num(need) / num(target) * 10))) : 1;
const routeRows = (value: unknown) => rows(value).map(route => [num(route.priority), name(record(route.from)), name(record(route.to)), distributionPriorityLabel(record(route.to).distributionPriority), jenisName(record(route.jenis)), num(route.quantity)]);
const fulfillmentText = (result: Row): string => {
  const method = String(result.fulfillmentMethod ?? record(result.allocation).fulfillmentMethod ?? 'branch-first');
  return method === 'even'
    ? 'Metode pemenuhan: dibagi merata. Stok donor dibagi seimbang ke cabang yang membutuhkan; prioritas cabang digunakan untuk menentukan sisa pcs yang tidak bisa dibagi rata.'
    : 'Metode pemenuhan: penuhi per cabang. Kebutuhan cabang prioritas teratas dipenuhi dahulu, lalu sisa stok dialokasikan ke cabang berikutnya.';
};
const periodText = (result: Row) => {
  const period = record(result.period), current = record(period.selectedSales), previous = record(period.comparisonSales);
  return `Penjualan ${current.from}–${current.through} dibandingkan ${previous.from}–${previous.through}. Per Jenis, gunakan pcs terjual terbesar dibagi hari aktual periode acuan. Target total = patokan stok dasar + pembulatan ke atas kebutuhan harian × 7 hari. Saran = max(0, target − stok fisik − OPEN dari Pusat). CLOS tidak ditambahkan karena sudah masuk stok fisik. Angka kebutuhan harian adalah rata-rata; jumlah mutasi selalu pcs bulat. Patokan yang belum diatur/nonaktif memakai tambahan 0 pcs; angka 0 yang aktif adalah aturan eksplisit. Versi patokan ${num(result.baselineRevision)}. Ini saran, belum ada transaksi pengiriman.`;
};

export function branchRestockPcsBlocks(result: Row): AgentResponseBlock[] {
  const branches = rows(result.branches), target = record(result.targetBranch);
  const branch = branches.find(row => row.branchId === target.branchId) ?? (branches.length === 1 ? branches[0] : undefined);
  const totals = record(result.totals), plan = record(result.transferPlan);
  const jenis = rows(branch?.jenis);
  const need = num(branch?.recommendedRestockUnits ?? totals.recommendedRestockUnits);
  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: `Proyeksi restock${branch ? ` · ${name(branch)}` : ' seluruh cabang'} (pcs)` },
    { type: 'text', text: `${periodText(result)} Prioritas penerima: Exclusive → Opening → Boost → Tanpa flag; dalam flag sama, cakupan stok terendah lalu kekurangan terbesar.` },
    { type: 'metric', label: 'Saran restock', value: need, unit: 'pcs', tone: need > 0 ? 'amber' : 'teal' },
    ...(branch ? [
      { type: 'metric' as const, label: 'Stok fisik', value: num(branch.stockOnHandUnits), unit: 'pcs', tone: 'navy' as const },
      { type: 'metric' as const, label: 'Kiriman OPEN masuk', value: num(branch.openIncomingUnits), unit: 'pcs', tone: 'teal' as const },
    ] : []),
    { type: 'bar_chart', title: 'Kebutuhan restock (pcs)', unit: 'pcs', items: (branch ? jenis.filter(row => num(row.recommendedRestockUnits) > 0).slice(0, 8).map(row => ({ label: jenisName(row), value: num(row.recommendedRestockUnits) })) : branches.slice(0, 8).map(row => ({ label: name(row), value: num(row.recommendedRestockUnits) }))) },
    branch ? { type: 'table', title: 'Restock per Jenis', columns: ['Jenis', 'Penjualan 7 hari vs bulan sebelumnya (pcs)', 'Acuan / kebutuhan harian (pcs / pcs per hari)', 'Patokan (pcs)', 'Kebutuhan 7 hari (pcs)', 'Target total (pcs)', 'Saran restock (pcs)', 'Stok fisik + OPEN (pcs)', 'Di bawah target', 'Urgensi (1–10)'], rows: jenis.map(row => [jenisName(row), `${num(row.recentSalesUnits)} vs ${num(row.comparisonSalesUnits)}`, `${num(row.demandReferenceUnits)} / ${num(row.estimatedDailyDemandUnits)}`, row.baselineConfigured ? num(row.baselinePcs) : 'Belum diatur (0)', num(row.weeklyDemandTargetUnits), num(row.targetStockUnits), num(row.recommendedRestockUnits), `${num(row.stockOnHandUnits)} + ${num(row.openIncomingUnits)}`, num(row.recommendedRestockUnits) > 0 ? 'Ya' : 'Tidak', urgency(row.recommendedRestockUnits, row.targetStockUnits)]) }
      : { type: 'table', title: 'Kebutuhan per cabang', columns: ['Cabang', 'Saran restock (pcs)', 'Stok fisik (pcs)', 'OPEN (pcs)'], rows: branches.map(row => [name(row), num(row.recommendedRestockUnits), num(row.stockOnHandUnits), num(row.openIncomingUnits)]) },
  ];
  const unallocated = rows(plan.unallocated);
  if (unallocated.length) blocks.push({ type: 'table', title: 'Kebutuhan belum terpenuhi', columns: ['Jenis', 'Belum terpenuhi (pcs)', 'Keterangan'], rows: unallocated.map(row => [jenisName(record(row.jenis)), num(row.unallocatedUnits), String(row.reason || '')]) });
  const omitted = num(result.omittedBranchCount) + branches.reduce((sum, row) => sum + num(row.omittedJenisCount), 0) + num(plan.omittedTransferCount) + num(plan.omittedJenisCount);
  if (omitted || rows(result.unavailableSources).length) blocks.push({ type: 'callout', tone: 'warning', title: 'Cakupan data dan rincian', text: `${omitted} rincian tidak ditampilkan; ${rows(result.unavailableSources).length} sumber tidak tersedia. Total tetap mencakup data yang berhasil dihitung; sumber gagal bukan stok nol.` });
  blocks.push({ type: 'callout', tone: need > 0 ? 'info' : 'success', title: need > 0 ? 'Rencana untuk ditinjau' : 'Stok mencukupi', text: need > 0 ? String(plan.note || 'Sumber donor belum tersedia; jangan menganggap kebutuhan sudah terpenuhi.') : 'Tidak perlu tambahan pcs berdasarkan stok fisik dan kiriman OPEN untuk patokan + kebutuhan 7 hari.' });
  blocks.push({ type: 'table', title: 'Rute transfer untuk ditinjau', columns: ['Prioritas', 'Dari', 'Ke', 'Flag penerima', 'Jenis', 'Jumlah kirim (pcs)'], rows: routeRows(plan.transfers).length ? routeRows(plan.transfers) : [['—', '—', '—', '—', need > 0 ? 'Belum ada rute donor yang tersedia' : 'Tidak perlu mutasi', 0]] });
  return blocks;
}

export function networkRestockPcsBlocks(result: Row): AgentResponseBlock[] {
  if (result.allocation) return offeredStockPcsBlocks(result);
  const totals = record(result.totals), jenis = rows(result.jenis), branches = rows(result.branches);
  const initial = num(totals.shortageBeforeTransfersUnits), unfilled = num(totals.unfilledShortageUnits);
  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: 'Rencana distribusi seluruh cabang (pcs)' },
    { type: 'text', text: `${fulfillmentText(result)} ${periodText(result)} Pusat menjadi donor pertama, lalu cabang dengan surplus terbesar setelah patokan dan cadangan penjualan 7 hari disisakan. Penerima yang kekurangan diprioritaskan: Exclusive → Opening → Boost → Tanpa flag. Dalam flag sama, cakupan stok terendah lalu kekurangan terbesar.` },
    { type: 'metric', label: 'Kekurangan awal', value: initial, unit: 'pcs', tone: 'navy' },
    { type: 'metric', label: 'Jumlah transfer disarankan', value: num(totals.recommendedTransferUnits), unit: 'pcs', tone: 'teal' },
    { type: 'metric', label: 'Belum terpenuhi', value: unfilled, unit: 'pcs', tone: unfilled > 0 ? 'amber' : 'teal' },
    { type: 'bar_chart', title: 'Kekurangan per Jenis (pcs)', unit: 'pcs', items: jenis.filter(row => num(row.shortageBeforeTransfers) > 0).slice(0, 8).map(row => ({ label: jenisName(row), value: num(row.shortageBeforeTransfers) })) },
    { type: 'table', title: 'Ringkasan rencana per Jenis', columns: ['Jenis', 'Kebutuhan (pcs/hari)', 'Patokan cabang (pcs)', 'Kebutuhan 7 hari (pcs)', 'Target total (pcs)', 'Stok fisik cabang (pcs)', 'OPEN (pcs)', 'Kekurangan (pcs)', 'Surplus cabang (pcs)', 'Transfer (pcs)', 'Belum terpenuhi (pcs)'], rows: jenis.map(row => [jenisName(row), num(row.demandUnitsPerDay), num(row.baselinePcs), num(row.weeklyDemandTargetUnits), num(row.targetStockUnits), num(row.branchPhysicalStock), num(row.openIncomingToBranches), num(row.shortageBeforeTransfers), num(row.branchSurplusBeforeTransfers), num(row.recommendedTransferUnits), num(row.unfilledShortageUnits)]) },
    { type: 'table', title: 'Posisi cabang', columns: ['Cabang', 'Flag prioritas', 'Surplus (pcs)', 'Kekurangan (pcs)', 'Belum terpenuhi (pcs)'], rows: branches.map(row => [name(row), distributionPriorityLabel(row.distributionPriority), num(row.surplusBeforeTransfersUnits), num(row.shortageBeforeTransfersUnits), num(row.unfilledShortageUnits)]) },
  ];
  if (initial > 0) blocks.push({ type: 'waterfall_chart', title: 'Kekurangan sebelum dan sesudah transfer (pcs)', unit: 'pcs', startLabel: 'Kekurangan awal', startValue: initial, steps: [{ label: 'Ditutup transfer', value: -(initial - unfilled) }], endLabel: 'Belum terpenuhi', endValue: unfilled });
  if (rows(result.unfilledNeeds).length) blocks.push({ type: 'table', title: 'Kebutuhan yang belum terpenuhi', columns: ['Cabang', 'Jenis', 'Belum terpenuhi (pcs)'], rows: rows(result.unfilledNeeds).map(row => [name(row), jenisName(record(row.jenis)), num(row.units)]) });
  const omitted = num(result.omittedJenisCount) + num(result.omittedTransferCount) + num(result.omittedBranchSummaryCount) + num(result.omittedUnfilledNeedCount);
  if (omitted) blocks.push({ type: 'callout', tone: 'warning', title: 'Sebagian rincian tidak ditampilkan', text: `${omitted} rincian tidak masuk tabel. Total mencakup seluruh hasil yang dihitung.` });
  blocks.push({ type: 'table', title: 'Detail rute transfer', columns: ['Prioritas', 'Dari', 'Ke', 'Flag penerima', 'Jenis', 'Jumlah kirim (pcs)'], rows: routeRows(result.transfers).length ? routeRows(result.transfers) : [['—', '—', '—', '—', 'Tidak ada rute yang disarankan', 0]] });
  return blocks;
}

export function supplierOrderPcsBlocks(result: Row): AgentResponseBlock[] {
  const totals = record(result.totals);
  const jenis = rows(result.jenis).sort((left, right) =>
    num(right.unfilledShortageUnits) - num(left.unfilledShortageUnits)
      || num(right.shortageBeforeTransfers) - num(left.shortageBeforeTransfers)
      || String(left.kode ?? '').localeCompare(String(right.kode ?? '')),
  );
  const orderPcs = num(totals.unfilledShortageUnits);
  const branchNeed = num(totals.shortageBeforeTransfersUnits);
  const centralPhysical = num(totals.centralPhysicalStockUnits);
  const centralAvailable = num(totals.centralAvailableStockUnits);
  const internalTransfers = num(totals.recommendedTransferUnits);
  const positiveOrders = jenis.filter(row => num(row.unfilledShortageUnits) > 0);
  const period = record(result.period);
  const selected = record(period.selectedSales), comparison = record(period.comparisonSales);
  const rowsForTable = jenis.map(row => {
    const centralBefore = num(row.centralAvailableBeforeTransfers);
    const centralAfter = num(row.centralAvailableAfterPlan);
    const centralUsed = Math.max(0, centralBefore - centralAfter);
    const totalTransfer = num(row.recommendedTransferUnits);
    return [
      jenisName(row),
      num(row.shortageBeforeTransfers),
      num(row.centralPhysicalStock),
      num(row.centralAvailableBeforeTransfers),
      num(row.branchSurplusBeforeTransfers),
      centralUsed,
      Math.max(0, totalTransfer - centralUsed),
      num(row.unfilledShortageUnits),
    ];
  });

  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: 'Analisis kebutuhan order supplier per Jenis' },
    {
      type: 'text',
      text: `Proyeksi memakai penjualan ${String(selected.from ?? '—')}–${String(selected.through ?? '—')} dibanding ${String(comparison.from ?? '—')}–${String(comparison.through ?? '—')}. Target Cabang = patokan dasar + kebutuhan 7 hari. Kekurangan Cabang sudah dikurangi stok fisik dan kiriman OPEN masuk. Stok Pusat tersedia sudah dikurangi kiriman OPEN keluar; CLOS tidak ditambahkan lagi.`,
    },
    { type: 'metric', label: 'Saran order supplier', value: orderPcs, unit: 'pcs', tone: orderPcs > 0 ? 'amber' : 'teal' },
    { type: 'metric', label: 'Kekurangan cabang sebelum dukungan jaringan', value: branchNeed, unit: 'pcs', tone: 'navy' },
    { type: 'metric', label: 'Stok fisik Pusat', value: centralPhysical, unit: 'pcs', tone: 'navy' },
    { type: 'metric', label: 'Stok Pusat tersedia setelah OPEN keluar', value: centralAvailable, unit: 'pcs', tone: 'teal' },
    {
      type: 'callout',
      tone: orderPcs > 0 ? 'warning' : 'success',
      title: orderPcs > 0 ? `Perlu order ${orderPcs.toLocaleString('en-US')} pcs` : 'Belum perlu order supplier',
      text: orderPcs > 0
        ? `Saran order adalah sisa kebutuhan Cabang setelah stok Pusat dan surplus Cabang yang aman dialokasikan. Rincian jumlah per Jenis ada di tabel; ini rekomendasi, bukan transaksi pembelian.`
        : 'Target stok seluruh Cabang yang dihitung saat ini dapat ditutup oleh stok jaringan. Tidak ada kekurangan bersih yang perlu dipesan dari supplier untuk horizon 7 hari.',
    },
  ];

  if (positiveOrders.length) {
    blocks.push({
      type: 'bar_chart',
      title: 'Saran order supplier terbesar per Jenis',
      unit: 'pcs',
      items: positiveOrders.slice(0, 10).map(row => ({ label: jenisName(row), value: num(row.unfilledShortageUnits) })),
    });
  }

  blocks.push({
    type: 'table',
    title: 'Perbandingan kebutuhan Cabang dan stok Pusat',
    columns: [
      'Jenis',
      'Kekurangan Cabang (pcs)',
      'Stok fisik Pusat (pcs)',
      'Stok Pusat tersedia (pcs)',
      'Surplus Cabang (pcs)',
      'Dipenuhi Pusat (pcs)',
      'Mutasi antar Cabang (pcs)',
      'Saran order supplier (pcs)',
    ],
    rows: rowsForTable,
  });

  if (num(result.omittedJenisCount) > 0 || num(result.omittedBranchSummaryCount) > 0) {
    blocks.push({
      type: 'callout',
      tone: 'warning',
      title: 'Hasil tidak ditampilkan seluruhnya',
      text: 'Sebagian rincian Jenis atau Cabang dibatasi. Total saran order tetap dihitung dari hasil analisis jaringan.',
    });
  }

  if (!rowsForTable.length) {
    blocks.push({ type: 'text', variant: 'muted', text: `Belum ada data Jenis untuk dibandingkan. ${internalTransfers ? `Rencana internal saat ini mencakup ${internalTransfers.toLocaleString('en-US')} pcs.` : ''}` });
  }
  return blocks;
}

function offeredStockPcsBlocks(result: Row): AgentResponseBlock[] {
  const allocation = record(result.allocation), totals = record(result.totals);
  const offered = num(allocation.offeredPcs), assigned = num(allocation.allocatedPcs);
  const jenis = String(allocation.jenisCode), origin = String(allocation.sourceAlias || allocation.sourceBranchId);
  const productCategory = String(allocation.productCategory || '');
  const restrictedToBasicBranches = productCategory === 'B' || productCategory === 'XB';
  const shortage = restrictedToBasicBranches
    ? num(allocation.eligibleRecipientShortagePcs)
    : num(totals.shortageBeforeTransfersUnits);
  const unfilledShortage = restrictedToBasicBranches
    ? num(allocation.unfilledEligibleShortagePcs)
    : num(totals.unfilledShortageUnits);
  const recipientOrder = Array.isArray(allocation.recipientOrder) ? allocation.recipientOrder.map(String) : [];
  const recipientRank = new Map(recipientOrder.map((branchId, index) => [branchId, index]));
  const branches = rows(result.branches).filter((branch) => !restrictedToBasicBranches
    || (String(branch.itemCategory || 'BIASA') === 'BIASA' && String(branch.distributionPriority || 'none') !== 'profit_bagus')).sort((left, right) => {
    if (productCategory === 'X') {
      const groupRank = (row: Row) => String(row.itemCategory) === 'X' ? 0 : 1;
      const groupDifference = groupRank(left) - groupRank(right);
      if (groupDifference) return groupDifference;
    }
    const rankDifference = (recipientRank.get(String(left.branchId)) ?? Number.POSITIVE_INFINITY)
      - (recipientRank.get(String(right.branchId)) ?? Number.POSITIVE_INFINITY);
    if (rankDifference) return rankDifference;
    const coverage = (row: Row) => num(row.dailyDemandUnits) > 0 ? num(row.projectedStockUnits) / num(row.dailyDemandUnits) : Number.POSITIVE_INFINITY;
    return compareDistributionPriority(left, right) || coverage(left) - coverage(right) || num(right.shortageBeforeTransfersUnits) - num(left.shortageBeforeTransfersUnits);
  });
  const branchRows = branches.length
    ? branches.map(branch => [name(branch), String(branch.itemCategory || 'BIASA'), distributionPriorityLabel(branch.distributionPriority), num(branch.dailyDemandUnits), num(branch.baselinePcs), num(branch.weeklyDemandTargetUnits), num(branch.targetStockUnits), num(branch.physicalStockUnits), num(branch.openIncomingUnits), num(branch.shortageBeforeTransfersUnits), rows(result.transfers).filter(route => record(route.to).branchId === branch.branchId).reduce((sum, route) => sum + num(route.quantity), 0)])
    : [['Tidak ada cabang penerima yang memenuhi syarat', '—', '—', 0, 0, 0, 0, 0, 0, 0, 0]];
  const recipientPolicyText = productCategory === 'X'
    ? `Urutan penerima produk X: ${recipientOrder.length ? recipientOrder.join(' → ') : 'belum diatur'}. Cabang kelompok X dipenuhi dahulu; setelah kebutuhannya tertutup, sisa penawaran baru dialokasikan ke BIASA.`
    : productCategory === 'XB'
      ? `Produk XB hanya dapat diterima cabang BIASA tanpa flag Exclusive. Urutan Distribusi XB (${recipientOrder.length ? recipientOrder.join(' → ') : 'belum diatur'}) hanya berlaku di antara cabang yang memenuhi syarat; cabang X dan Exclusive tidak menerima sisa pcs.`
      : productCategory === 'B'
        ? 'Produk B hanya dapat diterima cabang BIASA tanpa flag Exclusive. Sisa pcs tidak dialihkan ke cabang X atau Exclusive.'
        : 'Prioritas umum: Exclusive → Opening → Boost → Tanpa flag; dalam flag sama, cakupan stok terendah lalu kekurangan terbesar.';
  const noShortageText = restrictedToBasicBranches
    ? `Tidak ada kekurangan yang memenuhi syarat pada cabang BIASA tanpa flag Exclusive untuk Jenis ${jenis}. Sisa penawaran ${num(allocation.remainingOfferedPcs)} pcs tetap di ${origin}; cabang X dan Exclusive tidak dimasukkan sebagai penerima.`
    : `Semua cabang yang dianalisis sudah memenuhi patokan + target penjualan 7 hari untuk Jenis ${jenis}, setelah stok fisik dan OPEN diperhitungkan. Sarankan menahan ${offered} pcs yang ditawarkan di ${origin}; tidak perlu memaksakan distribusi.`;
  const allocationSummaryText = restrictedToBasicBranches
    ? `Kirim ${assigned} pcs Jenis ${jenis} dari ${origin} sesuai rute di bawah. Sisa penawaran: ${num(allocation.remainingOfferedPcs)} pcs. Kekurangan eligible yang belum tertutup: ${unfilledShortage} pcs. Penerima dibatasi ke cabang BIASA tanpa flag Exclusive.`
    : `Kirim ${assigned} pcs Jenis ${jenis} dari ${origin} sesuai rute di bawah. Sisa dari penawaran: ${num(allocation.remainingOfferedPcs)} pcs. Kebutuhan cabang yang belum tertutup: ${unfilledShortage} pcs. Jenis lain dan donor lain tidak masuk rencana ini.`;
  const routes = routeRows(result.transfers);
  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: `Alokasi Jenis ${jenis}${productCategory ? ` · kategori ${productCategory}` : ''} · ${offered} pcs dari ${origin}` },
    { type: 'callout', tone: shortage === 0 ? 'success' : assigned > 0 ? 'info' : 'warning', title: shortage === 0 ? `${jenis} belum perlu dikirim` : `Saran pembagian ${jenis}`, text: shortage === 0
      ? noShortageText
      : allocationSummaryText },
    { type: 'metric', label: 'Stok ditawarkan', value: offered, unit: 'pcs', tone: 'navy' },
    { type: 'metric', label: 'Disarankan dikirim', value: assigned, unit: 'pcs', tone: 'teal' },
    { type: 'metric', label: 'Sisa penawaran', value: num(allocation.remainingOfferedPcs), unit: 'pcs', tone: 'navy' },
    { type: 'text', text: `${fulfillmentText(result)} ${periodText(result)} ${recipientPolicyText}` },
    { type: 'table', title: `Posisi Jenis ${jenis} per cabang`, columns: ['Cabang', 'Kelompok cabang', 'Flag prioritas', 'Kebutuhan (pcs/hari)', 'Patokan (pcs)', 'Kebutuhan 7 hari (pcs)', 'Target total (pcs)', 'Stok fisik (pcs)', 'OPEN (pcs)', 'Kekurangan (pcs)', 'Rencana terima (pcs)'], rows: branchRows },
  ];
  if (num(allocation.sourceAvailablePcs) < offered) blocks.push({ type: 'callout', tone: 'warning', title: 'Stok bebas sumber membatasi rencana', text: `Penawaran ${offered} pcs; stok bebas Jenis ${jenis} yang terverifikasi pada sumber hanya ${num(allocation.sourceAvailablePcs)} pcs. Alokasi dibatasi stok bebas tersebut dan kebutuhan tujuan. Sisa penawaran tidak berarti semuanya tersedia secara fisik.` });
  const omitted = num(result.omittedBranchSummaryCount) + num(result.omittedTransferCount) + num(result.omittedUnfilledNeedCount);
  if (omitted) blocks.push({ type: 'callout', tone: 'warning', title: 'Sebagian rincian tidak ditampilkan', text: `${omitted} rincian tidak ditampilkan; total pcs mencakup semua hasil perhitungan.` });
  blocks.push({ type: 'table', title: `Jalur kirim Jenis ${jenis} dari ${origin}`, columns: ['Prioritas', 'Dari', 'Ke', 'Flag penerima', 'Jenis', 'Jumlah kirim (pcs)'], rows: routes.length ? routes : [['—', origin, '—', '—', jenis, 0]] });
  return blocks;
}
