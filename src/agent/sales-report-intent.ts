export function allStoreSalesTodayQuery(question: string, today: string) {
  const normalized = question.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const isTodaySales = /^(?:(?:tolong|berikan|tampilkan|munculkan|lihat|berapa|total|laporan|transaksi|data)\s+)*penjualan(?:\s+italy)?\s+hari\s+ini(?:\s+(?:berapa|aja|saja|dong|bro|semua toko|seluruh toko))*$/.test(normalized);
  return isTodaySales ? { reportType: 'sales' as const, from: today, to: today } : null;
}
