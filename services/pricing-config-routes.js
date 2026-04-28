/**
 * Public + admin routes for the Job Pass pricing config.
 *
 * Public:
 *   GET    /pricing/job-pass             feeds the marketing Pricing page
 *
 * Admin (header-based actor):
 *   GET    /admin/pricing-config         full config (includes provider price IDs / SKUs)
 *   PUT    /admin/pricing-config         partial update; merges deeply
 *   POST   /admin/pricing-config/validate-stripe   validate a Stripe price ID via Stripe API
 *   POST   /admin/pricing-config/validate-paypal   smoke-check PayPal env config
 */

const express = require('express');
const { getAdminActorFromRequest } = require('./admin-actor');
const {
  getPricingConfig,
  buildPublicPricingView,
  updatePricingConfig,
} = require('./pricing-config');
const stripeProvider = require('./payment-providers/stripe-provider');
const paypalProvider = require('./payment-providers/paypal-provider');

/**
 * Admin actor middleware. We mirror the rest of the admin surface, which
 * consults headers but does NOT reject `unknown-admin`. The mutating PUT
 * still captures the actor email for audit logging when present.
 */
const requireAdminActor = (req, res, next) => {
  req.adminActor = getAdminActorFromRequest(req);
  return next();
};

module.exports = ({ promoStorage, auditLogger }) => {
  const router = express.Router();

  router.get('/pricing/job-pass', async (req, res) => {
    try {
      const config = await getPricingConfig(promoStorage);
      const view = buildPublicPricingView(config);
      return res.json({ success: true, pricing: view });
    } catch (err) {
      console.error('GET /pricing/job-pass error:', err);
      return res.status(500).json({ error: 'Failed to load pricing' });
    }
  });

  router.get('/admin/pricing-config', requireAdminActor, async (req, res) => {
    try {
      const config = await getPricingConfig(promoStorage);
      return res.json({ success: true, config });
    } catch (err) {
      console.error('GET /admin/pricing-config error:', err);
      return res.status(500).json({ error: 'Failed to load pricing config' });
    }
  });

  router.put('/admin/pricing-config', requireAdminActor, async (req, res) => {
    try {
      const patch = req.body || {};
      // Light validation: amounts must be non-negative integers (minor units).
      const validateAmounts = (sku) => {
        if (!patch[sku]) return null;
        for (const field of ['launchAmount', 'standardAmount']) {
          if (patch[sku][field] === undefined) continue;
          const v = Number(patch[sku][field]);
          if (!Number.isInteger(v) || v < 0) {
            return `${sku}.${field} must be a non-negative integer (minor units / cents)`;
          }
        }
        return null;
      };
      for (const sku of ['single', 'pack3']) {
        const err = validateAmounts(sku);
        if (err) return res.status(400).json({ error: err });
      }
      if (patch.enabledProviders && !Array.isArray(patch.enabledProviders)) {
        return res.status(400).json({ error: 'enabledProviders must be an array' });
      }
      if (patch.defaultProvider && !['stripe', 'paypal'].includes(patch.defaultProvider)) {
        return res.status(400).json({ error: 'defaultProvider must be stripe or paypal' });
      }
      const actor = req.adminActor || {};
      const before = await getPricingConfig(promoStorage);
      const updated = await updatePricingConfig(promoStorage, patch, actor.userEmail || 'unknown-admin');
      if (auditLogger) {
        try {
          await auditLogger.logAudit({
            action: 'PRICING_CONFIG_UPDATED',
            resource: 'pricing_config',
            resourceId: updated.offerKey,
            userId: actor.userId,
            userEmail: actor.userEmail,
            role: actor.role,
            previousData: before,
            newData: updated,
          });
        } catch (logErr) {
          console.warn('Failed to audit pricing config update:', logErr?.message || logErr);
        }
      }
      return res.json({ success: true, config: updated });
    } catch (err) {
      console.error('PUT /admin/pricing-config error:', err);
      return res.status(500).json({ error: 'Failed to update pricing config' });
    }
  });

  router.post('/admin/pricing-config/validate-stripe', requireAdminActor, async (req, res) => {
    try {
      const { priceId, priceIds } = req.body || {};
      const ids = Array.isArray(priceIds) ? priceIds.filter(Boolean) : priceId ? [priceId] : [];
      if (!ids.length) return res.status(400).json({ error: 'priceId or priceIds required' });
      const results = {};
      for (const id of ids) {
        try {
          const r = await stripeProvider.validatePriceId(id);
          results[id] = {
            ok: !!r?.valid,
            error: r?.error || null,
            amount: r?.price?.unitAmount ?? null,
            currency: r?.price?.currency || null,
          };
        } catch (e) {
          results[id] = { ok: false, error: e?.message || 'validation failed' };
        }
      }
      return res.json({ success: true, results });
    } catch (err) {
      console.error('POST /admin/pricing-config/validate-stripe error:', err);
      return res.status(500).json({ error: 'Failed to validate Stripe price' });
    }
  });

  router.post('/admin/pricing-config/validate-paypal', requireAdminActor, async (req, res) => {
    try {
      const result = paypalProvider.validatePayPalEnv({ throwIfPartial: false });
      const ok = !!result?.configured;
      return res.json({
        success: true,
        ok,
        details: result || null,
        error: ok ? null : 'PayPal not fully configured. Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, PAYPAL_WEBHOOK_ID.',
      });
    } catch (err) {
      console.error('POST /admin/pricing-config/validate-paypal error:', err);
      return res.status(500).json({ error: 'Failed to validate PayPal env' });
    }
  });

  return router;
};
