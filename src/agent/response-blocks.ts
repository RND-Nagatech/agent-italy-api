export type AgentResponseBlock =
  | { type: 'text'; text: string; variant?: 'body' | 'heading' | 'muted' }
  | { type: 'comparison'; title: string; leftLabel: string; leftValue: number; rightLabel: string; rightValue: number; unit: 'gram' | 'pcs' | 'IDR'; note?: string }
  | { type: 'analysis'; title: string; summary: string; findings: string[]; actions: string[] }
  | { type: 'metric'; label: string; value: string | number; unit?: string; note?: string; tone?: 'navy' | 'teal' | 'amber' | 'violet' }
  | { type: 'line_chart'; title: string; series: Array<{ name: string; points: Array<{ label: string; value: number }> }>; unit?: string }
  | { type: 'bar_chart'; title: string; items: Array<{ label: string; value: number; detail?: string }>; unit?: string }
  | { type: 'donut_chart'; title: string; items: Array<{ label: string; value: number }>; centerLabel?: string; centerValue?: string; unit?: string }
  | { type: 'waterfall_chart'; title: string; startLabel: string; startValue: number; steps: Array<{ label: string; value: number }>; endLabel: string; endValue: number; unit?: string }
  | { type: 'table'; title?: string; columns: string[]; rows: Array<Array<string | number | null>> }
  | { type: 'list'; title?: string; items: string[] }
  | { type: 'callout'; tone: 'info' | 'success' | 'warning' | 'critical'; title?: string; text: string };

const MAX_BLOCKS = 16;
const GOODS_COUNT_UNIT = /^(?:qty|quantity|quantities|unit|units|pcs|pieces|buah|item|items)$/i;
const GOODS_COUNT_LABEL = /\b(?:qty|quantity|quantities|pcs|pieces|unit|units|barang\s+terjual|jumlah\s+barang|total\s+barang|jumlah\s+items?|jumlah\s+unit|stok\s+unit|unit\s+terjual|sisa\s+unit)\b/i;
const STRUCTURAL_COUNT_LABEL = /^(?:jumlah\s+)?(?:cabang|jenis|dokumen|rute|sumber|invoice|faktur|baris|toko)\b/i;
const WEIGHT_LABEL = /\b(?:berat|weight|gram)\b/i;
const WEIGHT_TABLE_COLUMN = /\b(?:berat|weight|gram|stok\b|stock\b|restock|surplus|kekurangan|transfer|open\s+masuk|terjual)\b/i;
const GOODS_COUNT_CHART_LABEL = /\b(?:qty|quantity|pcs|unit|units|jumlah\s+barang|total\s+barang|items?|barang\s+terjual)\b/i;

/** Parse a model response into a small, safe display protocol. Strings stay plain data; the UI never renders HTML. */
export function parseAgentResponseBlocks(answer: string): AgentResponseBlock[] {
  const structured = parseStructuredBlocks(answer);
  if (structured) return structured;
  return parseMarkdownFallback(answer);
}

/** Keep the legacy answer field useful to older clients and conversational history. */
export function agentResponseBlocksToText(blocks: AgentResponseBlock[]): string {
  const text = blocks.map((block) => {
    switch (block.type) {
      case 'text': return block.text;
      case 'comparison': return `${block.title}: ${block.leftLabel} ${block.leftValue} ${block.unit} vs ${block.rightLabel} ${block.rightValue} ${block.unit}${block.note ? `. ${block.note}` : ''}`;
      case 'analysis': return [block.title, block.summary, ...block.findings, ...block.actions].join('\n');
      case 'metric': return `${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ''}${block.note ? ` (${block.note})` : ''}`;
      case 'line_chart': return `${block.title}\n${block.series.map((series) => `${series.name}: ${series.points.map((point) => `${point.label} ${point.value}${block.unit ? ` ${block.unit}` : ''}`).join(', ')}`).join('\n')}`;
      case 'bar_chart': return `${block.title}\n${block.items.map((item) => `${item.label}: ${item.value}${block.unit ? ` ${block.unit}` : ''}${item.detail ? ` ${item.detail}` : ''}`).join('\n')}`;
      case 'donut_chart': return `${block.title}\n${block.items.map((item) => `${item.label}: ${item.value}${block.unit ? ` ${block.unit}` : ''}`).join('\n')}`;
      case 'waterfall_chart': return `${block.title}\n${block.startLabel}: ${block.startValue}${block.unit ? ` ${block.unit}` : ''}\n${block.steps.map((step) => `${step.label}: ${step.value}`).join('\n')}\n${block.endLabel}: ${block.endValue}${block.unit ? ` ${block.unit}` : ''}`;
      case 'table': return [block.title, block.columns.join(' | '), ...block.rows.map((row) => row.map((cell) => cell ?? '—').join(' | '))].filter(Boolean).join('\n');
      case 'list': return [block.title, ...block.items.map((item) => `• ${item}`)].filter(Boolean).join('\n');
      case 'callout': return `${block.title ? `${block.title}: ` : ''}${block.text}`;
    }
  }).filter(Boolean).join('\n\n');
  return text.trim();
}

