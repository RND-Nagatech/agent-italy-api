import { resolveAgentSourceScope, type AgentScopeSource } from './source-scope'

export type InventoryIntentSource = AgentScopeSource

export type InventoryIntent = {
  /** Undefined means the complete set of sources allowed for the user. */
  branchId?: string
}

const INVENTORY_WORD = /\b(?:stok|stock|persediaan)\b/i
const NON_SUMMARY_WORD = /\b(?:restock|re[- ]?stock|stockout|kehabisan|habis|risiko|order|supplier|pembelian|penjualan|jual|transfer|kirim|distribusi|surplus|kekurangan|terjual|laku|ditawarkan|tawaran|buyback|cuci|pencucian)\b/i
const DETAIL_WORD = /\b(?:jenis|kode)\b/i

function isInventorySummaryQuestion(question: string) {
  return INVENTORY_WORD.test(question) && !NON_SUMMARY_WORD.test(question) && !DETAIL_WORD.test(question)
}

function isInventoryFollowUp(question: string, previousQuestion: string) {
  return isInventorySummaryQuestion(previousQuestion)
    && /\b(?:kalau|kalo|klo|terus|untuk|sekarang|yang)\b/i.test(question)
}

/**
 * Resolves the source scope for a plain current-stock question.
 *
 * The brand by itself is intentionally not a store selector: “Italy” means
 * every allowed Italy source. A unique source alias/ID narrows the summary to
 * that source, while an ambiguous mention falls back to the complete scope.
 */
export function resolveInventoryIntent(
  question: string,
  sources: readonly InventoryIntentSource[],
  previousQuestion = '',
): InventoryIntent | null {
  const isDirectInventory = isInventorySummaryQuestion(question)
  const isFollowUp = !isDirectInventory && isInventoryFollowUp(question, previousQuestion)
  if (!isDirectInventory && !isFollowUp) return null

  const scope = resolveAgentSourceScope(question, sources)
  if (!scope?.branchIds || scope.branchIds.length !== 1) return {}
  return { branchId: scope.branchIds[0] }
}
