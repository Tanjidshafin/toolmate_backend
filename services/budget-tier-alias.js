const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Maps decision-log / saved tier strings to canonical low | mid | high.
 */
function inferBudgetTierFromJobState(jobState = {}, existingBudgetTier = null) {
  const decisionEntries = Array.isArray(jobState?.decisionLog) ? jobState.decisionLog : [];
  const budgetDecision = decisionEntries
    .slice()
    .reverse()
    .find((entry) => entry?.key === 'budgetTier' && entry?.value !== undefined && entry?.value !== null);
  const rawBudgetTier = normalizeText(budgetDecision?.value || existingBudgetTier);
  if (!rawBudgetTier && jobState?.savedShoppingList?.estimatedSpendByBudgetTier) {
    return 'mid';
  }
  if (!rawBudgetTier) return null;
  const lowered = rawBudgetTier.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, '');
  if (
    ['low', 'good', 'budget', 'matechoice', 'mateschoice', 'mateschoise'].includes(lowered) ||
    compact === 'mateschoice' ||
    compact === 'matechoice'
  )
    return 'low';
  if (['mid', 'medium', 'better', 'builderspick'].includes(lowered) || compact === 'builderspick') return 'mid';
  if (
    ['high', 'best', 'premium', 'hard', 'tradiesdream'].includes(lowered) ||
    compact === 'tradiesdream' ||
    compact === 'hard'
  )
    return 'high';
  return rawBudgetTier || null;
}

module.exports = { inferBudgetTierFromJobState, normalizeText };