/** Apply the application's merchandise-weight vocabulary to every model and fallback response. */
export function normalizeAgentResponseBlocks(blocks: AgentResponseBlock[]): AgentResponseBlock[] {
  return blocks.flatMap((block): AgentResponseBlock[] => {
    const explicitPcs = ('unit' in block && block.unit === 'pcs')
      || (block.type === 'table' && block.columns.some(column => /\bpcs\b/i.test(column)));
    if (explicitPcs) return [block];
    switch (block.type) {
      case 'comparison': return [{ ...block, title: normalizeAgentText(block.title), leftLabel: normalizeAgentText(block.leftLabel), rightLabel: normalizeAgentText(block.rightLabel), ...(block.note ? { note: normalizeAgentText(block.note) } : {}) }];
      case 'analysis': return [{ ...block, title: normalizeAgentText(block.title), summary: normalizeAgentText(block.summary), findings: block.findings.map(normalizeAgentText), actions: block.actions.map(normalizeAgentText) }];
      case 'text': {
        const text = normalizeAgentText(block.text);
        return text ? [{ ...block, text }] : [];
      }
      case 'metric': {
        if ((GOODS_COUNT_UNIT.test(block.unit ?? '') || GOODS_COUNT_LABEL.test(block.label))
          && !STRUCTURAL_COUNT_LABEL.test(block.label)) return [];
        const label = normalizeAgentText(block.label);
        const value = typeof block.value === 'string' ? normalizeAgentText(block.value) : block.value;
        const weightUnavailable = typeof value === 'string' && /\bberat tidak tersedia\b/i.test(value);
        const valueAlreadyHasWeight = typeof value === 'string' && /\bgram\b/i.test(value);
        const structuralUnit = GOODS_COUNT_UNIT.test(block.unit ?? '') && STRUCTURAL_COUNT_LABEL.test(label)
          ? label.match(/cabang|jenis|dokumen|rute|sumber|invoice|faktur|baris|toko/i)?.[0]
          : undefined;
        const unit = weightUnavailable || valueAlreadyHasWeight
          ? undefined
          : structuralUnit ?? normalizeAgentUnit(block.unit, isWeightChartContext(label));
        return [{
          ...block,
          label,
          value,
          ...(unit ? { unit } : {}),
          ...(block.note ? { note: normalizeAgentText(block.note) } : {}),
        }];
      }
      case 'line_chart': {
        if (GOODS_COUNT_CHART_LABEL.test(`${block.title} ${block.series.map((series) => series.name).join(' ')}`)) return [];
        const unit = normalizeAgentUnit(block.unit, isWeightChartContext(block.title));
        return [{
          ...block,
          title: normalizeChartTitle(normalizeAgentText(block.title), unit),
          unit,
          series: block.series.map((series) => ({
            ...series,
            name: normalizeAgentText(series.name),
            points: series.points.map((point) => ({ ...point, label: normalizeAgentText(point.label) })),
          })),
        }];
      }
      case 'bar_chart': {
        if (GOODS_COUNT_CHART_LABEL.test(block.title)) return [];
        const unit = normalizeAgentUnit(block.unit, isWeightChartContext(block.title));
        return [{
          ...block,
          title: normalizeChartTitle(normalizeAgentText(block.title), unit),
          unit,
          items: block.items.map((item) => ({
            ...item,
            label: normalizeAgentText(item.label),
            ...(item.detail ? { detail: normalizeAgentText(item.detail) } : {}),
          })),
        }];
      }
      case 'donut_chart': {
        if (GOODS_COUNT_CHART_LABEL.test(block.title)) return [];
        const unit = normalizeAgentUnit(block.unit, isWeightChartContext(block.title));
        return [{
          ...block,
          title: normalizeChartTitle(normalizeAgentText(block.title), unit),
          unit,
          items: block.items.map((item) => ({ ...item, label: normalizeAgentText(item.label) })),
          ...(block.centerLabel ? { centerLabel: normalizeAgentText(block.centerLabel) } : {}),
          ...(block.centerValue ? { centerValue: normalizeAgentText(block.centerValue) } : {}),
        }];
      }
      case 'waterfall_chart': {
        const unit = normalizeAgentUnit(block.unit, isWeightChartContext(block.title));
        return [{
          ...block,
          title: normalizeChartTitle(normalizeAgentText(block.title), unit),
          startLabel: normalizeAgentText(block.startLabel),
          endLabel: normalizeAgentText(block.endLabel),
          steps: block.steps.map((step) => ({ ...step, label: normalizeAgentText(step.label) })),
          ...(unit ? { unit } : {}),
        }];
      }
      case 'table': {
        const keepColumns = block.columns.map((column, index) => ({ column, index }))
          .filter(({ column }) => !GOODS_COUNT_LABEL.test(column));
        if (!keepColumns.length) return [];
        const columns = keepColumns.map(({ column }) => {
          const normalized = normalizeAgentText(column);
          return WEIGHT_TABLE_COLUMN.test(normalized) && !/\bgram\b/i.test(normalized)
            ? `${normalized} (gram)`
            : normalized;
        });
        return [{
          ...block,
          ...(block.title ? { title: normalizeAgentText(block.title) } : {}),
          columns,
          rows: block.rows.map((row) => keepColumns.map(({ index }) => {
            const cell = row[index];
            return typeof cell === 'string' ? normalizeAgentText(cell) : cell;
          })),
        }];
      }
      case 'list': {
        const items = block.items.map(normalizeAgentText).filter(Boolean);
        return items.length ? [{ ...block, ...(block.title ? { title: normalizeAgentText(block.title) } : {}), items }] : [];
      }
      case 'callout': {
        const text = normalizeAgentText(block.text);
        return text ? [{ ...block, text, ...(block.title ? { title: normalizeAgentText(block.title) } : {}) }] : [];
      }
    }
  });
}

