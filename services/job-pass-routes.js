/**
 * Job Pass purchase + entitlement routes (provider-agnostic).
 *
 * The PayPal-specific routes (`/api/paypal/orders`, `/api/paypal/capture`,
 * `/api/webhooks/paypal`) live alongside this module but are wired in a
 * dedicated PayPal routes file to keep the webhook raw-body handling
 * obvious in `index.js`.
 *
 * Endpoints implemented here:
 *   POST  /api/job-pass/checkout         start a Stripe Checkout Session
 *   GET   /api/job-pass/me               list my passes (active + history)
 *   POST  /api/job-pass/recover-session  success-page recovery for Stripe
 *   POST  /api/job-pass/offer-shown      analytics: offer_shown
 *   POST  /api/job-pass/offer-clicked    analytics: offer_clicked
 *   POST  /api/job-pass/checkout-started analytics: checkout_started
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { createRequireAuth } = require('./auth-middleware');
const stripeProvider = require('./payment-providers/stripe-provider');
const { bindPassToJob } = require('./job-pass-bind');
const { getPricingConfig, resolveOfferForCheckout } = require('./pricing-config');

const VALID_SKUS = new Set(['job_pass_single', 'job_pass_3pack']);
/** Aligned with client chat session ids (UUID or session_* tokens); path-safe segment. */
const CHAT_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

