/**
 * Saved Jobs API.
 *
 * A "saved job" is an explicit, user-initiated copy of a chat session that
 * the user wants to keep alive across time — distinct from the live chat
 * (`MateyChatSessions`) which stays free, ephemeral, and unmonetised.
 *
 * Lifecycle:
 *   draft     → created via POST /jobs/save, no payment
 *   locked    → preview-only state if a draft is reopened later
 *   unlocked  → set by the Stripe/PayPal webhook bind, or by an active
 *               Best Mates subscription, or by manual admin override
 *
 * Endpoints implemented here:
 *   POST   /jobs/save               body: { sourceSessionId, jobName?, jobType? }
 *   GET    /jobs                    list current user's saved jobs (preview-aware)
 *   GET    /jobs/:jobId             full job (lock-state aware)
 *   PATCH  /jobs/:jobId             update editable fields (entitlement-gated)
 *   POST   /jobs/:jobId/resume      bumps lastResumedAt + emits analytics
 *   POST   /jobs/:jobId/unlock      consume an existing pack pass for this job
 *   DELETE /jobs/:jobId             soft delete
 *
 * Admin-only endpoints (mounted under /admin/...) live alongside the
 * admin pricing config in the admin services so this file stays user-scoped.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { createRequireAuth } = require('./auth-middleware');
const { getJobEntitlement } = require('./subscription-status');
const { consumePassForJob, unlockSavedJob } = require('./job-pass-bind');

const PREVIEWABLE_FIELDS = [
  'jobId',
  'userId',
  'userEmail',
  'jobName',
  'jobType',
  'jobSummary',
  'jobStatus',
  'sourceSessionId',
  'budgetTier',
  'lockState',
  'unlockType',
  'paymentProvider',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'lastResumedAt',
  'resumeCount',
  'unlockedAt',
];

const isString = (v) => typeof v === 'string';
const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeToolKey = (value) => normalizeText(value).toLowerCase().replace(/\s+/g, ' ');

const truncate = (value, max = 320) => {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const toPublicJob = (doc, { unlocked }) => {
  if (!doc) return null;
  if (unlocked) {
    const { _id, ...rest } = doc;
    return rest;
  }
  // Locked preview — strip fields that contain the paid value.
  const preview = {};
  for (const key of PREVIEWABLE_FIELDS) {
    if (key in doc) preview[key] = doc[key];
  }
  preview.imageCount = Array.isArray(doc.imageRefs) ? doc.imageRefs.length : 0;
  preview.ownedToolsCount = Array.isArray(doc.ownedToolsSnapshot) ? doc.ownedToolsSnapshot.length : 0;
  preview.shortlistCount = Array.isArray(doc.shortlistPlan) ? doc.shortlistPlan.length : 0;
  preview.nextStepsCount = Array.isArray(doc.nextSteps) ? doc.nextSteps.length : 0;
  preview.summaryPreview = truncate(doc.jobSummary, 220);
  preview.lockState = doc.lockState || 'locked';
  return preview;
};

/** Masks paid fields and attaches entitlement for UI (Resume vs Unlock) without writing to DB. */
const jobToClientShape = (doc, entitlement) => {
  if (!doc) return null;
  const publicJob = toPublicJob(doc, { unlocked: entitlement.unlocked });
  return {
    ...publicJob,
    entitlement,
    canResume: Boolean(entitlement.unlocked),
  };
};