function normalizeAgentUnit(unit: string | undefined, weightContext: boolean): string | undefined {
  if (unit && /^(?:berat|weight|g|gram)$/i.test(unit.trim())) return 'gram';
  if (weightContext) return 'gram';
  return unit ? normalizeAgentText(unit) : undefined;
}

function isWeightChartContext(title: string): boolean {
  const moneyContext = /\b(?:nilai|nominal|rupiah|harga|revenue|rp)\b/i.test(title);
  const merchandiseContext = /\b(?:berat|weight|gram|restock|stok|stock|surplus|kekurangan|transfer|terjual|penjualan|buyback|cuci|pencucian)\b/i.test(title);
  return WEIGHT_LABEL.test(title) || (merchandiseContext && !moneyContext);
}

function normalizeChartTitle(title: string, unit: string | undefined): string {
  return unit === 'gram' && !/\bgram\b/i.test(title) ? `${title} (gram)` : title;
}

function normalizeAgentText(value: string): string {
  if (/\bpcs\b/i.test(value)) return value.replace(/\s+/g, ' ').trim();
  return value
    .replace(/(\d[\d.,]*)\s*berat\b/gi, '$1 gram')
    .replace(/\bberat(?:nya)?\s+(\d[\d.,]*)(?!\s*gram\b)/gi, '$1 gram')
    .replace(/(\d[\d.,]*)\s*gram\s+berat\b/gi, '$1 gram')
    .replace(/\b(stok|stock|restock|surplus|kekurangan|transfer|terjual)\b\s*(?::|sebesar|sebanyak|mencapai|adalah)?\s*(\d[\d.,]*)(?!\s*gram\b)/gi, '$1 $2 gram')
    .replace(/\bberat\s*\(satuan sumber\)/gi, 'gram')
    .replace(/\b(?:jumlah|total)\s+(?:barang|items?)\s*[:=]?\s*[\d.,]+/gi, 'berat tidak tersedia')
    .replace(/\b(?:barang|items?)\s+terjual\s*[:=]?\s*[\d.,]+/gi, 'berat tidak tersedia')
    .replace(/\b(?:qty|quantity|quantities|unit|units|pcs|pieces|buah|item|items)\s*[:=]\s*[\d.,]+/gi, 'berat tidak tersedia')
    .replace(/[\d.,]+\s*(?:qty|quantity|quantities|unit|units|pcs|pieces|buah|items?|barang)\b/gi, 'berat tidak tersedia')
    .replace(/\bjumlah\s+(?:qty|quantity|quantities|unit|units|pcs|pieces|barang)\b/gi, 'berat')
    .replace(/\b(?:qty|quantity|quantities|unit|units|pcs|pieces)\b/gi, 'gram')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseStructuredBlocks(answer: string): AgentResponseBlock[] | null {
  const candidate = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) return null;

  const blocks = parsed.blocks.slice(0, MAX_BLOCKS).flatMap((raw): AgentResponseBlock[] => {
    const block = parseBlock(raw);
    return block ? [block] : [];
  });
  return blocks.length ? blocks : null;
}

