/**
 * Frozen snapshot builders for SavedJobs — explicit save / unlock only.
 * Never call these from GET list/read or resume.
 */

const { inferBudgetTierFromJobState } = require('./budget-tier-alias');

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeToolKey = (value) => normalizeText(value).toLowerCase().replace(/\s+/g, ' ');

const cloneJobState = (jobState) => {
  try {
    return JSON.parse(JSON.stringify(jobState && typeof jobState === 'object' ? jobState : {}));
  } catch {
    return {};
  }
};

const findOneAndUpdateDoc = (result) => {
  if (result == null) return null;
  const v = result.value;
  if (v !== undefined) return v;
  return result;
};

const buildJobSummaryFromJobState = (jobState = {}, fallback = '') => {
  const stage = jobState.stageTracker || {};
  const decisions = Array.isArray(jobState.decisionLog) ? jobState.decisionLog.slice(-3) : [];
  const isUseful = (v) =>
    typeof v === 'string' &&
    v.trim() &&
    !/^(none|no recommendation yet|confirm next material\/tool choice)$/i.test(v.trim());
  const parts = [];
  if (isUseful(stage.lastRecommendation)) parts.push(stage.lastRecommendation.trim());
  if (decisions.length) {
    const decisionLine = decisions
      .filter((d) => d && (isUseful(d.label) || isUseful(d.value ? String(d.value) : '')))
      .map((d) => `${(d.label || d.key || 'Decision').toString().trim()}: ${String(d.value ?? '').trim()}`)
      .filter(Boolean)
      .join('; ');
    if (decisionLine) parts.push(decisionLine);
  }
  if (isUseful(stage.nextDecision)) parts.push(`Next: ${stage.nextDecision.trim()}`);
  const summary = parts.filter(Boolean).join('\n').trim();
  return summary || (typeof fallback === 'string' ? fallback : '') || '';
};

const buildShortlistFromJobState = (jobState = {}) => {
  const list = [];
  const sl = jobState.savedShoppingList || {};
  if (Array.isArray(sl.mustBuy)) sl.mustBuy.forEach((n) => list.push({ name: n, group: 'must_buy' }));
  if (Array.isArray(sl.consumables)) sl.consumables.forEach((n) => list.push({ name: n, group: 'consumables' }));
  if (Array.isArray(sl.optionalUpgrades))
    sl.optionalUpgrades.forEach((n) => list.push({ name: n, group: 'optional' }));
  if (Array.isArray(sl.safety)) sl.safety.forEach((n) => list.push({ name: n, group: 'safety' }));
  if (Array.isArray(sl.hireOrBorrow)) sl.hireOrBorrow.forEach((n) => list.push({ name: n, group: 'hire_or_borrow' }));
  if (Array.isArray(sl.notNeeded)) sl.notNeeded.forEach((n) => list.push({ name: n, group: 'not_needed' }));
  return list;
};

const buildNextStepsFromJobState = (jobState = {}) => {
  const next = [];
  const stage = jobState.stageTracker || {};
  if (stage.nextDecision) next.push({ label: stage.nextDecision, source: 'next_decision' });
  if (Array.isArray(jobState.missingItems?.missing)) {
    jobState.missingItems.missing.forEach((item) => next.push({ label: `Get: ${item}`, source: 'missing' }));
  }
  return next;
};

/**
 * @param {object} storages
 * @param {import('mongodb').Collection} storages.mateyChatSessionsStorage
 * @param {import('mongodb').Collection} storages.messagesJobStorage
 * @param {import('mongodb').Collection} storages.shedToolsStorage
 */
