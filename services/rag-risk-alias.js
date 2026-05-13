/**
 * Maps query-string risk_level values to DB risk_level tokens (Low | Medium | Hard).
 */
function normalizeRagRiskLevel(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  const compact = v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {
    low: 'Low',
    budget: 'Low',
    good: 'Low',
    matechoice: 'Low',
    mateschoice: 'Low',
    mateschoise: 'Low',
    medium: 'Medium',
    mid: 'Medium',
    better: 'Medium',
    builderspick: 'Medium',
    high: 'Hard',
    hard: 'Hard',
    best: 'Hard',
    premium: 'Hard',
    tradiesdream: 'Hard',
  };
  const direct = {
    Low: 'Low',
    Medium: 'Medium',
    Hard: 'Hard',
    High: 'Hard',
  };
  if (direct[v]) return direct[v];
  return map[v.toLowerCase()] || map[compact] || null;
}

module.exports = { normalizeRagRiskLevel };