function parseBlock(value: unknown): AgentResponseBlock | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'comparison': {
      const title = safeText(value.title, 160), leftLabel = safeText(value.leftLabel, 160), rightLabel = safeText(value.rightLabel, 160);
      if (!title || !leftLabel || !rightLabel || typeof value.leftValue !== 'number' || !Number.isFinite(value.leftValue) || typeof value.rightValue !== 'number' || !Number.isFinite(value.rightValue) || !['gram', 'pcs', 'IDR'].includes(String(value.unit))) return null;
      const note = safeText(value.note);
      return { type: 'comparison', title, leftLabel, rightLabel, leftValue: value.leftValue, rightValue: value.rightValue, unit: value.unit as 'gram' | 'pcs' | 'IDR', ...(note ? { note } : {}) };
    }
    case 'analysis': {
      const title = safeText(value.title, 160), summary = safeText(value.summary);
      if (!title || !summary) return null;
      const texts = (input: unknown) => Array.isArray(input) ? input.slice(0, 8).map(item => safeText(item)).filter((item): item is string => Boolean(item)) : [];
      return { type: 'analysis', title, summary, findings: texts(value.findings), actions: texts(value.actions) };
    }
    case 'text': {
      const text = safeText(value.text);
      if (!text) return null;
      const variant = value.variant === 'heading' || value.variant === 'muted' ? value.variant : 'body';
      return { type: 'text', text, variant };
    }
    case 'metric': {
      const label = safeText(value.label, 120);
      const metricValue = safeScalar(value.value);
      if (!label || metricValue === null) return null;
      const tone = value.tone === 'teal' || value.tone === 'amber' || value.tone === 'violet' ? value.tone : 'navy';
      return {
        type: 'metric', label, value: metricValue, tone,
        ...(safeText(value.unit, 50) ? { unit: safeText(value.unit, 50)! } : {}),
        ...(safeText(value.note) ? { note: safeText(value.note)! } : {}),
      };
    }
    case 'line_chart': {
      const title = safeText(value.title, 160);
      if (!title || !Array.isArray(value.series)) return null;
      const series = value.series.slice(0, 4).flatMap((rawSeries) => {
        if (!isRecord(rawSeries) || !Array.isArray(rawSeries.points)) return [];
        const name = safeText(rawSeries.name, 80);
        const points = rawSeries.points.slice(0, 31).flatMap((rawPoint) => {
          if (!isRecord(rawPoint) || !isFiniteNumber(rawPoint.value)) return [];
          const label = safeText(rawPoint.label, 40);
          return label ? [{ label, value: rawPoint.value }] : [];
        });
        return name && points.length ? [{ name, points }] : [];
      });
      return series.length ? {
        type: 'line_chart', title, series,
        ...(safeText(value.unit, 30) ? { unit: safeText(value.unit, 30)! } : {}),
      } : null;
    }
    case 'bar_chart': {
      const title = safeText(value.title, 160);
      if (!title || !Array.isArray(value.items)) return null;
      const items = value.items.slice(0, 16).flatMap((rawItem) => {
        if (!isRecord(rawItem) || !isFiniteNumber(rawItem.value)) return [];
        const label = safeText(rawItem.label, 100);
        return label ? [{ label, value: rawItem.value, ...(safeText(rawItem.detail) ? { detail: safeText(rawItem.detail)! } : {}) }] : [];
      });
      return items.length ? {
        type: 'bar_chart', title, items,
        ...(safeText(value.unit, 30) ? { unit: safeText(value.unit, 30)! } : {}),
      } : null;
    }
    case 'donut_chart': {
      const title = safeText(value.title, 160);
      if (!title || !Array.isArray(value.items)) return null;
      const items = value.items.slice(0, 10).flatMap((rawItem) => {
        if (!isRecord(rawItem) || !isFiniteNumber(rawItem.value) || rawItem.value < 0) return [];
        const label = safeText(rawItem.label, 100);
        return label ? [{ label, value: rawItem.value }] : [];
      });
      return items.length ? {
        type: 'donut_chart', title, items,
        ...(safeText(value.centerLabel, 50) ? { centerLabel: safeText(value.centerLabel, 50)! } : {}),
        ...(safeText(value.centerValue, 60) ? { centerValue: safeText(value.centerValue, 60)! } : {}),
        ...(safeText(value.unit, 30) ? { unit: safeText(value.unit, 30)! } : {}),
      } : null;
    }
    case 'waterfall_chart': {
      const title = safeText(value.title, 160);
      const startLabel = safeText(value.startLabel, 80);
      const endLabel = safeText(value.endLabel, 80);
      if (!title || !startLabel || !endLabel || !isFiniteNumber(value.startValue) || value.startValue < 0
        || !isFiniteNumber(value.endValue) || value.endValue < 0 || !Array.isArray(value.steps)) return null;
      const steps = value.steps.slice(0, 6).flatMap((rawStep) => {
        if (!isRecord(rawStep) || !isFiniteNumber(rawStep.value)) return [];
        const label = safeText(rawStep.label, 80);
        return label ? [{ label, value: rawStep.value }] : [];
      });
      let calculatedEnd = value.startValue;
      for (const step of steps) {
        calculatedEnd += step.value;
        if (calculatedEnd < 0) return null;
      }
      if (Math.abs(calculatedEnd - value.endValue) > 0.01) return null;
      return {
        type: 'waterfall_chart', title, startLabel, startValue: value.startValue,
        steps, endLabel, endValue: value.endValue,
        ...(safeText(value.unit, 30) ? { unit: safeText(value.unit, 30)! } : {}),
      };
    }
    case 'table': {
      const columns = Array.isArray(value.columns) ? value.columns.slice(0, 8).map((cell, index) => safeText(cell, 120) ?? `Kolom ${index + 1}`) : [];
      if (!columns.length || !Array.isArray(value.rows)) return null;
      const rows = value.rows.slice(0, 100).flatMap((rawRow) => Array.isArray(rawRow)
        ? [columns.map((_, index) => safeCell(rawRow[index] ?? null))]
        : []);
      return {
        type: 'table', columns, rows,
        ...(safeText(value.title, 160) ? { title: safeText(value.title, 160)! } : {}),
      };
    }
    case 'list': {
      const items = Array.isArray(value.items) ? value.items.slice(0, 16).map((item) => safeText(item, 300)).filter((item): item is string => Boolean(item)) : [];
      return items.length ? { type: 'list', items, ...(safeText(value.title, 160) ? { title: safeText(value.title, 160)! } : {}) } : null;
    }
    case 'callout': {
      const text = safeText(value.text);
      if (!text) return null;
      const tone = value.tone === 'success' || value.tone === 'warning' || value.tone === 'critical' ? value.tone : 'info';
      return { type: 'callout', tone, text, ...(safeText(value.title, 160) ? { title: safeText(value.title, 160)! } : {}) };
    }
    default:
      return null;
  }
}