module.exports = ({
  usersStorage,
  subscriptionStorage,
  jobPassesStorage,
  savedJobsStorage,
  promoStorage,
  offerAnalyticsStorage,
  auditLogger,
  mongoClient,
}) => {
  const router = express.Router();
  const requireAuth = createRequireAuth({ usersStorage });

  const trackEvent = async (eventName, payload) => {
    if (!offerAnalyticsStorage) return;
    try {
      await offerAnalyticsStorage.insertOne({
        eventName,
        ...payload,
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn(`Failed to insert ${eventName}:`, err?.message || err);
    }
  };

  router.post('/api/job-pass/offer-shown', async (req, res) => {
    try {
      const { userId, sessionId, jobId, draftId, triggerReason, triggerType, variant, placement, productSku, paymentProvider } =
        req.body || {};
      await trackEvent('job_pass_offer_shown', {
        userId: userId || null,
        sessionId: sessionId || null,
        jobId: jobId || null,
        draftId: draftId || null,
        triggerReason: triggerReason || 'unspecified',
        triggerType: triggerType || 'button',
        variant: variant || null,
        placement: placement || null,
        productSku: productSku || null,
        paymentProvider: paymentProvider || null,
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to log offer_shown' });
    }
  });

  router.post('/api/job-pass/offer-clicked', async (req, res) => {
    try {
      const { userId, sessionId, jobId, draftId, triggerReason, triggerType, variant, placement, ctaLabel, productSku, paymentProvider } =
        req.body || {};
      await trackEvent('job_pass_offer_clicked', {
        userId: userId || null,
        sessionId: sessionId || null,
        jobId: jobId || null,
        draftId: draftId || null,
        triggerReason: triggerReason || 'unspecified',
        triggerType: triggerType || 'button',
        variant: variant || null,
        placement: placement || null,
        ctaLabel: ctaLabel || null,
        productSku: productSku || null,
        paymentProvider: paymentProvider || null,
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to log offer_clicked' });
    }
  });

  router.post('/api/job-pass/checkout-started', async (req, res) => {
    try {
      const { userId, jobId, productSku, paymentProvider, variant, providerPriceRef, currency, amount } = req.body || {};
      await trackEvent('job_pass_checkout_started', {
        userId: userId || null,
        jobId: jobId || null,
        productSku: productSku || null,
        paymentProvider: paymentProvider || null,
        variant: variant || null,
        providerPriceRef: providerPriceRef || null,
        currency: currency || 'AUD',
        amount: typeof amount === 'number' ? amount : null,
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to log checkout_started' });
    }
  });

  router.post('/api/job-pass/checkout', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) {
        return res.status(401).json({ error: 'Sign in required to buy a Job Pass' });
      }
      const { productSku = 'job_pass_single', jobId = null, origin, chatSessionId: rawChatSessionId } = req.body || {};
      if (!VALID_SKUS.has(productSku)) {
        return res.status(400).json({ error: `Invalid productSku: ${productSku}` });
      }

      let returnContext = 'pricing';
      let chatSessionId = null;
      // Validate that the user actually owns the job they're trying to bind to.
      if (jobId) {
        const job = await savedJobsStorage.findOne({ jobId });
        if (!job) return res.status(404).json({ error: 'Saved job not found' });
        if (job.userId && job.userId !== authUser.userId) {
          return res.status(403).json({ error: 'Forbidden: cannot pay for a job you do not own' });
        }
        returnContext = 'chat';
        const cs = typeof rawChatSessionId === 'string' ? rawChatSessionId.trim() : '';
        if (!CHAT_SESSION_ID_RE.test(cs)) {
          return res.status(400).json({ error: 'Valid chatSessionId is required for job-bound checkout' });
        }
        chatSessionId = cs;
      }

      const config = await getPricingConfig(promoStorage);
      const offer = resolveOfferForCheckout(config, { productSku, paymentProvider: 'stripe' });
      if (!offer) {
        return res.status(503).json({ error: 'Stripe checkout is not currently enabled' });
      }

      const passId = randomUUID();
      const session = await stripeProvider.createJobPassCheckout({
        offer,
        userEmail: authUser.userEmail,
        jobId,
        passId,
        origin: origin || req.headers.origin,
        returnContext,
        chatSessionId,
        metadata: {
          userId: authUser.userId,
        },
      });

      // Pre-create a "pending" pass row so admin/funnel can see incomplete
      // checkouts even before the webhook lands. The webhook will later
      // upsert this row to status=active via the same passId.
      await jobPassesStorage.insertOne({
        passId,
        paymentProvider: 'stripe',
        providerOrderId: session.providerOrderId,
        providerPriceRef: offer.providerPriceRef,
        productSku,
        packQuantity: offer.packQuantity,
        packRemaining: offer.packQuantity,
        priceVariant: offer.variant,
        amountPaid: null,
        currency: offer.currency,
        status: 'pending',
        consumptions: [],
        consumedAt: null,
        consumedByJobId: null,
        refundedAt: null,
        revokedAt: null,
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        targetJobId: jobId,
        purchasedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await trackEvent('job_pass_checkout_started', {
        userId: authUser.userId,
        userEmail: authUser.userEmail,
        jobId,
        passId,
        productSku,
        paymentProvider: 'stripe',
        variant: offer.variant,
        providerPriceRef: offer.providerPriceRef,
        currency: offer.currency,
        amount: offer.amount,
        triggerReason: req.body?.triggerReason || null,
      });

      return res.json({
        success: true,
        provider: 'stripe',
        sessionId: session.sessionId,
        url: session.providerCheckoutUrl,
        passId,
        offer,
      });
    } catch (err) {
      console.error('POST /api/job-pass/checkout error:', err);
      return res.status(500).json({ error: 'Failed to start checkout', details: err.message });
    }
  });

  router.get('/api/job-pass/me', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const filter = {
        $or: [{ userId: authUser.userId }, { userEmail: authUser.userEmail }],
      };
      const passes = await jobPassesStorage.find(filter).sort({ createdAt: -1 }).limit(50).toArray();
      const activeUnits = passes
        .filter((p) => p.status === 'active' && (p.packRemaining || 0) > 0 && !p.refundedAt && !p.revokedAt)
        .reduce((sum, p) => sum + (p.packRemaining || 0), 0);
      return res.json({
        success: true,
        passes,
        availablePassQuantity: activeUnits,
      });
    } catch (err) {
      console.error('GET /api/job-pass/me error:', err);
      return res.status(500).json({ error: 'Failed to load your passes' });
    }
  });

  /**
   * Recovery path used by the success page if the user lands faster than the
   * webhook arrives. Idempotent: re-running it after the webhook does nothing
   * because `bindPassToJob` keys on (paymentProvider, providerPaymentId).
   */
  router.post('/api/job-pass/recover-session', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

      const checkoutSession = await stripeProvider.retrieveCheckoutSession(sessionId);
      if (!checkoutSession) return res.status(404).json({ error: 'Stripe session not found' });
      if (checkoutSession.payment_status !== 'paid') {
        return res.status(409).json({ error: 'Checkout not yet paid', payment_status: checkoutSession.payment_status });
      }
      const parsed = stripeProvider.parseCompletedCheckout(checkoutSession);
      if (!parsed) {
        return res.status(409).json({ error: 'Session is not a Job Pass checkout' });
      }
      // Defensive: only recover sessions that match the requesting user.
      if (parsed.userEmail && authUser.userEmail && parsed.userEmail.toLowerCase() !== authUser.userEmail.toLowerCase()) {
        return res.status(403).json({ error: 'Cannot recover a session that belongs to another user' });
      }
      const result = await bindPassToJob({
        mongoClient,
        jobPassesStorage,
        savedJobsStorage,
        subscriptionStorage,
        offerAnalyticsStorage,
        auditLogger,
        parsedEvent: {
          ...parsed,
          userId: parsed.userId || authUser.userId,
        },
        rawEvent: { source: 'success_page_recover', sessionId },
      });
      return res.json({
        success: true,
        passId: result.pass?.passId,
        jobId: parsed.jobId,
        status: result.status,
        alreadyBound: result.alreadyBound,
      });
    } catch (err) {
      console.error('POST /api/job-pass/recover-session error:', err);
      return res.status(500).json({ error: 'Failed to recover Job Pass', details: err.message });
    }
  });

  return router;
};
