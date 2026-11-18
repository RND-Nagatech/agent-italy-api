import { Document } from 'mongodb';
import { AgentResponseBlock } from './response-blocks';
export function compactBranchSales(result: Document): Document {
  let peopleBudget = 60, jenisBudget = 160, truncated = false;
  const branches = result.branches.map((branch: Document) => {
    if (branch.status !== 'available') return branch;
    if (result.mode === 'branch-sales') {
      const jenis = branch.jenis.slice(0, jenisBudget); jenisBudget -= jenis.length;
      const omittedOnPage = branch.jenis.length - jenis.length; truncated ||= omittedOnPage > 0;
      return { ...branch, jenis, omittedOnPage };
    }
    const selected = branch.salespeople.slice(0, peopleBudget); peopleBudget -= selected.length;
    const salespeople = selected.map((person: Document) => {
      const jenis = person.jenis.slice(0, jenisBudget); jenisBudget -= jenis.length;
      const omittedOnPage = person.jenis.length - jenis.length; truncated ||= omittedOnPage > 0;
      return { ...person, jenis, omittedOnPage };
    });
    const omittedOnPage = branch.salespeople.length - salespeople.length; truncated ||= omittedOnPage > 0;
    return { ...branch, salespeople, omittedOnPage };
  });
  return { ...result, branches, modelTruncated: truncated };
}
export function branchSalesBlocks(result: Document): AgentResponseBlock[] {
  const bySales = result.mode === 'branch-salespeople';
  const summary: Array<Array<string | number>> = [], people: Array<Array<string | number>> = [], details: Array<Array<string | number>> = [];
  const notes = new Set<string>();
  let partial = !!result.partial || !!result.modelTruncated;
  for (const branch of result.branches) {
    const label = `${branch.alias} (${branch.branchId})`;
    if (branch.status !== 'available') { notes.add(`${label}: data tidak tersedia, bukan penjualan nol.`); continue; }
    summary.push([label, branch.totals.weightGram, branch.totals.salesAmountIdr]);
    if (branch.totals.recordsWithoutWeight) notes.add(`${label}: ${branch.totals.recordsWithoutWeight} baris tanpa berat positif; total gram belum lengkap.`);
    for (const warning of branch.warnings ?? []) notes.add(`${label}: ${warning}`);
    if (branch.hasMore || branch.omittedOnPage) { partial = true; notes.add(`${label}: rincian belum seluruhnya tampil; minta halaman berikutnya atau pilih cabang/sales tertentu.`); }
    if (bySales) for (const person of branch.salespeople) {
      people.push([label, person.salesCode, person.salesName, person.weightGram, person.salesAmountIdr]);
      for (const jenis of person.jenis) details.push([label, `${person.salesName} (${person.salesCode})`, `${jenis.kode} · ${jenis.nama}`, jenis.weightGram, jenis.salesAmountIdr]);
      if (person.jenisHasMore || person.omittedOnPage) { partial = true; notes.add(`Sales ${person.salesCode} di ${branch.branchId}: masih ada rincian Jenis; gunakan salesCode dan jenisPage berikutnya.`); }
    }
    else for (const jenis of branch.jenis) details.push([label, `${jenis.kode} · ${jenis.nama}`, jenis.weightGram, jenis.salesAmountIdr]);
  }
  const blocks: AgentResponseBlock[] = [
    { type: 'text', variant: 'heading', text: bySales ? 'Penjualan toko menurut sales dan Jenis' : 'Penjualan per toko' },
    { type: 'text', text: `Periode ${result.period.from}–${result.period.to}, inklusif Jakarta, berdasarkan tgl_system. Penjualan valid OPEN/DONE; transaksi tukar dikecualikan. Semua berat dalam gram dan nilai dalam rupiah. Total toko mencakup seluruh hasil filter; tabel rincian mengikuti halaman yang diminta.${result.filters.salesCode ? ' Total difilter untuk sales yang dipilih.' : ''}${result.filters.jenisCode ? ' Total difilter untuk Jenis yang dipilih.' : ''}` },
    { type: 'table', title: 'Total penjualan per toko', columns: ['Toko', 'Berat terjual (gram)', 'Nilai penjualan (Rp)'], rows: summary.length ? summary : [['Data cabang belum tersedia', null, null]] },
  ];
  if (bySales) blocks.push({ type: 'table', title: 'Penjualan per sales', columns: ['Toko', 'Kode sales', 'Nama sales', 'Berat terjual (gram)', 'Nilai penjualan (Rp)'], rows: people.length ? people : [[summary.length ? 'Tidak ada sales pada halaman/filter ini' : 'Data sales belum tersedia', '—', '—', summary.length ? 0 : null, summary.length ? 0 : null]] });
  if (details.length) blocks.push({ type: 'table', title: bySales ? 'Rincian Jenis per sales' : 'Rincian penjualan per Jenis', columns: bySales ? ['Toko', 'Sales', 'Jenis', 'Berat terjual (gram)', 'Nilai penjualan (Rp)'] : ['Toko', 'Jenis', 'Berat terjual (gram)', 'Nilai penjualan (Rp)'], rows: details });
  if (!bySales && !result.filters.includeJenis) blocks.push({ type: 'callout', tone: 'info', title: 'Lihat rincian Jenis', text: 'Pilih toko untuk memperinci penjualannya per Jenis, lalu pilih kode Jenis bila ingin pendalaman.' });
  if (notes.size || partial) blocks.push({ type: 'callout', tone: 'warning', title: partial ? 'Cakupan data dan rincian' : 'Catatan data', text: [...notes].slice(0, 12).join(' ') || 'Sebagian rincian dibatasi; minta cabang, sales, atau halaman tertentu. Total tidak dibatasi oleh halaman.' });
  return blocks;
}
