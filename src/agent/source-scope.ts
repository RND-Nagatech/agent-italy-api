export type AgentScopeSource = {
  alias: string
  branchId: string
  sourceType: 'branch' | 'central'
}

/** Undefined branchIds means every source allowed for the current user. */
export type AgentSourceScope = {
  branchIds?: string[]
  sourceType?: 'branch' | 'central'
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function sourceLabels(source: AgentScopeSource) {
  const shortAlias = source.alias.replace(/^ITALY\s+/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  return [...new Set([
    source.alias,
    source.branchId,
    shortAlias,
    source.alias.replace(/^ITALY\s+/i, '').trim(),
  ].map(normalize).filter(label => label && !/^(?:italy|pantes)$/.test(label)))]
}

function mentionsSource(question: string, source: AgentScopeSource) {
  const normalizedQuestion = ` ${normalize(question)} `
  return sourceLabels(source).some(label => normalizedQuestion.includes(` ${label} `))
}

/**
 * Resolves explicit store scope without asking the model to guess.
 * "Italy" alone is the network brand and therefore returns all allowed
 * sources; a unique store label returns that source; multiple labels preserve
 * the explicitly selected set.
 */
export function resolveAgentSourceScope(
  question: string,
  sources: readonly AgentScopeSource[],
): AgentSourceScope | null {
  const mentionsItalyBrand = /\b(?:italy|pantes)\b/i.test(question)
  const requestsAllSources = /\b(?:semua|seluruh)\s+(?:toko|cabang|sumber)\b/i.test(normalize(question))
  const matched = sources.filter(source => mentionsSource(question, source))
  if (!matched.length) return mentionsItalyBrand || requestsAllSources ? {} : null

  const branchIds = [...new Set(matched.map(source => source.branchId))]
  return branchIds.length === 1
    ? { branchIds, sourceType: matched[0].sourceType }
    : { branchIds }
}

const BRANCH_IDS_TOOLS = new Set([
  'aggregate_data',
  'get_branch_sales',
  'get_sales_by_salesperson',
  'get_sales_period',
  'get_current_stock',
  'get_shipments_period',
  'get_buyback_period',
  'get_transaction_report',
])

const SINGLE_BRANCH_TOOLS = new Set(['analyze_inventory_summary', 'analyze_sales_period_report', 'analyze_stock_vs_sales'])

/** Applies the resolved scope to model tool arguments before validation/execution. */
export function applyAgentSourceScopeToToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  scope: AgentSourceScope,
): Record<string, unknown> {
  if (BRANCH_IDS_TOOLS.has(toolName)) {
    if (scope.branchIds?.length) args.branchIds = [...scope.branchIds]
    else delete args.branchIds
    if (toolName === 'get_current_stock') {
      if (scope.sourceType) args.sourceType = scope.sourceType
      else delete args.sourceType
    }
    return args
  }

  if (SINGLE_BRANCH_TOOLS.has(toolName)) {
    if (scope.branchIds?.length === 1) args.branchId = scope.branchIds[0]
    else delete args.branchId
    return args
  }

  return args
}
