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
 * Frozen snapshot: after unlock/payment, saved job content does NOT re-sync
 * from the source chat on GET list/read or POST resume — only explicit save
 * (draft) or PATCH updates change snapshot fields.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { createRequireAuth } = require('./auth-middleware');
const { getJobEntitlement } = require('./subscription-status');
const { consumePassForJob, unlockSavedJob } = require('./job-pass-bind');
const { ownsSavedJob, ownsChatSession, isMeaningfulDraftFromSession, computeSaveReadiness } = require('./saved-jobs-internal');
const { createSnapshotHelpers } = require('./saved-jobs-snapshot');

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
  'snapshotFrozenAt',
  'snapshotVersion',
];

const isString = (v) => typeof v === 'string';
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

const jobToClientShape = (doc, entitlement) => {
  if (!doc) return null;
  const publicJob = toPublicJob(doc, { unlocked: entitlement.unlocked });
  return {
    ...publicJob,
    entitlement,
    canResume: Boolean(entitlement.unlocked),
  };
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

  const snap = createSnapshotHelpers({
    mateyChatSessionsStorage,
    messagesJobStorage,
    shedToolsStorage,
  });

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

  router.get('/jobs/save-readiness', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

      const sessionDoc = await mateyChatSessionsStorage.findOne({ sessionId });
      if (!sessionDoc) return res.status(404).json({ error: 'Session not found' });
      if (!ownsChatSession(sessionDoc, authUser)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const jobNameFromRequest =
        typeof req.query.jobName === 'string' ? req.query.jobName : undefined;
      const payload = await computeSaveReadiness(sessionDoc, {
        messagesJobStorage,
        jobNameFromRequest,
      });
      return res.json({ success: true, sessionId, ...payload });
    } catch (err) {
      console.error('GET /jobs/save-readiness error:', err);
      return res.status(500).json({ error: 'Failed to evaluate save readiness' });
    }
  });

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
      if (!ownsChatSession(sessionDoc, authUser)) {
        return res.status(403).json({ error: 'Forbidden: cannot save a session you do not own' });
      }

      const draftCheck = await isMeaningfulDraftFromSession(sessionDoc, {
        messagesJobStorage,
        jobNameFromRequest: jobName,
      });
      if (!draftCheck.ok) {
        return res.status(422).json({
          error: 'Chat is not meaningful enough to save yet',
          code: 'meaningful_draft_required',
        });
      }

      const existingFilter = {
        sourceSessionId,
        deletedAt: { $in: [null, undefined] },
        $or: [],
      };
      if (authUser.userId) existingFilter.$or.push({ userId: authUser.userId });
      if (authUser.userEmail) existingFilter.$or.push({ userEmail: authUser.userEmail });
      if (existingFilter.$or.length === 0) {
        return res.status(400).json({ error: 'User identity incomplete' });
      }
      const existing = await savedJobsStorage.findOne(existingFilter);
      if (existing && !ownsSavedJob(existing, authUser)) {
        return res.status(404).json({ error: 'Not found' });
      }

      if (existing && existing.lockState === 'unlocked' && existing.snapshotFrozenAt) {
        const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
        const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
        const ent = getJobEntitlement({ savedJob: existing, user, activePasses });
        return res.json({ success: true, job: jobToClientShape(existing, ent), frozen: true });
      }

      const now = new Date();
      const snapshotPayload = await snap.buildSnapshotFromSession({
        sourceSessionId,
        sessionDoc,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        existingJob: existing || null,
        snapshotCreatedReason: 'save',
      });

      const draftSnapshotFields = {
        ...snapshotPayload,
        snapshotFrozenAt: null,
      };

      if (existing) {
        await savedJobsStorage.updateOne(
          { jobId: existing.jobId },
          {
            $set: {
              jobName: (isString(jobName) && jobName.trim()) || existing.jobName,
              jobType: (isString(jobType) && jobType.trim()) || existing.jobType,
              ...draftSnapshotFields,
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
        ...draftSnapshotFields,
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
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);

      const jobs = docs.map((doc) => {
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
      const doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc || !ownsSavedJob(doc, authUser)) {
        return res.status(404).json({ error: 'Not found' });
      }
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
      const doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc || !ownsSavedJob(doc, authUser)) {
        return res.status(404).json({ error: 'Not found' });
      }
      const user = await usersStorage.findOne({ userEmail: authUser.userEmail });
      const activePasses = await loadActivePassesForUser(authUser.userId, authUser.userEmail);
      const ent = getJobEntitlement({ savedJob: doc, user, activePasses });
      if (!ent.unlocked) {
        return res.status(402).json({ error: 'This job is locked. Save & unlock to edit.' });
      }
      const allowed = ['jobName', 'jobType', 'jobSummary', 'jobStatus', 'nextSteps', 'budgetTier', 'shortlistPlan'];
      const update = {
        updatedAt: new Date(),
        lastActivityAt: new Date(),
        snapshotCreatedReason: 'explicit_edit',
      };
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
      const doc = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!doc || !ownsSavedJob(doc, authUser)) {
        return res.status(404).json({ error: 'Not found' });
      }
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
      if (!doc || !ownsSavedJob(doc, authUser)) {
        return res.status(404).json({ error: 'Not found' });
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
        jobDoc: doc,
        passId: passIdForSavedJob,
        paymentProvider: consumed.paymentProvider,
        paymentId: consumed.providerPaymentId,
        mateyChatSessionsStorage,
        messagesJobStorage,
        shedToolsStorage,
        freezeReason: 'job_pass_unlock',
      });
      if (!updatedJob) {
        console.error('POST /jobs/:jobId/unlock: unlockSavedJob returned null after pass consume', doc.jobId);
        return res.status(500).json({ error: 'Failed to unlock job; support has been notified' });
      }
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
      if (!doc || !ownsSavedJob(doc, authUser)) {
        return res.status(404).json({ error: 'Not found' });
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
