import { validPriceDate, validPriceTime, type PriceReference } from './price-audit.logic';

export type PriceAuditScopeInput = { sessionId: string; prompt: string; attachmentIds: string[] };

// Parse only explicit time ranges. Document dates and batch numbers never
// become hours. Ambiguous or multiple ranges are left for the time form.
export function explicitPriceHours(prompt: string): { fromTime: string; toTime: string } | null {
  const clock = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(pagi|siang|sore|malam|wib)?';
  const connector = '(?:s\\s*[/ .]\\s*d\\.?|sampai dengan|sampai|sampe|hingga|[-–—])';
  const pattern = new RegExp(`\\b(?:jam|pukul)\\s*${clock}\\s*${connector}\\s*(?:(?:jam|pukul)\\s*)?${clock}`, 'gi');
  const fullClock = '(\\d{1,2})[:.](\\d{2})\\s*(pagi|siang|sore|malam|wib)?';
  const explicit = [...prompt.matchAll(pattern)];
  const matches = explicit.length ? explicit : [...prompt.matchAll(new RegExp(`\\b${fullClock}\\s*${connector}\\s*${fullClock}`, 'gi'))];
  if (matches.length !== 1) return null;
  const [, h1, m1, p1, h2, m2, p2] = matches[0];
  const time = (h: string, m: string | undefined, period: string | undefined) => {
    let hour = Number(h);
    if (period && /siang|sore|malam/i.test(period) && hour >= 1 && hour < 12) hour += 12;
    if (period?.toLowerCase() === 'pagi' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${m ?? '00'}`;
  };
  const fromTime = time(h1, m1, p1), toTime = time(h2, m2, p2);
  return validPriceTime(fromTime) && validPriceTime(toTime, true) && fromTime < toTime ? { fromTime, toTime } : null;
}

export function priceAuditScope(prompt: string, references: PriceReference[]) {
  const hours = explicitPriceHours(prompt);
  const buybackAutoBatch = references.some(ref => ref.rows.some(row => row.kind === 'buyback'));
  const salesAutoBatch = references.some(ref => ref.rows.some(row => row.kind === 'sales'));
  const selectedHours = buybackAutoBatch || salesAutoBatch ? { fromTime: '00:00', toTime: '24:00' } : hours;
  const dates = [...new Set(references.map(ref => ref.date))];
  const needsDate = dates.some(date => !validPriceDate(date));
  // An explicit contradictory date must not be silently ignored.
  const namedDates = [...prompt.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/g)].map(([date]) => date.includes('/') ? date.split('/').reverse().map((v, i) => i ? v.padStart(2, '0') : v).join('-') : date);
  const dateConflict = namedDates.some(date => !dates.includes(date));
  const windows = dates.map(date => ({ date, fromTime: selectedHours?.fromTime ?? '', toTime: selectedHours?.toTime ?? '', attachmentIds: references.filter(ref => ref.date === date).map(ref => ref.id) }));
  const selection = !needsDate && !dateConflict && selectedHours ? { windows, toleranceRp: 0, buybackRatesFinal: true, buybackAutoBatch, salesAutoBatch, salesMarketplaceOnly: salesAutoBatch, kadarOverrides: [] } : undefined;
  return { handled: true as const, needsTime: !selectedHours, needsDate, dateConflict, buybackAutoBatch, salesAutoBatch, references, windows, selection };
}
