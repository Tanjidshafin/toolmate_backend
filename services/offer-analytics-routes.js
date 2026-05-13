/**
 * Admin-facing analytics endpoints for the Job Pass funnel.
 *
 * The user-facing tracking endpoints (offer_shown, offer_clicked,
 * checkout_started) live in `job-pass-routes.js`. This file is the
 * read-side: aggregates for the admin /job-pass-funnel page.
 *
 * Auth model mirrors the rest of the admin surface: header-based
 * `x-admin-user-email` from `getAdminActorFromRequest`. Owner-only
 * for sensitive views (cohort drilldowns); admin can view summary.
 */

const express = require('express');
const { ObjectId } = require('mongodb');
const { getAdminActorFromRequest } = require('./admin-actor');

/**
 * Admin actor middleware. We mirror the rest of the admin surface, which
 * consults headers but does NOT reject `unknown-admin`. This keeps the page
 * usable when the admin frontend hasn't yet hydrated `localStorage.adminUserData`
 * (e.g. fresh login, hard refresh) and matches the existing read-only admin
 * pages. Mutating endpoints still capture the actor for audit logging.
 */
const requireAdminActor = (req, res, next) => {
  req.adminActor = getAdminActorFromRequest(req);
  return next();
};

const FUNNEL_STAGES = [
  'job_pass_offer_shown',
  'job_pass_offer_clicked',
  'job_pass_checkout_started',
  'job_pass_checkout_completed',
  'job_saved',
  'job_resumed',
  'paid_job_returned_later',
];

const parseDateRange = (req) => {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromRaw = req.query?.from;
  const toRaw = req.query?.to;
  const from = fromRaw ? new Date(String(fromRaw)) : defaultFrom;
  const to = toRaw ? new Date(String(toRaw)) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return null;
  }
  return { from, to };
};

const encodeCursor = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const toCursorTs = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

const decodeCursor = (cursor) => {
  try {
    if (!cursor) return null;
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || !parsed.ts || !parsed.id) return null;
    const tsDate = new Date(parsed.ts);
    if (Number.isNaN(tsDate.getTime())) return null;
    return { ts: tsDate, id: new ObjectId(String(parsed.id)) };
  } catch {
    return null;
  }
};

