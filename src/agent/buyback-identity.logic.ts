import type { PriceReference, PriceRule } from './price-audit.logic';

// Delimited codes are exact. Attached suffixes use the longest printed prefix.
export function buybackCode(value: string, knownCodes: string[] = []): string {
  const text = value.trim().toUpperCase();
  const token = text.match(/^([A-Z][A-Z0-9]{1,2})(?=$|[\s./_-])/)?.[1];
  if (token) return token;
  const candidates = knownCodes.filter(code => /^[A-Z][A-Z0-9]{1,2}$/.test(code) && text.startsWith(code)).sort((a, b) => b.length - a.length);
  return candidates[0] ?? text.match(/^([A-Z]\d{1,2})/)?.[1] ?? '';
}

const normalized = (value: string) => value.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
const labels = (value: string) => [value, ...value.split(/\s*\/\s*/)].map(normalized).filter(Boolean);
const labelWords = (value: string) => normalized(value).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
function namedLabelMatches(label: string, value: string): boolean {
  const words = labelWords(label).split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Legacy intern names can include a size/model after the printed brand: STAR 6R,
  // SHINE 50, EG900 54 1M. Only numeric suffixes are ignored; unrelated names/abbreviations stay unverified.
  return new RegExp(`^${words.join('\\s*')}(?:$|\\s+\\d[A-Z0-9]*(?:\\s+\\d[A-Z0-9]*)*)$`).test(labelWords(value));
}
export type BuybackIdentity = { code: string; codes: string[]; label?: string };

/** Named legacy intern values are matched only to labels actually printed in the uploaded file. */
export function buybackIdentity(value: string, references: PriceReference[]): BuybackIdentity {
  const rows = references.flatMap(ref => ref.rows.filter(row => row.kind === 'buyback'));
  const knownCodes = [...new Set(rows.map(row => row.sourceCode.toUpperCase()).filter(Boolean))];
  const code = buybackCode(value, knownCodes);
  if (knownCodes.includes(code)) return { code, codes: [code] };
  const label = normalized(value);
  let matching = rows.filter(row => row.sourceLabel && labels(row.sourceLabel).includes(label));
  if (!matching.length) {
    matching = rows.filter(row => row.sourceLabel && labels(row.sourceLabel).some(alias => namedLabelMatches(alias, value)));
    const specific = Math.max(0, ...matching.map(row => labelWords(row.sourceLabel!).replace(/\s/g, '').length));
    matching = matching.filter(row => labelWords(row.sourceLabel!).replace(/\s/g, '').length === specific);
  }
  const codes = [...new Set(matching.map(row => row.sourceCode.toUpperCase()).filter(Boolean))];
  if (codes.length) return { code: codes.join(' / '), codes, label };
  return { code, codes: code ? [code] : [] };
}

export function matchesBuybackIdentity(row: PriceRule, identity: BuybackIdentity): boolean {
  return identity.codes.includes(row.sourceCode.toUpperCase()) && (!identity.label || labels(row.sourceLabel ?? '').some(alias => alias === identity.label || namedLabelMatches(alias, identity.label!)));
}