const buildShortlistFromJobState = (jobState = {}) => {
  const list = [];
  const sl = jobState.savedShoppingList || {};
  if (Array.isArray(sl.mustBuy)) sl.mustBuy.forEach((n) => list.push({ name: n, group: 'must_buy' }));
  if (Array.isArray(sl.consumables)) sl.consumables.forEach((n) => list.push({ name: n, group: 'consumables' }));
  if (Array.isArray(sl.optionalUpgrades))
    sl.optionalUpgrades.forEach((n) => list.push({ name: n, group: 'optional' }));
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

module.exports = ({
  usersStorage,
  savedJobsStorage,
  jobPassesStorage,
  mateyChatSessionsStorage,
  messagesJobStorage,
  shedToolsStorage,
  offerAnalyticsStorage,
  auditLogger,
}) => {
  const router = express.Router();
  const requireAuth = createRequireAuth({ usersStorage });

  const loadActivePassesForUser = async (userId, userEmail) => {
    if (!jobPassesStorage) return [];
    const filter = {
      status: 'active',
      packRemaining: { $gt: 0 },
      $or: [],
    };
    if (userId) filter.$or.push({ userId });
    if (userEmail) filter.$or.push({ userEmail });
    if (filter.$or.length === 0) return [];
    return jobPassesStorage.find(filter).sort({ purchasedAt: 1 }).toArray();
  };

  const loadConsumedPassForJob = async (userId, userEmail, jobId) => {
    if (!jobPassesStorage || !jobId) return null;
    const filter = {
      'consumptions.jobId': jobId,
      $or: [],
    };
    if (userId) filter.$or.push({ userId });
    if (userEmail) filter.$or.push({ userEmail });
    if (filter.$or.length === 0) return null;
    return jobPassesStorage.findOne(filter);
  };

  const resolveSavedJobPassBinding = async (jobId, passId) => {
    if (!passId) return null;
    const existingBoundJob = await savedJobsStorage.findOne({
      passId,
      jobId: { $ne: jobId },
    });
    return existingBoundJob ? null : passId;
  };

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

  const inferBudgetTier = (jobState = {}, existingBudgetTier = null) => {
    const decisionEntries = Array.isArray(jobState?.decisionLog) ? jobState.decisionLog : [];
    const budgetDecision = decisionEntries
      .slice()
      .reverse()
      .find((entry) => entry?.key === 'budgetTier' && entry?.value !== undefined && entry?.value !== null);
    const rawBudgetTier = normalizeText(budgetDecision?.value || existingBudgetTier);
    if (!rawBudgetTier && jobState?.savedShoppingList?.estimatedSpendByBudgetTier) {
      return 'mid';
    }
    const lowered = rawBudgetTier.toLowerCase();
    if (['low', 'good', 'budget'].includes(lowered)) return 'low';
    if (['mid', 'medium', 'better'].includes(lowered)) return 'mid';
    if (['high', 'best', 'premium'].includes(lowered)) return 'high';
    return rawBudgetTier || null;
  };

  const buildSyncedSavedJobFields = async ({ sourceSessionId, sessionDoc, userId, userEmail, existingJob }) => {
    const resolvedSessionDoc =
      sessionDoc || (sourceSessionId ? await mateyChatSessionsStorage.findOne({ sessionId: sourceSessionId }) : null);
    const jobState = resolvedSessionDoc?.jobState || existingJob?.jobState || {};
    const shortlistPlan = buildShortlistFromJobState(jobState);
    const nextSteps = buildNextStepsFromJobState(jobState);
    const [imageRefs, shedTools, suggestedTools] = await Promise.all([
      collectImageRefsFromSession(sourceSessionId),
      snapshotShedTools(userId, userEmail),
      collectSuggestedToolsFromSession(sourceSessionId),
    ]);
    const ownedToolsSnapshot = mergeToolSnapshots(shedTools, suggestedTools);
    return {
      jobSummary: jobState?.stageTracker?.lastRecommendation || existingJob?.jobSummary || '',
      jobStatus: jobState?.stageTracker?.currentStage || existingJob?.jobStatus || 'planning',
      shortlistPlan,
      nextSteps,
      ownedToolsSnapshot,
      imageRefs,
      budgetTier: inferBudgetTier(jobState, existingJob?.budgetTier || null),
      jobState,
    };
  };

  const syncSavedJobFromSourceSession = async ({ jobDoc, userId, userEmail, touchTimestamps = false }) => {
    if (!jobDoc?.sourceSessionId) return jobDoc;
    const sessionDoc = await mateyChatSessionsStorage.findOne({ sessionId: jobDoc.sourceSessionId });
    const syncedFields = await buildSyncedSavedJobFields({
      sourceSessionId: jobDoc.sourceSessionId,
      sessionDoc,
      userId: userId || jobDoc.userId,
      userEmail: userEmail || jobDoc.userEmail,
      existingJob: jobDoc,
    });
    const setFields = touchTimestamps ?
      {
        ...syncedFields,
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      }
    : syncedFields;
    await savedJobsStorage.updateOne({ jobId: jobDoc.jobId }, { $set: setFields });
    return { ...jobDoc, ...setFields };
  };

  router.post('/jobs/save', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) {
        return res.status(401).json({ error: 'Sign in required to save a job' });
      }
      const { sourceSessionId, jobName, jobType } = req.body || {};
      if (!sourceSessionId || !isString(sourceSessionId)) {
        return res.status(400).json({ error: 'sourceSessionId is required' });
      }
      const sessionDoc = await mateyChatSessionsStorage.findOne({ sessionId: sourceSessionId });
      if (!sessionDoc) {
        return res.status(404).json({ error: 'Source session not found' });
      }
      // Ownership: must own the chat session before promoting it to a saved job.
      if (
        (sessionDoc.userId && sessionDoc.userId !== authUser.userId) &&
        (sessionDoc.userEmail && sessionDoc.userEmail !== authUser.userEmail)
      ) {
        return res.status(403).json({ error: 'Forbidden: cannot save a session you do not own' });
      }

      // Reuse the existing draft if this session was already saved (simple
      // dedupe — users hitting Save twice should not get two SavedJobs).
      const existing = await savedJobsStorage.findOne({
        sourceSessionId,
        userId: authUser.userId,
        deletedAt: { $in: [null, undefined] },
      });

      const now = new Date();
      const syncedFields = await buildSyncedSavedJobFields({
        sourceSessionId,
        sessionDoc,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        existingJob: existing || null,
      });

      if (existing) {
        await savedJobsStorage.updateOne(
          { jobId: existing.jobId },
          {
            $set: {
              jobName: (isString(jobName) && jobName.trim()) || existing.jobName,
              jobType: (isString(jobType) && jobType.trim()) || existing.jobType,
              ...syncedFields,
              updatedAt: now,
              lastActivityAt: now,
            },
          },
        );
        const updated = await savedJobsStorage.findOne({ jobId: existing.jobId });
        if (offerAnalyticsStorage) {
          await offerAnalyticsStorage.insertOne({
            eventName: 'job_saved',
            userId: authUser.userId,
            userEmail: authUser.userEmail,
            jobId: updated.jobId,
            saveType: 'updated_existing',
            lockState: updated.lockState,
            unlockType: updated.unlockType,
            createdAt: now,
          });
        }
        const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
        const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
        const ent = getJobEntitlement({ savedJob: updated, user, activePasses });
        return res.json({ success: true, job: jobToClientShape(updated, ent) });
      }

      const jobId = randomUUID();
      const newDoc = {
        jobId,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        jobName: (isString(jobName) && jobName.trim()) || sessionDoc.title || 'New saved job',
        jobType: (isString(jobType) && jobType.trim()) || null,
        sourceSessionId,
        ...syncedFields,
        lockState: 'draft',
        unlockType: 'none',
        passId: null,
        paymentId: null,
        paymentProvider: null,
        unlockedAt: null,
        lastResumedAt: null,
        resumeCount: 0,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await savedJobsStorage.insertOne(newDoc);

      // Stamp the source session so the chat UI can show "Saved as: …".
      await mateyChatSessionsStorage.updateOne(
        { sessionId: sourceSessionId },
        { $set: { savedJobId: jobId, savedJobAt: now } },
      );

      if (offerAnalyticsStorage) {
        await offerAnalyticsStorage.insertOne({
          eventName: 'job_saved',
          userId: authUser.userId,
          userEmail: authUser.userEmail,
          jobId,
          saveType: 'draft_to_saved',
          lockState: 'draft',
          unlockType: 'none',
          createdAt: now,
        });
      }

      if (auditLogger) {
        await auditLogger.logAudit({
          action: 'JOB_SAVED',
          resource: 'saved_job',
          resourceId: jobId,
          userId: authUser.userId,
          userEmail: authUser.userEmail || 'unknown',
          role: 'user',
          newData: { jobId, sourceSessionId, lockState: 'draft' },
        });
      }

      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const ent = getJobEntitlement({ savedJob: newDoc, user, activePasses });
      return res.json({ success: true, job: jobToClientShape(newDoc, ent) });
    } catch (err) {
      console.error('POST /jobs/save error:', err);
      return res.status(500).json({ error: 'Failed to save job' });
    }
  });

  router.get('/jobs', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 100);

      const filter = {
        deletedAt: { $in: [null, undefined] },
        $or: [],
      };
      if (authUser.userId) filter.$or.push({ userId: authUser.userId });
      if (authUser.userEmail) filter.$or.push({ userEmail: authUser.userEmail });
      if (filter.$or.length === 0) return res.json({ success: true, jobs: [] });

      const docs = await savedJobsStorage.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();
      const syncedDocs = await Promise.all(
        docs.map((doc) =>
          syncSavedJobFromSourceSession({
            jobDoc: doc,
            userId: authUser.userId,
            userEmail: authUser.userEmail,
            touchTimestamps: false,
          }),
        ),
      );
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);

      const jobs = syncedDocs.map((doc) => {
        const ent = getJobEntitlement({ savedJob: doc, user, activePasses });
        return jobToClientShape(doc, ent);
      });
      return res.json({
        success: true,
        jobs,
        availablePassQuantity: activePasses.reduce((sum, p) => sum + (p.packRemaining || 0), 0),
      });
    } catch (err) {
      console.error('GET /jobs error:', err);
      return res.status(500).json({ error: 'Failed to load saved jobs' });
    }
  });

  router.get('/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      let doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.userId && doc.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      doc = await syncSavedJobFromSourceSession({
        jobDoc: doc,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        touchTimestamps: false,
      });
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const ent = getJobEntitlement({ savedJob: doc, user, activePasses });
      return res.json({
        success: true,
        job: jobToClientShape(doc, ent),
        entitlement: ent,
      });
    } catch (err) {
      console.error('GET /jobs/:jobId error:', err);
      return res.status(500).json({ error: 'Failed to load job' });
    }
  });

  router.patch('/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      let doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.userId && doc.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      doc = await syncSavedJobFromSourceSession({
        jobDoc: doc,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        touchTimestamps: false,
      });
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const ent = getJobEntitlement({ savedJob: doc, user, activePasses });
      if (!ent.unlocked) {
        return res.status(402).json({ error: 'This job is locked. Save & unlock to edit.' });
      }
      const allowed = ['jobName', 'jobType', 'jobSummary', 'jobStatus', 'nextSteps', 'budgetTier', 'shortlistPlan'];
      const update = { updatedAt: new Date(), lastActivityAt: new Date() };
      for (const k of allowed) {
        if (k in (req.body || {})) {
          update[k] = req.body[k];
        }
      }
      await savedJobsStorage.updateOne({ jobId: doc.jobId }, { $set: update });
      const next = await savedJobsStorage.findOne({ jobId: doc.jobId });
      const entNext = getJobEntitlement({ savedJob: next, user, activePasses });
      return res.json({ success: true, job: jobToClientShape(next, entNext) });
    } catch (err) {
      console.error('PATCH /jobs/:jobId error:', err);
      return res.status(500).json({ error: 'Failed to update job' });
    }
  });

  router.post('/jobs/:jobId/resume', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      let doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.userId && doc.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      doc = await syncSavedJobFromSourceSession({
        jobDoc: doc,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        touchTimestamps: true,
      });
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const ent = getJobEntitlement({ savedJob: doc, user, activePasses });
      if (!ent.unlocked) {
        return res.status(402).json({ error: 'Save this job to resume it later.', entitlement: ent });
      }
      const now = new Date();
      const previousResumeAt = doc.lastResumedAt ? new Date(doc.lastResumedAt) : null;
      await savedJobsStorage.updateOne(
        { jobId: doc.jobId },
        {
          $inc: { resumeCount: 1 },
          $set: { lastResumedAt: now, lastActivityAt: now, updatedAt: now },
        },
      );
      // Bonus retention metric: if the user is coming back after >24h, fire
      // `paid_job_returned_later` so the funnel can split by recency bucket.
      if (offerAnalyticsStorage) {
        await offerAnalyticsStorage.insertOne({
          eventName: 'job_resumed',
          userId: authUser.userId,
          userEmail: authUser.userEmail,
          jobId: doc.jobId,
          unlockType: doc.unlockType,
          paymentProvider: doc.paymentProvider || null,
          createdAt: now,
        });
        if (previousResumeAt) {
          const days = Math.floor((now.getTime() - previousResumeAt.getTime()) / (1000 * 60 * 60 * 24));
          let bucket = '30d+';
          if (days <= 1) bucket = '1d';
          else if (days <= 3) bucket = '3d';
          else if (days <= 7) bucket = '7d';
          else if (days <= 14) bucket = '14d';
          else if (days <= 30) bucket = '30d';
          if (days >= 1) {
            await offerAnalyticsStorage.insertOne({
              eventName: 'paid_job_returned_later',
              userId: authUser.userId,
              userEmail: authUser.userEmail,
              jobId: doc.jobId,
              passId: doc.passId,
              returnWindowBucket: bucket,
              daysSincePreviousResume: days,
              paymentProvider: doc.paymentProvider || null,
              createdAt: now,
            });
          }
        }
      }
      return res.json({ success: true, sourceSessionId: doc.sourceSessionId, jobId: doc.jobId });
    } catch (err) {
      console.error('POST /jobs/:jobId/resume error:', err);
      return res.status(500).json({ error: 'Failed to resume job' });
    }
  });

  router.post('/jobs/:jobId/unlock', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.userId && doc.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (doc.lockState === 'unlocked') {
        const u = await usersStorage.findOne({ userEmail: authUser.userEmail });
        const ap = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
        const ent0 = getJobEntitlement({ savedJob: doc, user: u, activePasses: ap });
        return res.json({ success: true, alreadyUnlocked: true, job: jobToClientShape(doc, ent0) });
      }
      const previouslyConsumedPass = await loadConsumedPassForJob(
        authUser.userId,
        authUser.userEmail,
        doc.jobId,
      );
      // Optional: caller can pin a specific pass; otherwise we use FIFO.
      const requestedPassId = req.body?.passId || null;
      let consumed = null;

      if (previouslyConsumedPass) {
        consumed = previouslyConsumedPass;
      } else {
        const candidatePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
        const pickPassId = requestedPassId
          ? candidatePasses.find((p) => p.passId === requestedPassId)?.passId
          : candidatePasses[0]?.passId;
        if (!pickPassId) {
          return res
            .status(402)
            .json({ error: 'No pass available to unlock this job', entitlement: { reason: 'none' } });
        }
        consumed = await consumePassForJob({ jobPassesStorage, passId: pickPassId, jobId: doc.jobId });
        if (!consumed) {
          return res.status(409).json({ error: 'Pass could not be consumed (race or already used)' });
        }
      }
      const passIdForSavedJob = await resolveSavedJobPassBinding(doc.jobId, consumed.passId);
      const updatedJob = await unlockSavedJob({
        savedJobsStorage,
        jobId: doc.jobId,
        passId: passIdForSavedJob,
        paymentProvider: consumed.paymentProvider,
        paymentId: consumed.providerPaymentId,
      });
      if (offerAnalyticsStorage) {
        await offerAnalyticsStorage.insertOne({
          eventName: 'job_unlocked_with_existing_pass',
          userId: authUser.userId,
          userEmail: authUser.userEmail,
          jobId: doc.jobId,
          passId: consumed.passId,
          paymentProvider: consumed.paymentProvider,
          createdAt: new Date(),
        });
      }
      const u2 = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const ap2 = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const entUnlocked = getJobEntitlement({ savedJob: updatedJob, user: u2, activePasses: ap2 });
      return res.json({ success: true, job: jobToClientShape(updatedJob, entUnlocked) });
    } catch (err) {
      console.error('POST /jobs/:jobId/unlock error:', err);
      return res.status(500).json({ error: 'Failed to unlock job' });
    }
  });

  router.delete('/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      if (doc.userId && doc.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const now = new Date();
      await savedJobsStorage.updateOne(
        { jobId: doc.jobId },
        { $set: { deletedAt: now, updatedAt: now } },
      );
      return res.json({ success: true, jobId: doc.jobId });
    } catch (err) {
      console.error('DELETE /jobs/:jobId error:', err);
      return res.status(500).json({ error: 'Failed to delete job' });
    }
  });

  return router;
};