module.exports = ({ offerAnalyticsStorage, jobPassesStorage, savedJobsStorage }) => {
  const router = express.Router();

  router.get('/admin/job-pass-funnel/summary', requireAdminActor, async (req, res) => {
    try {
      const range = parseDateRange(req);
      if (!range) return res.status(400).json({ error: 'Invalid from/to date' });

      // Empty-state response keeps the admin page renderable when storage is
      // missing or the collection is empty (fresh install / pre-deploy).
      const emptySummary = {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        totals: {
          offer_shown: 0,
          offer_clicked: 0,
          checkout_started: 0,
          checkout_completed: 0,
          job_saved: 0,
          job_resumed: 0,
          binding_failures: 0,
        },
        byProvider: {
          stripe: { checkout_started: 0, checkout_completed: 0, binding_failures: 0 },
          paypal: { checkout_started: 0, checkout_completed: 0, binding_failures: 0 },
        },
        byVariant: {},
        byTrigger: {},
      };

      if (!offerAnalyticsStorage) {
        return res.json({ success: true, summary: emptySummary });
      }

      const providerFilter = req.query?.provider && req.query.provider !== 'all' ? String(req.query.provider) : null;
      const variantFilter = req.query?.variant ? String(req.query.variant) : null;

      const baseMatch = { createdAt: { $gte: range.from, $lte: range.to } };
      if (providerFilter) baseMatch.paymentProvider = providerFilter;
      if (variantFilter) baseMatch.variant = variantFilter;

      // Map the canonical event names (with the `job_pass_` prefix) to the
      // short keys the admin UI uses in `summary.totals`.
      const EVENT_KEY_MAP = {
        job_pass_offer_shown: 'offer_shown',
        job_pass_offer_clicked: 'offer_clicked',
        job_pass_checkout_started: 'checkout_started',
        job_pass_checkout_completed: 'checkout_completed',
        job_saved: 'job_saved',
        job_resumed: 'job_resumed',
        job_pass_binding_failed: 'binding_failures',
      };

      const [stageRows, dedupedCheckoutStarted, providerDedupedStart, variantDedupedStart] = await Promise.all([
        offerAnalyticsStorage.aggregate([{ $match: baseMatch }, { $group: { _id: '$eventName', count: { $sum: 1 } } }]).toArray(),
        offerAnalyticsStorage
          .aggregate([
            { $match: { ...baseMatch, eventName: 'job_pass_checkout_started' } },
            {
              $group: {
                _id: {
                  passId: { $ifNull: ['$passId', ''] },
                  providerOrderId: { $ifNull: ['$providerOrderId', ''] },
                },
              },
            },
            { $count: 'c' },
          ])
          .toArray(),
        offerAnalyticsStorage
          .aggregate([
            { $match: { ...baseMatch, eventName: 'job_pass_checkout_started' } },
            {
              $group: {
                _id: {
                  provider: { $ifNull: ['$paymentProvider', 'stripe'] },
                  passId: { $ifNull: ['$passId', ''] },
                  providerOrderId: { $ifNull: ['$providerOrderId', ''] },
                },
              },
            },
            { $group: { _id: '$_id.provider', count: { $sum: 1 } } },
          ])
          .toArray(),
        offerAnalyticsStorage
          .aggregate([
            { $match: { ...baseMatch, eventName: 'job_pass_checkout_started' } },
            {
              $group: {
                _id: {
                  variant: { $ifNull: ['$variant', 'unknown'] },
                  passId: { $ifNull: ['$passId', ''] },
                  providerOrderId: { $ifNull: ['$providerOrderId', ''] },
                },
              },
            },
            { $group: { _id: '$_id.variant', count: { $sum: 1 } } },
          ])
          .toArray(),
      ]);

      const totals = { ...emptySummary.totals };
      for (const row of stageRows) {
        const key = EVENT_KEY_MAP[row._id];
        if (key && key !== 'checkout_started') totals[key] += row.count;
      }
      totals.checkout_started = dedupedCheckoutStarted[0]?.c || 0;

      const providerRows = await offerAnalyticsStorage
        .aggregate([
          {
            $match: {
              ...baseMatch,
              eventName: { $in: ['job_pass_checkout_completed', 'job_pass_binding_failed'] },
            },
          },
          { $group: { _id: { provider: '$paymentProvider', stage: '$eventName' }, count: { $sum: 1 } } },
        ])
        .toArray();
      const byProvider = JSON.parse(JSON.stringify(emptySummary.byProvider));
      for (const row of providerDedupedStart) {
        const key = row._id || 'stripe';
        if (!byProvider[key]) byProvider[key] = { checkout_started: 0, checkout_completed: 0, binding_failures: 0 };
        byProvider[key].checkout_started = row.count || 0;
      }
      for (const row of providerRows) {
        const key = row._id.provider || 'stripe';
        if (!byProvider[key]) byProvider[key] = { checkout_started: 0, checkout_completed: 0, binding_failures: 0 };
        if (row._id.stage === 'job_pass_checkout_completed') byProvider[key].checkout_completed = row.count;
        if (row._id.stage === 'job_pass_binding_failed') byProvider[key].binding_failures = row.count;
      }

      const variantRows = await offerAnalyticsStorage
        .aggregate([
          {
            $match: { ...baseMatch, eventName: 'job_pass_checkout_completed' },
          },
          { $group: { _id: { variant: '$variant', stage: '$eventName' }, count: { $sum: 1 } } },
        ])
        .toArray();
      const byVariant = {};
      for (const row of variantDedupedStart) {
        const key = row._id || 'unknown';
        if (!byVariant[key]) byVariant[key] = { checkout_started: 0, checkout_completed: 0 };
        byVariant[key].checkout_started = row.count || 0;
      }
      for (const row of variantRows) {
        const key = row._id.variant || 'unknown';
        if (!byVariant[key]) byVariant[key] = { checkout_started: 0, checkout_completed: 0 };
        if (row._id.stage === 'job_pass_checkout_completed') byVariant[key].checkout_completed = row.count;
      }

      const triggerRows = await offerAnalyticsStorage
        .aggregate([
          { $match: { ...baseMatch, eventName: 'job_pass_offer_shown' } },
          { $group: { _id: '$triggerReason', count: { $sum: 1 } } },
        ])
        .toArray();
      const byTrigger = {};
      for (const row of triggerRows) {
        byTrigger[row._id || 'unknown'] = row.count;
      }

      return res.json({
        success: true,
        summary: {
          range: { from: range.from.toISOString(), to: range.to.toISOString() },
          totals,
          byProvider,
          byVariant,
          byTrigger,
        },
      });
    } catch (err) {
      console.error('GET /admin/job-pass-funnel/summary error:', err);
      return res.status(500).json({ error: 'Failed to load funnel summary' });
    }
  });

  router.get('/admin/job-pass-funnel/recent', requireAdminActor, async (req, res) => {
    try {
      if (!offerAnalyticsStorage) return res.json({ events: [] });
      const range = parseDateRange(req);
      if (!range) return res.status(400).json({ error: 'Invalid from/to date' });
      const filter = { createdAt: { $gte: range.from, $lte: range.to } };
      if (req.query?.eventName) filter.eventName = String(req.query.eventName);
      if (req.query?.paymentProvider) filter.paymentProvider = String(req.query.paymentProvider);
      if (req.query?.variant) filter.variant = String(req.query.variant);
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
      const cursorValue = decodeCursor(req.query.cursor);
      if (req.query.cursor && !cursorValue) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      if (cursorValue) {
        filter.$or = [
          { createdAt: { $lt: cursorValue.ts } },
          { createdAt: cursorValue.ts, _id: { $lt: cursorValue.id } },
        ];
      }
      const events = await offerAnalyticsStorage
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = events.length > limit;
      const pageItems = hasMore ? events.slice(0, limit) : events;
      const last = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ ts: toCursorTs(last.createdAt), id: String(last._id) }) : null;
      return res.json({
        success: true,
        events: pageItems,
        pagination: { limit, hasMore, nextCursor },
      });
    } catch (err) {
      console.error('GET /admin/job-pass-funnel/recent error:', err);
      return res.status(500).json({ error: 'Failed to load funnel events' });
    }
  });

  router.get('/admin/job-pass-funnel/binding-failures', requireAdminActor, async (req, res) => {
    try {
      if (!offerAnalyticsStorage) return res.json({ failures: [] });
      const range = parseDateRange(req);
      if (!range) return res.status(400).json({ error: 'Invalid from/to date' });
      const filter = {
        createdAt: { $gte: range.from, $lte: range.to },
        eventName: 'job_pass_binding_failed',
      };
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
      const cursorValue = decodeCursor(req.query.cursor);
      if (req.query.cursor && !cursorValue) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      if (cursorValue) {
        filter.$or = [
          { createdAt: { $lt: cursorValue.ts } },
          { createdAt: cursorValue.ts, _id: { $lt: cursorValue.id } },
        ];
      }
      const failures = await offerAnalyticsStorage
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = failures.length > limit;
      const pageItems = hasMore ? failures.slice(0, limit) : failures;
      const last = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ ts: toCursorTs(last.createdAt), id: String(last._id) }) : null;
      return res.json({
        success: true,
        failures: pageItems,
        pagination: { limit, hasMore, nextCursor },
      });
    } catch (err) {
      console.error('GET /admin/job-pass-funnel/binding-failures error:', err);
      return res.status(500).json({ error: 'Failed to load binding failures' });
    }
  });

  router.get('/admin/job-pass-funnel/export', requireAdminActor, async (req, res) => {
    try {
      if (!offerAnalyticsStorage) return res.status(404).json({ error: 'No analytics storage' });
      const range = parseDateRange(req);
      if (!range) return res.status(400).json({ error: 'Invalid from/to date' });
      const filter = { createdAt: { $gte: range.from, $lte: range.to } };
      if (req.query?.eventName) filter.eventName = String(req.query.eventName);
      if (req.query?.paymentProvider) filter.paymentProvider = String(req.query.paymentProvider);
      const events = await offerAnalyticsStorage.find(filter).sort({ createdAt: -1 }).limit(10000).toArray();
      const headers = [
        'createdAt',
        'eventName',
        'userId',
        'userEmail',
        'jobId',
        'passId',
        'paymentProvider',
        'variant',
        'productSku',
        'currency',
        'amount',
        'triggerReason',
        'triggerType',
      ];
      const rows = events.map((e) =>
        headers
          .map((h) => {
            const v = e[h];
            if (v === undefined || v === null) return '';
            if (v instanceof Date) return v.toISOString();
            const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return `"${str.replace(/"/g, '""')}"`;
          })
          .join(','),
      );
      const csv = [headers.join(','), ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="job-pass-funnel-${range.from.toISOString().slice(0, 10)}-${range.to
          .toISOString()
          .slice(0, 10)}.csv"`,
      );
      return res.send(csv);
    } catch (err) {
      console.error('GET /admin/job-pass-funnel/export error:', err);
      return res.status(500).json({ error: 'Failed to export funnel' });
    }
  });

  // Saved Jobs admin: list + manual unlock + revoke pass.
  router.get('/admin/saved-jobs', requireAdminActor, async (req, res) => {
    try {
      if (!savedJobsStorage) return res.json({ jobs: [] });
      const filter = {};
      if (req.query?.lockState) filter.lockState = String(req.query.lockState);
      if (req.query?.userEmail) filter.userEmail = String(req.query.userEmail).toLowerCase();
      if (req.query?.jobName) {
        filter.jobName = { $regex: String(req.query.jobName), $options: 'i' };
      }
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
      const cursorValue = decodeCursor(req.query.cursor);
      if (req.query.cursor && !cursorValue) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      if (cursorValue) {
        filter.$or = [
          { updatedAt: { $lt: cursorValue.ts } },
          { updatedAt: cursorValue.ts, _id: { $lt: cursorValue.id } },
        ];
      }
      const jobs = await savedJobsStorage
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = jobs.length > limit;
      const pageItems = hasMore ? jobs.slice(0, limit) : jobs;
      const last = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ ts: toCursorTs(last.updatedAt), id: String(last._id) }) : null;
      return res.json({
        success: true,
        jobs: pageItems,
        pagination: { limit, hasMore, nextCursor },
      });
    } catch (err) {
      console.error('GET /admin/saved-jobs error:', err);
      return res.status(500).json({ error: 'Failed to load saved jobs' });
    }
  });

  router.get('/admin/saved-jobs/:jobId', requireAdminActor, async (req, res) => {
    try {
      if (!savedJobsStorage) return res.status(503).json({ error: 'Saved jobs not configured' });
      const job = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!job) return res.status(404).json({ error: 'Not found' });
      let pass = null;
      if (job.passId && jobPassesStorage) {
        pass = await jobPassesStorage.findOne({ passId: job.passId });
      }
      return res.json({ success: true, job, pass });
    } catch (err) {
      console.error('GET /admin/saved-jobs/:jobId error:', err);
      return res.status(500).json({ error: 'Failed to load saved job' });
    }
  });

  router.post('/admin/saved-jobs/:jobId/manual-unlock', requireAdminActor, async (req, res) => {
    try {
      if (!savedJobsStorage) return res.status(503).json({ error: 'Saved jobs not configured' });
      const job = await savedJobsStorage.findOne({ jobId: req.params.jobId });
      if (!job) return res.status(404).json({ error: 'Not found' });
      if (job.lockState === 'unlocked') {
        return res.json({ success: true, alreadyUnlocked: true, job });
      }
      const now = new Date();
      const reason = req.body?.reason || req.body?.note || null;
      await savedJobsStorage.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            lockState: 'unlocked',
            unlockType: 'admin_grant',
            unlockedAt: now,
            updatedAt: now,
            adminUnlockNote: reason,
            adminUnlockBy: req.adminActor?.userEmail || 'unknown-admin',
          },
        },
      );
      const updated = await savedJobsStorage.findOne({ jobId: job.jobId });
      return res.json({ success: true, job: updated });
    } catch (err) {
      console.error('POST /admin/saved-jobs/:jobId/manual-unlock error:', err);
      return res.status(500).json({ error: 'Failed to manually unlock' });
    }
  });

  router.post('/admin/job-passes/:passId/revoke', requireAdminActor, async (req, res) => {
    try {
      if (!jobPassesStorage) return res.status(503).json({ error: 'Job passes not configured' });
      const pass = await jobPassesStorage.findOne({ passId: req.params.passId });
      if (!pass) return res.status(404).json({ error: 'Not found' });
      if (pass.status === 'revoked') {
        return res.json({ success: true, alreadyRevoked: true, pass });
      }
      const now = new Date();
      await jobPassesStorage.updateOne(
        { passId: pass.passId },
        {
          $set: {
            status: 'revoked',
            revokedAt: now,
            revokedReason: req.body?.reason || null,
            revokedBy: req.adminActor?.userEmail || 'unknown-admin',
            updatedAt: now,
          },
        },
      );
      const updated = await jobPassesStorage.findOne({ passId: pass.passId });
      return res.json({ success: true, pass: updated });
    } catch (err) {
      console.error('POST /admin/job-passes/:passId/revoke error:', err);
      return res.status(500).json({ error: 'Failed to revoke pass' });
    }
  });

  return router;
};