const createSnapshotHelpers = (storages) => {
  const { mateyChatSessionsStorage, messagesJobStorage, shedToolsStorage } = storages;

  const snapshotShedTools = async (userId, userEmail) => {
    if (!shedToolsStorage) return [];
    const candidateUserIds = [userId, userEmail].filter(Boolean);
    if (candidateUserIds.length === 0) return [];
    const tools = await shedToolsStorage
      .find({ user_id: { $in: candidateUserIds }, collection: { $ne: 'shed_analytics' } })
      .project({ name: 1, category: 1, source: 1, originalPhrase: 1 })
      .toArray();
    return tools.map((t) => ({
      name: t.name,
      category: t.category,
      source: t.source,
      originalPhrase: t.originalPhrase,
    }));
  };

  const collectImageRefsFromSession = async (sessionId) => {
    if (!messagesJobStorage || !sessionId) return [];
    const messagesWithImages = await messagesJobStorage
      .find({ sessionId, images: { $exists: true, $ne: [] } })
      .project({ images: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .toArray();
    const refsByUrl = new Map();
    for (const msg of messagesWithImages) {
      if (!Array.isArray(msg.images)) continue;
      for (const url of msg.images) {
        if (typeof url === 'string' && url.trim()) {
          const normalizedUrl = url.trim();
          if (!refsByUrl.has(normalizedUrl)) {
            refsByUrl.set(normalizedUrl, { url: normalizedUrl, capturedAt: msg.createdAt });
          }
        }
      }
    }
    return Array.from(refsByUrl.values());
  };

  const collectSuggestedToolsFromSession = async (sessionId) => {
    if (!messagesJobStorage || !sessionId) return [];
    const rows = await messagesJobStorage
      .find({ sessionId, suggestedTools: { $exists: true, $ne: [] } })
      .project({ suggestedTools: 1 })
      .sort({ createdAt: 1 })
      .toArray();

    const toolsByName = new Map();
    for (const row of rows) {
      if (!Array.isArray(row.suggestedTools)) continue;
      for (const tool of row.suggestedTools) {
        const candidateName = normalizeText(
          typeof tool === 'string' ?
            tool
          : tool?.name ||
            tool?.display_name ||
            tool?.product_name ||
            tool?.tool_name ||
            tool?.toolName ||
            tool?.productName ||
            tool?.title ||
            tool?.label,
        );
        if (!candidateName) continue;
        const key = normalizeToolKey(candidateName);
        if (!key) continue;
        const existing = toolsByName.get(key) || {};
        toolsByName.set(key, {
          name: existing.name || candidateName,
          category:
            existing.category ||
            normalizeText(
              tool?.category || tool?.subcategory || tool?.tool_category || tool?.product_category,
            ) ||
            undefined,
          source:
            existing.source ||
            normalizeText(tool?.source || tool?.retailer || tool?.merchant || 'matey_session_suggestion') ||
            'matey_session_suggestion',
          originalPhrase:
            existing.originalPhrase ||
            normalizeText(
              tool?.originalPhrase || tool?.display_name || tool?.product_name || tool?.name || tool?.title,
            ) ||
            candidateName,
        });
      }
    }
    return Array.from(toolsByName.values());
  };

  const mergeToolSnapshots = (shedTools = [], suggestedTools = []) => {
    const merged = new Map();
    for (const tool of [...suggestedTools, ...shedTools]) {
      const name = normalizeText(tool?.name);
      if (!name) continue;
      const key = normalizeToolKey(name);
      if (!key) continue;
      const existing = merged.get(key) || {};
      merged.set(key, {
        name: existing.name || name,
        category: existing.category || normalizeText(tool?.category) || undefined,
        source: existing.source || normalizeText(tool?.source) || undefined,
        originalPhrase: existing.originalPhrase || normalizeText(tool?.originalPhrase) || undefined,
      });
    }
    return Array.from(merged.values());
  };

  const collectOwnedToolsFromJobState = (jobState = {}) => {
    const sl = jobState && typeof jobState === 'object' ? jobState.savedShoppingList || {} : {};
    const candidates = [];
    if (Array.isArray(sl.alreadyOwned)) candidates.push(...sl.alreadyOwned);
    if (Array.isArray(sl.already_owned)) candidates.push(...sl.already_owned);

    const byName = new Map();
    for (const raw of candidates) {
      const name = normalizeText(raw);
      if (!name) continue;
      const key = normalizeToolKey(name);
      if (!key || byName.has(key)) continue;
      byName.set(key, {
        name,
        category: undefined,
        source: 'job_state_already_owned',
        originalPhrase: name,
      });
    }
    return Array.from(byName.values());
  };

  /**
   * Build a full snapshot payload from the current source session (live chat).
   * @param {object} params
   * @param {string} params.snapshotCreatedReason - 'save' | 'payment_success' | 'job_pass_unlock' | 'explicit_edit'
   */
  const buildSnapshotFromSession = async ({
    sourceSessionId,
    sessionDoc,
    userId,
    userEmail,
    existingJob,
    snapshotCreatedReason,
  }) => {
    const resolvedSessionDoc =
      sessionDoc ||
      (sourceSessionId && mateyChatSessionsStorage ?
        await mateyChatSessionsStorage.findOne({ sessionId: sourceSessionId })
      : null);
    const rawJobState = resolvedSessionDoc?.jobState || existingJob?.jobState || {};
    const jobState = cloneJobState(rawJobState);
    const shortlistPlan = buildShortlistFromJobState(jobState);
    const nextSteps = buildNextStepsFromJobState(jobState);
    const [imageRefs, shedTools, suggestedTools] = await Promise.all([
      collectImageRefsFromSession(sourceSessionId),
      snapshotShedTools(userId, userEmail),
      collectSuggestedToolsFromSession(sourceSessionId),
    ]);
    const ownedFromJobState = collectOwnedToolsFromJobState(jobState);
    const ownedToolsSnapshot = mergeToolSnapshots(shedTools, ownedFromJobState);
    return {
      jobSummary: buildJobSummaryFromJobState(jobState, existingJob?.jobSummary || ''),
      jobStatus: jobState?.stageTracker?.currentStage || existingJob?.jobStatus || 'planning',
      shortlistPlan,
      nextSteps,
      ownedToolsSnapshot,
      suggestedToolsSnapshot: suggestedTools,
      imageRefs,
      budgetTier: inferBudgetTierFromJobState(jobState, existingJob?.budgetTier || null),
      jobState,
      jobStateSnapshot: cloneJobState(jobState),
      snapshotSourceSessionId: sourceSessionId,
      snapshotCreatedReason,
      snapshotVersion: 1,
    };
  };

  /**
   * Idempotent: only writes when snapshotFrozenAt is missing. Safe for webhook replay.
   */
  const freezeSnapshotIfNotFrozen = async ({
    savedJobsStorage,
    jobDoc,
    snapshotReason,
    session: mongoSession,
  }) => {
    if (!savedJobsStorage || !jobDoc?.jobId || !jobDoc.sourceSessionId) return jobDoc;
    if (jobDoc.snapshotFrozenAt) return jobDoc;

    const snapshotPayload = await buildSnapshotFromSession({
      sourceSessionId: jobDoc.sourceSessionId,
      sessionDoc: null,
      userId: jobDoc.userId,
      userEmail: jobDoc.userEmail,
      existingJob: jobDoc,
      snapshotCreatedReason: snapshotReason,
    });

    const now = new Date();
    const opts = mongoSession ? { session: mongoSession, returnDocument: 'after' } : { returnDocument: 'after' };
    const filter = {
      jobId: jobDoc.jobId,
      $or: [{ snapshotFrozenAt: null }, { snapshotFrozenAt: { $exists: false } }],
    };

    const setDoc = {
      ...snapshotPayload,
      snapshotFrozenAt: now,
      snapshotVersion: snapshotPayload.snapshotVersion || 1,
      updatedAt: now,
    };

    const result = await savedJobsStorage.findOneAndUpdate(filter, { $set: setDoc }, opts);
    const updated = findOneAndUpdateDoc(result);
    return updated || (await savedJobsStorage.findOne({ jobId: jobDoc.jobId }, opts));
  };

  return {
    buildSnapshotFromSession,
    freezeSnapshotIfNotFrozen,
    buildJobSummaryFromJobState,
    buildShortlistFromJobState,
    buildNextStepsFromJobState,
  };
};

module.exports = {
  createSnapshotHelpers,
  cloneJobState,
};
