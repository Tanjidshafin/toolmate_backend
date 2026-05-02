/**
 * Stripe payment provider for one-off Job Pass checkouts.
 *
 * Subscriptions still live in `subscription-routes.js`. This module is
 * intentionally narrow: it knows how to create a Checkout Session in
 * `mode: 'payment'`, parse a webhook event into the canonical pass shape,
 * and confirm a PaymentIntent (used by the success-page recovery path).
 *
 * The shared `bindPassToJob` helper in `job-pass-bind.js` is provider-
 * agnostic — it just needs the normalized `parsedEvent` shape returned
 * from `parseCompletedCheckout()`.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PROVIDER_NAME = 'stripe';

const buildSafeOrigin = (origin) => {
  const raw = origin || process.env.FRONTEND_URL || 'http://localhost:5173';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
};

/**
 * @param {'pricing'|'chat'} returnContext
 * @param {string|null|undefined} chatSessionId — required when returnContext is 'chat'
 */
const buildJobPassStripeUrls = ({ safeOrigin, returnContext, chatSessionId, jobId }) => {
  const jobParam = encodeURIComponent(jobId || '');
  const sessionPlaceholder = '{CHECKOUT_SESSION_ID}';
  if (returnContext === 'chat') {
    if (!chatSessionId || typeof chatSessionId !== 'string') {
      throw new Error('chatSessionId is required for chat return context');
    }
    const seg = encodeURIComponent(chatSessionId.trim());
    return {
      success_url: `${safeOrigin}/chat/${seg}?success=true&session_id=${sessionPlaceholder}&job_id=${jobParam}`,
      cancel_url: `${safeOrigin}/chat/${seg}?job_pass_cancel=1`,
    };
  }
  return {
    success_url: `${safeOrigin}/pricing?success=true&session_id=${sessionPlaceholder}&job_id=${jobParam}`,
    cancel_url: `${safeOrigin}/pricing?job_pass_cancel=1`,
  };
};

const createJobPassCheckout = async ({
  offer,
  userEmail,
  jobId,
  passId,
  origin,
  metadata = {},
  returnContext = 'pricing',
  chatSessionId = null,
}) => {
  if (!offer) throw new Error('Stripe checkout requires a resolved offer');
  if (!offer.providerPriceRef) {
    throw new Error(
      `Stripe price ID is missing for productSku=${offer.productSku} variant=${offer.variant}. ` +
        'Set STRIPE_PRICE_ID_JOB_PASS_* env vars or update Promos via /pricing-config admin page.',
    );
  }
  if (!offer.amount || offer.amount <= 0) {
    throw new Error('Stripe checkout requires a positive amount on the resolved offer');
  }

  const safeOrigin = buildSafeOrigin(origin);
  const { success_url, cancel_url } = buildJobPassStripeUrls({
    safeOrigin,
    returnContext,
    chatSessionId,
    jobId,
  });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [
      {
        price: offer.providerPriceRef,
        quantity: 1,
      },
    ],
    customer_email: userEmail || undefined,
    success_url,
    cancel_url,
    metadata: {
      ...metadata,
      passId: passId || '',
      jobId: jobId || '',
      productSku: offer.productSku,
      packQuantity: String(offer.packQuantity || 1),
      priceVariant: offer.variant,
      priceId: offer.providerPriceRef,
      currency: offer.currency,
      paymentProvider: PROVIDER_NAME,
      userEmail: userEmail || '',
      kind: 'job_pass',
    },
  });

  return {
    provider: PROVIDER_NAME,
    providerOrderId: session.id,
    providerCheckoutUrl: session.url,
    sessionId: session.id,
  };
};

/**
 * Convert a `checkout.session.completed` Stripe event into the canonical
 * shape that `bindPassToJob` understands. Returns null if this event does
 * not look like a Job Pass purchase (e.g. it's the Best Mates subscription).
 */
const parseCompletedCheckout = (checkoutSession) => {
  if (!checkoutSession) return null;
  if (checkoutSession.mode !== 'payment') return null;
  const md = checkoutSession.metadata || {};
  if (md.kind !== 'job_pass' && !md.productSku) return null;

  const productSku = md.productSku || 'job_pass_single';
  const packQuantity = Number.parseInt(md.packQuantity, 10) || (productSku === 'job_pass_3pack' ? 3 : 1);
  const paymentIntentId =
    typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id || null;
  const rawJobId = md.jobId != null && String(md.jobId).trim() ? String(md.jobId).trim() : null;

  return {
    paymentProvider: PROVIDER_NAME,
    providerOrderId: checkoutSession.id,
    providerPaymentId: paymentIntentId,
    providerPayerId:
      typeof checkoutSession.customer === 'string' ? checkoutSession.customer : checkoutSession.customer?.id || null,
    providerPriceRef: md.priceId || null,
    amountPaid: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total : null,
    currency: (checkoutSession.currency || md.currency || 'AUD').toUpperCase(),
    productSku,
    packQuantity,
    priceVariant: md.priceVariant || 'standard',
    userId: md.userId || null,
    userEmail: md.userEmail || checkoutSession.customer_details?.email || checkoutSession.customer_email || null,
    jobId: rawJobId,
    passId: md.passId || null,
    rawMetadata: md,
  };
};

const retrieveCheckoutSession = async (sessionId) => {
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
};

const refundPayment = async ({ providerPaymentId, amount }) => {
  if (!providerPaymentId) throw new Error('refundPayment requires providerPaymentId');
  return stripe.refunds.create({
    payment_intent: providerPaymentId,
    amount: amount || undefined,
  });
};

const validatePriceId = async (priceId) => {
  if (!priceId) {
    return { valid: false, error: 'Missing price id' };
  }
  try {
    const price = await stripe.prices.retrieve(priceId);
    return {
      valid: true,
      price: {
        id: price.id,
        active: price.active,
        currency: price.currency,
        unitAmount: price.unit_amount,
        productId: typeof price.product === 'string' ? price.product : price.product?.id,
      },
    };
  } catch (err) {
    return { valid: false, error: err?.message || 'Failed to retrieve price' };
  }
};

module.exports = {
  PROVIDER_NAME,
  createJobPassCheckout,
  parseCompletedCheckout,
  retrieveCheckoutSession,
  refundPayment,
  validatePriceId,
};
