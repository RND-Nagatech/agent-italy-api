import type { PriceKind, PriceReference } from './price-audit.logic';

/** Panels in one attachment retain their own header and physical price rows. */
export function priceReferenceParts(references: PriceReference[]): PriceReference[] {
  return references.flatMap(ref => ref.sections?.length ? ref.sections.map((section, index) => ({
    ...ref, ...section, id: `${ref.id}#${index + 1}`, sections: undefined,
  })) : [ref]);
}

export type HeaderPeriod = { batch: number; fromTime: string; toTime: string; refs: PriceReference[] };
export type HeaderSchedule = { hasTimes: boolean; valid: boolean; reason: string; periods: HeaderPeriod[] };

/** Starts are inclusive, the next printed start is exclusive, and the last ends at 24:00 WIB. */
export function headerSchedule(references: PriceReference[], date: string, kind: PriceKind = 'buyback'): HeaderSchedule {
  const refs = priceReferenceParts(references).filter(ref => ref.date === date && ref.rows.some(row => row.kind === kind));
  const hasTimes = refs.some(ref => ref.effectiveFrom !== undefined && ref.effectiveFrom !== null && ref.effectiveFrom !== '');
  const invalid = (reason: string): HeaderSchedule => ({ hasTimes, valid: false, reason, periods: [] });
  if (!hasTimes) return invalid('Jam mulai berlaku tidak tercantum pada file acuan.');
  if (refs.some(ref => !Number.isInteger(ref.batch) || ref.batch! < 1 || ref.batch! > 999)) return invalid('Nomor batch pada salah satu header belum terbaca; jadwal batch belum dapat dipastikan.');
  if (refs.some(ref => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(ref.effectiveFrom ?? ''))) return invalid('Ada file acuan yang jam mulai berlakunya belum terbaca atau tidak valid; batch tidak ditebak dari harga.');
  const groups = new Map<number, PriceReference[]>();
  for (const ref of refs) groups.set(ref.batch!, [...(groups.get(ref.batch!) ?? []), ref]);
  for (const [batch, files] of groups) if (new Set(files.map(ref => ref.effectiveFrom)).size !== 1) return invalid(`Jam mulai berlaku Batch ${batch} berbeda antarfile; periksa header acuan.`);
  const periods = [...groups].map(([batch, files]) => ({ batch, fromTime: files[0].effectiveFrom!, toTime: '24:00', refs: files })).sort((a, b) => a.fromTime.localeCompare(b.fromTime));
  if (new Set(periods.map(period => period.fromTime)).size !== periods.length) return invalid('Beberapa batch mulai pada jam yang sama; jadwalnya belum dapat dibedakan.');
  for (let index = 0; index < periods.length - 1; index++) periods[index].toTime = periods[index + 1].fromTime;
  return { hasTimes, valid: true, reason: '', periods };
}