function parseMarkdownFallback(answer: string): AgentResponseBlock[] {
  const lines = answer.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').split(/\r?\n/);
  const blocks: AgentResponseBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ type: 'text', text, variant: 'body' });
    paragraph = [];
  };
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

  for (let index = 0; index < lines.length && blocks.length < MAX_BLOCKS; index += 1) {
    const line = lines[index].trim();
    if (!line) { flushParagraph(); continue; }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: 'text', text: heading[1].replace(/\s*#+$/, ''), variant: 'heading' }); continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      flushParagraph();
      const columns = cells(line);
      index += 1;
      const rows: Array<Array<string | null>> = [];
      while (index + 1 < lines.length && lines[index + 1].includes('|')) {
        index += 1;
        rows.push(cells(lines[index]));
      }
      blocks.push({ type: 'table', columns, rows: rows.map((row) => columns.map((_, cellIndex) => row[cellIndex] ?? null)) });
      continue;
    }
    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listMatch) {
      flushParagraph();
      const items = [listMatch[1]];
      while (index + 1 < lines.length) {
        const nextItem = lines[index + 1].match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
        if (!nextItem) break;
        items.push(nextItem[1]); index += 1;
      }
      blocks.push({ type: 'list', items: items.slice(0, 16) });
      continue;
    }
    if (/^([-*_]\s*){3,}$/.test(line)) { flushParagraph(); continue; }
    paragraph.push(line.replace(/^>\s?/, ''));
  }
  flushParagraph();
  return blocks.length ? blocks.slice(0, MAX_BLOCKS) : [{ type: 'text', text: answer.trim(), variant: 'body' }];
}

function safeText(value: unknown, maxLength?: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const result = maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
  return result || null;
}

function safeScalar(value: unknown): string | number | null {
  if (typeof value === 'string') return value.trim() || null;
  return isFiniteNumber(value) ? value : null;
}

function safeCell(value: unknown): string | number | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 'Ya' : 'Tidak';
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
