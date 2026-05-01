/**
 * PayPal Job Pass routes — order create, capture, webhook.
 *
 * The PayPal happy path is:
 *   1. Frontend calls POST /api/paypal/orders with productSku + jobId.
 *   2. We resolve the offer from the live pricing config and create a PayPal
 *      Order (intent=CAPTURE). A "pending" pass row is inserted so the funnel
 *      can show abandoned PayPal checkouts.
 *   3. The PayPal SDK button hands control to PayPal for buyer approval and
 *      then calls our `POST /api/paypal/orders/:orderId/capture` endpoint.
 *   4. We capture, then funnel through `bindPassToJob` for atomic
 *      pass-to-job binding.
 *   5. PayPal also sends `PAYMENT.CAPTURE.COMPLETED` webhook hits, which run
 *      through the same `bindPassToJob` — idempotent on
 *      (paymentProvider, providerPaymentId).
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { createRequireAuth } = require('./auth-middleware');
const paypalProvider = require('./payment-providers/paypal-provider');
const { bindPassToJob } = require('./job-pass-bind');
const { getPricingConfig, resolveOfferForCheckout } = require('./pricing-config');

const VALID_SKUS = new Set(['job_pass_single', 'job_pass_3pack']);

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

  const logPurchaseHistory = async ({
    userEmail,
    userId,
    userName,
    type,
    description,
    amount,
    currency,
    status,
    metadata,
  }) => {
    if (!subscriptionStorage || !userEmail) return;
    const dedupeKey = metadata?.idempotencyKey;
    if (dedupeKey) {
      const existing = await subscriptionStorage.findOne({
        userEmail,
        'metadata.idempotencyKey': dedupeKey,
      });
      if (existing) return;
    }
    await subscriptionStorage.insertOne({
      userEmail,
      userId: userId || userEmail,
      clerkId: userId || null,
      userName: userName || 'ToolMate User',
      type,
      description,
      amount: amount || 0,
      currency: (currency || 'AUD').toUpperCase(),
      status,
      date: new Date(),
      createdAt: new Date(),
      metadata: metadata || {},
    });
  };

  router.post('/api/paypal/orders', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const { productSku = 'job_pass_single', jobId = null, origin } = req.body || {};
      if (!VALID_SKUS.has(productSku)) {
        return res.status(400).json({ error: `Invalid productSku: ${productSku}` });
      }
      if (jobId) {
        const job = await savedJobsStorage.findOne({ jobId });
        if (!job) return res.status(404).json({ error: 'Saved job not found' });
        if (job.userId && job.userId !== authUser.userId) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      const config = await getPricingConfig(promoStorage);
      const offer = resolveOfferForCheckout(config, { productSku, paymentProvider: 'paypal' });
      if (!offer) {
        return res.status(503).json({ error: 'PayPal checkout is not currently enabled' });
      }
      if (!paypalProvider.isPayPalConfigured()) {
        return res.status(503).json({ error: 'PayPal is not configured on this server' });
      }

      const passId = randomUUID();
      const order = await paypalProvider.createJobPassOrder({
        offer,
        userEmail: authUser.userEmail,
        jobId,
        passId,
        origin: origin || req.headers.origin,
        metadata: { userId: authUser.userId },
      });

      await jobPassesStorage.insertOne({
        passId,
        paymentProvider: 'paypal',
        providerOrderId: order.providerOrderId,
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

      if (offerAnalyticsStorage) {
        try {
          await offerAnalyticsStorage.insertOne({
            eventName: 'job_pass_checkout_started',
            userId: authUser.userId,
            userEmail: authUser.userEmail,
            jobId,
            passId,
            productSku,
            paymentProvider: 'paypal',
            variant: offer.variant,
            providerPriceRef: offer.providerPriceRef,
            currency: offer.currency,
            amount: offer.amount,
            triggerReason: req.body?.triggerReason || null,
            createdAt: new Date(),
          });
        } catch (err) {
          console.warn('PayPal: failed to log checkout_started:', err?.message || err);
        }
      }

      await logPurchaseHistory({
        userEmail: authUser.userEmail,
        userId: authUser.userId,
        userName: authUser.userName,
        type: 'job_pass_checkout',
        description: `Job Pass checkout started (${productSku === 'job_pass_3pack' ? '3 Job Pass Pack' : 'Single Job Pass'})`,
        amount: Number(((offer.amount || 0) / 100).toFixed(2)),
        currency: offer.currency,
        status: 'pending',
        metadata: {
          idempotencyKey: `job_pass_checkout:paypal:${order.providerOrderId}`,
          kind: 'job_pass',
          paymentProvider: 'paypal',
          providerOrderId: order.providerOrderId,
          productSku,
          packQuantity: offer.packQuantity,
          passId,
          jobId,
        },
      });

      return res.json({
        success: true,
        provider: 'paypal',
        orderId: order.providerOrderId,
        url: order.providerCheckoutUrl,
        passId,
        offer,
      });
    } catch (err) {
      console.error('POST /api/paypal/orders error:', err?.response?.data || err);
      return res.status(500).json({ error: 'Failed to create PayPal order', details: err.message });
    }
  });

  router.post('/api/paypal/orders/:orderId/capture', requireAuth, async (req, res) => {
    try {
      const authUser = req.authUser;
      if (!authUser?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const { orderId } = req.params;
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      // Look up the pending pass row by orderId to recover the original sku/jobId.
      const pendingPass = await jobPassesStorage.findOne({
        paymentProvider: 'paypal',
        providerOrderId: orderId,
      });

      if (pendingPass && pendingPass.userId && pendingPass.userId !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const captured = await paypalProvider.captureOrder(orderId);
      const parsed = paypalProvider.parseCapturedOrder(captured?.alreadyCaptured ? captured.order : captured, {
        userEmail: authUser.userEmail,
        jobId: pendingPass?.targetJobId || null,
        passId: pendingPass?.passId || null,
        productSku: pendingPass?.productSku,
        packQuantity: pendingPass?.packQuantity,
        priceVariant: pendingPass?.priceVariant,
        providerPriceRef: pendingPass?.providerPriceRef,
        providerOrderId: orderId,
      });
      if (!parsed?.providerPaymentId) {
        return res.status(502).json({ error: 'PayPal capture did not return a payment id' });
      }

      const result = await bindPassToJob({
        mongoClient,
        jobPassesStorage,
        savedJobsStorage,
        subscriptionStorage,
        offerAnalyticsStorage,
        auditLogger,
        parsedEvent: { ...parsed, userId: authUser.userId },
        rawEvent: { source: 'paypal_inpage_capture', orderId },
      });

      return res.json({
        success: true,
        passId: result.pass?.passId || pendingPass?.passId,
        jobId: parsed.jobId,
        status: result.status,
        alreadyBound: result.alreadyBound,
      });
    } catch (err) {
      console.error('POST /api/paypal/orders/:orderId/capture error:', err?.response?.data || err);
      if (offerAnalyticsStorage) {
        try {
          await offerAnalyticsStorage.insertOne({
            eventName: 'job_pass_binding_failed',
            paymentProvider: 'paypal',
            providerOrderId: req.params.orderId,
            reason: err?.message || String(err),
            createdAt: new Date(),
          });
        } catch (logErr) {
          console.warn('PayPal: failed to log binding_failed:', logErr?.message || logErr);
        }
      }
      return res.status(500).json({ error: 'Failed to capture PayPal order', details: err.message });
    }
  });

  /**
   * Webhook endpoint. Notes:
   * - `index.js` populates `req.rawBody` for this URL via the raw-body verify
   *   callback in express.json(). PayPal's verify-webhook-signature endpoint
   *   needs the unmodified body bytes.
   * - We acknowledge with 2xx as soon as verification completes so PayPal
   *   stops retrying. Any binding error is logged + queued in
   *   `OfferAnalytics` so the admin funnel can flag it.
   */
  router.post('/api/webhooks/paypal', async (req, res) => {
    try {
      const verification = await paypalProvider.verifyWebhookSignature({
        headers: req.headers || {},
        rawBody: req.rawBody,
      });
      if (!verification.verified) {
        console.warn('PayPal webhook signature failed:', verification.error || verification.status);
        return res.status(400).json({ error: 'Invalid signature' });
      }
      const event = verification.event || req.body || {};
      const eventType = event.event_type || '';

      // We only act on capture-completed today; refunds + denials get logged
      // for admin visibility.
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
        const parsed = paypalProvider.parseCapturedOrder(event);
        if (!parsed?.providerPaymentId) {
          console.warn('PayPal webhook: PAYMENT.CAPTURE.COMPLETED missing capture id');
          return res.json({ received: true });
        }
        // Best effort: enrich from the pending pass row if present.
        let pendingPass = null;
        if (parsed.providerOrderId) {
          pendingPass = await jobPassesStorage.findOne({
            paymentProvider: 'paypal',
            providerOrderId: parsed.providerOrderId,
          });
        }
        const enriched = {
          ...parsed,
          userId: parsed.userId || pendingPass?.userId || null,
          userEmail: parsed.userEmail || pendingPass?.userEmail || null,
          jobId: parsed.jobId || pendingPass?.targetJobId || null,
          passId: parsed.passId || pendingPass?.passId || null,
          productSku: parsed.productSku || pendingPass?.productSku || 'job_pass_single',
          packQuantity: parsed.packQuantity || pendingPass?.packQuantity || 1,
          priceVariant: parsed.priceVariant || pendingPass?.priceVariant || 'standard',
          providerPriceRef: parsed.providerPriceRef || pendingPass?.providerPriceRef || null,
        };
        try {
          const result = await bindPassToJob({
            mongoClient,
            jobPassesStorage,
            savedJobsStorage,
            subscriptionStorage,
            offerAnalyticsStorage,
            auditLogger,
            parsedEvent: enriched,
            rawEvent: { source: 'paypal_webhook', eventId: event.id, type: eventType },
          });
          return res.json({ received: true, status: result.status });
        } catch (bindErr) {
          console.error('PayPal webhook bind failed:', bindErr?.message || bindErr);
          if (offerAnalyticsStorage) {
            try {
              await offerAnalyticsStorage.insertOne({
                eventName: 'job_pass_binding_failed',
                paymentProvider: 'paypal',
                providerOrderId: enriched.providerOrderId,
                providerPaymentId: enriched.providerPaymentId,
                reason: bindErr?.message || String(bindErr),
                createdAt: new Date(),
              });
            } catch (logErr) {
              console.warn('PayPal webhook: failed to log binding_failed:', logErr?.message || logErr);
            }
          }
          return res.status(500).json({ error: 'bind failed' });
        }
      }

      if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
        const captureId = event?.resource?.id || null;
        if (captureId) {
          const existingPass = await jobPassesStorage.findOne({ paymentProvider: 'paypal', providerPaymentId: captureId });
          await jobPassesStorage.updateOne(
            { paymentProvider: 'paypal', providerPaymentId: captureId },
            {
              $set: {
                status: 'refunded',
                refundedAt: new Date(),
                refundReason: event?.resource?.status_details?.reason || event.event_type,
                updatedAt: new Date(),
              },
            },
          );
          if (existingPass?.userEmail) {
            const normalizedRefundAmount =
              typeof existingPass.amountPaid === 'number' ? Number((existingPass.amountPaid / 100).toFixed(2)) : 0;
            await logPurchaseHistory({
              userEmail: existingPass.userEmail,
              userId: existingPass.userId,
              userName: existingPass.userEmail,
              type: 'job_pass_refund',
              description: 'Job pass refunded',
              amount: normalizedRefundAmount,
              currency: existingPass.currency || 'AUD',
              status: 'refunded',
              metadata: {
                idempotencyKey: `job_pass_refund:paypal:${captureId}:${eventType}`,
                kind: 'job_pass',
                paymentProvider: 'paypal',
                providerPaymentId: captureId,
                providerOrderId: existingPass.providerOrderId || null,
                productSku: existingPass.productSku || 'job_pass_single',
                packQuantity: existingPass.packQuantity || 1,
                refundReason: event?.resource?.status_details?.reason || eventType,
              },
            });
          }
        }
        return res.json({ received: true });
      }

      // Unhandled events: ack and move on so PayPal stops retrying.
      return res.json({ received: true, ignored: eventType });
    } catch (err) {
      console.error('POST /api/webhooks/paypal error:', err?.response?.data || err);
      return res.status(500).json({ error: 'webhook processing failed' });
    }
  });

  return router;
};
