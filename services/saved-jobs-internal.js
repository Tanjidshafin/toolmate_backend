/**
 * Shared saved-job ownership + meaningful-draft validation (unit-testable).
 */

const { normalizeEmail } = require('./auth-middleware');

const INVALID_JOB_TITLES = new Set([
  'new chat',
  'what are we fixing, building, or figuring out',
  'what are we fixing building or figuring out',
  'no idea where to start',
  'great question',
]);

const normalizeTitle = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const countUniqueStrings = (items) => {
  if (!Array.isArray(items)) return 0;
  return new Set(
    items.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : '')).filter(Boolean),
  ).size;
};

const isUsefulText = (value) => {
  if (!value || typeof value !== 'string') return false;
  const normalized = normalizeTitle(value);
  if (!normalized) return false;
  const noise = new Set(['none', 'no recommendation yet', 'confirm next material tool choice', 'new chat']);
  return !noise.has(normalized);
};

/**
 * Mirrors frontend isValidJobTitle for POST /jobs/save validation.
 */
const isValidJobTitleForSave = (title) => {
  if (!title || typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (trimmed.length < 5) return false;
  const normalized = normalizeTitle(trimmed);
  if (!normalized) return false;
  if (INVALID_JOB_TITLES.has(normalized)) return false;
  if (normalized.endsWith('great question')) return false;
  return true;
};

/**
 * Saved job row ownership. Mismatched userId cannot be bypassed with email.
 * Soft-deleted jobs never pass.
 * Email-only `authUser` is allowed for provider webhooks when the job row is legacy email-scoped.
 */
const ownsSavedJob = (doc, authUser) => {
  if (!doc) return false;
  if (doc.deletedAt != null) return false;
  const authEmail = normalizeEmail(authUser?.userEmail);
  if (doc.userId) {
    if (!authUser?.userId) return false;
    return doc.userId === authUser.userId;
  }
  return Boolean(authEmail && normalizeEmail(doc.userEmail) === authEmail);
};

/**
 * Matey chat session ownership (for promoting a session to a saved job).
 * If session has userId, it must match; legacy rows without userId may match email only.
 */
const ownsChatSession = (sessionDoc, authUser) => {
  if (!sessionDoc || !authUser?.userId) return false;
  if (sessionDoc.userId) {
    return sessionDoc.userId === authUser.userId;
  }
  const sessionEmail = normalizeEmail(sessionDoc.userEmail);
  const authEmail = normalizeEmail(authUser.userEmail);
  return Boolean(sessionEmail && authEmail && sessionEmail === authEmail);
};

const getBudgetChoice = (jobState) => {
  const decisionLog = Array.isArray(jobState?.decisionLog) ? jobState.decisionLog : [];
  const budgetDecision = decisionLog
    .slice()
    .reverse()
    .find((entry) => entry?.key === 'budgetTier' && entry?.value);
  if (!budgetDecision) return null;
  return String(budgetDecision.value).trim() || null;
};

/**
 * Core meaningful-draft evaluation (sync). Pass resolved message counts.
 * Hybrid rule: >=2 strong artifact signals OR text-only meaningful path.
 */
const evaluateMeaningfulDraft = ({
  jobState = {},
  resolvedTitle,
  userMessageCount,
  mateyMessageCount,
  totalSuggestedTools = 0,
  totalImageAttachments = 0,
}) => {
  const savedShoppingList = jobState.savedShoppingList || {};
  const mustBuy = countUniqueStrings(savedShoppingList.mustBuy);
  const consumables = countUniqueStrings(savedShoppingList.consumables);
  const safety = countUniqueStrings(savedShoppingList.safety);
  const hire = countUniqueStrings(savedShoppingList.hireOrBorrow);
  const optionalUpgrades = countUniqueStrings(savedShoppingList.optionalUpgrades);
  const shoppingListCount = mustBuy + consumables + safety + hire + optionalUpgrades;
  const ownedToolsCount = countUniqueStrings(savedShoppingList.alreadyOwned);
  const budgetChoice = getBudgetChoice(jobState);
  const nextStepRaw = jobState?.stageTracker?.nextDecision?.trim() || null;
  const nextStep = isUsefulText(nextStepRaw) ? nextStepRaw : null;
  const lastRecommendation =
    isUsefulText(jobState?.stageTracker?.lastRecommendation) ?
      jobState.stageTracker.lastRecommendation.trim() || null
    : null;
  const currentBlocker =
    isUsefulText(jobState?.stageTracker?.currentBlocker) ? jobState.stageTracker.currentBlocker.trim() || null : null;
  const currentStage =
    isUsefulText(jobState?.stageTracker?.currentStage) &&
    normalizeTitle(jobState?.stageTracker?.currentStage || '') !== 'planning' ?
      jobState.stageTracker.currentStage.trim() || null
    : null;
  const missingItemsCount = countUniqueStrings(jobState?.missingItems?.missing);
  const coveredItemsCount = countUniqueStrings(jobState?.missingItems?.alreadyCovered);
  const optionalHelpfulCount = countUniqueStrings(jobState?.missingItems?.optionalHelpful);
  const decisionLog = Array.isArray(jobState?.decisionLog) ? jobState.decisionLog : [];
  const usefulDecisionEntries = decisionLog.filter(
    (entry) => isUsefulText(entry?.label) || isUsefulText(entry?.value != null ? String(entry.value) : ''),
  );
  const uniqueDecisionCount = new Set(usefulDecisionEntries.map((entry) => entry?.key).filter(Boolean)).size;

  const mateySuggestedToolCount = Math.max(0, Number(totalSuggestedTools) || 0);
  const resolvedPhotoCount = Math.max(0, Number(totalImageAttachments) || 0);

  const strongArtifactSignalCount =
    (shoppingListCount > 0 ? 1 : 0) +
    (ownedToolsCount > 0 ? 1 : 0) +
    (resolvedPhotoCount > 0 ? 1 : 0) +
    (mateySuggestedToolCount > 0 ? 1 : 0) +
    (budgetChoice ? 1 : 0) +
    (nextStep ? 1 : 0) +
    (uniqueDecisionCount > 0 ? 1 : 0) +
    (missingItemsCount > 0 ? 1 : 0) +
    (coveredItemsCount > 0 ? 1 : 0) +
    (optionalHelpfulCount > 0 ? 1 : 0);

  const softSignalCount = (lastRecommendation ? 1 : 0) + (currentBlocker ? 1 : 0) + (currentStage ? 1 : 0);

  const hasStrongPath = strongArtifactSignalCount >= 2;
  const hasTextOnlyPath =
    uniqueDecisionCount >= 1 ||
    softSignalCount >= 2 ||
    (softSignalCount >= 1 && missingItemsCount > 0);
  const hasMeaningfulContent = hasStrongPath || hasTextOnlyPath;

  const hasScopedResponse = userMessageCount > 0 && mateyMessageCount > 0;
  const hasValidTitle = isValidJobTitleForSave(resolvedTitle);

  return {
    ok: Boolean(hasScopedResponse && hasValidTitle && hasMeaningfulContent),
    hasScopedResponse,
    hasValidTitle,
    hasStrongPath,
    hasTextOnlyPath,
    strongArtifactSignalCount,
    softSignalCount,
  };
};

/**
 * Async: resolves message counts from MessagesJob when session counters are missing/stale.
 */
const isMeaningfulDraftFromSession = async (sessionDoc, { messagesJobStorage, jobNameFromRequest } = {}) => {
  if (!sessionDoc?.sessionId) return { ok: false, reason: 'no_session' };

  let userMsg = Number(sessionDoc.userMessageCount) || 0;
  let mateyMsg = Number(sessionDoc.mateyMessageCount) || 0;

  if ((userMsg === 0 || mateyMsg === 0) && messagesJobStorage) {
    const sid = sessionDoc.sessionId;
    const [uc, mc] = await Promise.all([
      messagesJobStorage.countDocuments({ sessionId: sid, role: 'user' }),
      messagesJobStorage.countDocuments({ sessionId: sid, role: { $in: ['matey', 'assistant'] } }),
    ]);
    userMsg = Math.max(userMsg, uc);
    mateyMsg = Math.max(mateyMsg, mc);
  }

  const resolvedTitle =
    (typeof jobNameFromRequest === 'string' && jobNameFromRequest.trim()) || (sessionDoc.title || '').trim();

  return evaluateMeaningfulDraft({
    jobState: sessionDoc.jobState || {},
    resolvedTitle,
    userMessageCount: userMsg,
    mateyMessageCount: mateyMsg,
    totalSuggestedTools: sessionDoc.totalSuggestedTools,
    totalImageAttachments: sessionDoc.totalImageAttachments,
  });
};

/**
 * Mongo filter fragment for atomic unlock: must match the saved job row we already verified.
 */
const buildUnlockOwnerFilter = (jobDoc) => {
  if (!jobDoc?.jobId) return null;
  const base = {
    jobId: jobDoc.jobId,
    deletedAt: { $in: [null, undefined] },
  };
  if (jobDoc.userId) {
    return { ...base, userId: jobDoc.userId };
  }
  const em = normalizeEmail(jobDoc.userEmail);
  if (em) {
    return { ...base, userEmail: em };
  }
  return null;
};

const READINESS_BLOCKERS = {
  scoped_chat: 'Send a message and get at least one reply from Matey.',
  valid_title: 'Add a clear job name (not the generic opener).',
  meaningful_content: 'Keep chatting until Matey has scoped enough of this job.',
};

/**
 * Server source-of-truth for save readiness (pairs with POST /jobs/save rules).
 */
const computeSaveReadiness = async (sessionDoc, opts = {}) => {
  const evalResult = await isMeaningfulDraftFromSession(sessionDoc, opts);
  if (evalResult.reason === 'no_session') {
    return {
      ready: false,
      blockers: ['Session not found'],
      strongArtifactSignalCount: 0,
      hasTextOnlyPath: false,
      hasMeaningfulContent: false,
      hasValidTitle: false,
      hasScopedResponse: false,
      hasStrongPath: false,
    };
  }

  const hasMeaningfulContent = Boolean(evalResult.hasStrongPath || evalResult.hasTextOnlyPath);
  const blockers = [];
  if (!evalResult.hasScopedResponse) blockers.push(READINESS_BLOCKERS.scoped_chat);
  if (!evalResult.hasValidTitle) blockers.push(READINESS_BLOCKERS.valid_title);
  if (!hasMeaningfulContent) blockers.push(READINESS_BLOCKERS.meaningful_content);

  return {
    ready: Boolean(evalResult.ok),
    blockers,
    strongArtifactSignalCount: evalResult.strongArtifactSignalCount,
    hasTextOnlyPath: Boolean(evalResult.hasTextOnlyPath),
    hasMeaningfulContent,
    hasValidTitle: Boolean(evalResult.hasValidTitle),
    hasScopedResponse: Boolean(evalResult.hasScopedResponse),
    hasStrongPath: Boolean(evalResult.hasStrongPath),
  };
};

module.exports = {
  normalizeTitle,
  isValidJobTitleForSave,
  isUsefulText,
  ownsSavedJob,
  ownsChatSession,
  evaluateMeaningfulDraft,
  isMeaningfulDraftFromSession,
  buildUnlockOwnerFilter,
  INVALID_JOB_TITLES,
  computeSaveReadiness,
  READINESS_BLOCKERS,
};
