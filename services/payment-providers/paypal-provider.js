/**
 * PayPal payment provider for one-off Job Pass checkouts.
 *
 * Important behavioural differences vs Stripe (see plan §12 risk register):
 * - PayPal does NOT sign webhooks with HMAC. We must POST every webhook to
 *   `/v1/notifications/verify-webhook-signature` along with the headers and
 *   raw body to confirm authenticity.
 * - A successful order can land twice: once via the in-page SDK `onApprove`
 *   capture and once via the asynchronous `PAYMENT.CAPTURE.COMPLETED`
 *   webhook. Both must be safely idempotent at the binding layer.
 * - PayPal supports AUD only when the merchant account is configured for it.
 *   We log the configured currency on startup so prod-vs-sandbox mismatches
 *   are visible.
 *
 * We hit the REST API directly with axios — the Node SDK is a thin wrapper
 * around the same endpoints and pinning fewer dependencies makes the
 * webhook-replay logic easier to reason about.
 */

const axios = require('axios');
const { randomUUID } = require('crypto');

const PROVIDER_NAME = 'paypal';

const PAYPAL_ENVIRONMENTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

const getPayPalEnv = () => {
  const env = (process.env.PAYPAL_ENV || '').toLowerCase().trim();
  if (env !== 'sandbox' && env !== 'live') return null;
  return env;
};

const getApiBase = () => {
  const env = getPayPalEnv();
  if (!env) return null;
  return PAYPAL_ENVIRONMENTS[env];
};

const isPayPalConfigured = () => {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID &&
      process.env.PAYPAL_CLIENT_SECRET &&
      process.env.PAYPAL_WEBHOOK_ID &&
      getPayPalEnv(),
  );
};

/**
 * Boot-time PayPal env check (called from `index.js`). Two modes:
 * - throwIfPartial=true (default): if any PayPal env var is set we require
 *   the full set. This catches "I set PAYPAL_CLIENT_ID and forgot the
 *   webhook id, deployed to prod" failures.
 * - throwIfPartial=false: pure smoke check, used by admin validators.
 */
const validatePayPalEnv = ({ throwIfPartial = true } = {}) => {
  const present = {
    PAYPAL_CLIENT_ID: !!process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: !!process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: !!process.env.PAYPAL_WEBHOOK_ID,
    PAYPAL_ENV: !!getPayPalEnv(),
  };
  const anyPresent = Object.values(present).some(Boolean);
  const allPresent = Object.values(present).every(Boolean);

  if (!anyPresent) {
    console.log('PayPal: not configured (no PAYPAL_* env vars). Job Pass will only offer Stripe.');
    return { configured: false, environment: null };
  }

  if (!allPresent) {
    const missing = Object.entries(present)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const message =
      `PayPal is partially configured. Missing: ${missing.join(', ')}. ` +
      'Verify-webhook-signature requires PAYPAL_WEBHOOK_ID and a valid PAYPAL_ENV (sandbox|live).';
    if (throwIfPartial) {
      throw new Error(message);
    }
    console.warn(message);
    return { configured: false, environment: getPayPalEnv(), missing };
  }

  console.log(`PayPal: configured (env=${getPayPalEnv()}).`);
  return { configured: true, environment: getPayPalEnv() };
};

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

const fetchAccessToken = async () => {
  const apiBase = getApiBase();
  if (!apiBase) throw new Error('PAYPAL_ENV must be sandbox or live');
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt > now + 30_000) {
    return cachedAccessToken;
  }
  const response = await axios.post(
    `${apiBase}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_CLIENT_SECRET,
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  const { access_token: accessToken, expires_in: expiresIn } = response.data || {};
  if (!accessToken) {
    throw new Error('PayPal OAuth response missing access_token');
  }
  cachedAccessToken = accessToken;
  cachedAccessTokenExpiresAt = now + (Number(expiresIn) || 0) * 1000;
  return accessToken;
};

const minorToMajor = (amountMinor, currency) => {
  // PayPal accepts decimal values; for AUD/USD/etc that is two decimal places.
  // JPY/etc are zero-decimal but we don't support them today. Round to two
  // decimal places defensively.
  const value = (Number(amountMinor) || 0) / 100;
  return value.toFixed(2);
};

/**
 * Create a PayPal Order. Returns the order id and approve link so the
 * frontend can either redirect (hosted approval) or finalize via the SDK
 * `onApprove` callback (in-page button).
 */
const createJobPassOrder = async ({ offer, userEmail, jobId, passId, origin, metadata = {} }) => {
  if (!offer) throw new Error('PayPal order requires a resolved offer');
  if (!offer.amount || offer.amount <= 0) {
    throw new Error('PayPal order requires a positive amount on the resolved offer');
  }
  if (!isPayPalConfigured()) {
    throw new Error('PayPal is not configured on this server');
  }

  const apiBase = getApiBase();
  const accessToken = await fetchAccessToken();
  const safeOrigin = (origin || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  const sku = offer.providerPriceRef || (offer.productSku === 'job_pass_3pack' ? 'JOBPASS_3PACK' : 'JOBPASS_SINGLE');

  const customId = jobId || `pending-${passId || randomUUID()}`;
  const requestId = `jobpass-${passId || randomUUID()}`;

  const response = await axios.post(
    `${apiBase}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: passId || randomUUID(),
          custom_id: customId,
          invoice_id: `${passId || randomUUID()}-pending`,
          description: offer.description || 'Toolmate Job Pass',
          amount: {
            currency_code: offer.currency,
            value: minorToMajor(offer.amount, offer.currency),
            breakdown: {
              item_total: {
                currency_code: offer.currency,
                value: minorToMajor(offer.amount, offer.currency),
              },
            },
          },
          items: [
            {
              name: offer.productSku === 'job_pass_3pack' ? '3 Job Passes' : '1 Job Pass',
              quantity: '1',
              sku,
              category: 'DIGITAL_GOODS',
              unit_amount: {
                currency_code: offer.currency,
                value: minorToMajor(offer.amount, offer.currency),
              },
            },
          ],
        },
      ],
      application_context: {
        brand_name: 'Toolmate',
        user_action: 'PAY_NOW',
        return_url: `${safeOrigin}/job-pass/success?provider=paypal&job_id=${encodeURIComponent(jobId || '')}&product_sku=${encodeURIComponent(offer.productSku || 'job_pass_single')}`,
        cancel_url: `${safeOrigin}/job-pass/cancel?provider=paypal&job_id=${encodeURIComponent(jobId || '')}&product_sku=${encodeURIComponent(offer.productSku || 'job_pass_single')}`,
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'PayPal-Request-Id': requestId,
      },
    },
  );

  const order = response.data || {};
  const approveLink = (order.links || []).find((l) => l.rel === 'approve');

  return {
    provider: PROVIDER_NAME,
    providerOrderId: order.id,
    providerCheckoutUrl: approveLink?.href || null,
    rawOrder: order,
    requestMetadata: metadata,
  };
};

/**
 * Capture a previously-approved PayPal order. Idempotent at the API level
 * because the API itself rejects duplicate captures with `ORDER_ALREADY_CAPTURED`.
 */
const captureOrder = async (orderId) => {
  if (!orderId) throw new Error('captureOrder requires orderId');
  const apiBase = getApiBase();
  const accessToken = await fetchAccessToken();
  try {
    const response = await axios.post(
      `${apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'PayPal-Request-Id': `capture-${orderId}`,
        },
      },
    );
    return response.data;
  } catch (err) {
    const issue = err?.response?.data?.details?.[0]?.issue;
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      // Re-fetch the order so the caller can still derive the capture id.
      const order = await retrieveOrder(orderId);
      return { id: orderId, alreadyCaptured: true, order };
    }
    throw err;
  }
};

const retrieveOrder = async (orderId) => {
  if (!orderId) throw new Error('retrieveOrder requires orderId');
  const apiBase = getApiBase();
  const accessToken = await fetchAccessToken();
  const response = await axios.get(`${apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data;
};

const refundCapture = async ({ providerPaymentId, amount, currency }) => {
  if (!providerPaymentId) throw new Error('refundCapture requires providerPaymentId (capture id)');
  const apiBase = getApiBase();
  const accessToken = await fetchAccessToken();
  const body =
    amount && currency
      ? {
          amount: { value: minorToMajor(amount, currency), currency_code: currency },
        }
      : {};
  const response = await axios.post(
    `${apiBase}/v2/payments/captures/${encodeURIComponent(providerPaymentId)}/refund`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  return response.data;
};

/**
 * Verify a webhook payload by round-tripping it through PayPal's
 * verify-webhook-signature endpoint. Returns true only when PayPal
 * confirms the signature.
 *
 * @param {object} headers - The incoming request headers (lowercased).
 * @param {string|Buffer} rawBody - The exact raw request body.
 */
const verifyWebhookSignature = async ({ headers, rawBody }) => {
  if (!isPayPalConfigured()) {
    return { verified: false, error: 'PayPal not configured' };
  }
  if (!rawBody) {
    return { verified: false, error: 'Missing raw body for verification' };
  }
  const apiBase = getApiBase();
  const accessToken = await fetchAccessToken();

  const required = [
    'paypal-transmission-id',
    'paypal-transmission-time',
    'paypal-cert-url',
    'paypal-auth-algo',
    'paypal-transmission-sig',
  ];
  const lowered = {};
  for (const [k, v] of Object.entries(headers || {})) {
    lowered[k.toLowerCase()] = v;
  }
  for (const h of required) {
    if (!lowered[h]) {
      return { verified: false, error: `Missing PayPal verification header: ${h}` };
    }
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return { verified: false, error: 'Webhook body is not valid JSON' };
  }

  try {
    const response = await axios.post(
      `${apiBase}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo: lowered['paypal-auth-algo'],
        cert_url: lowered['paypal-cert-url'],
        transmission_id: lowered['paypal-transmission-id'],
        transmission_sig: lowered['paypal-transmission-sig'],
        transmission_time: lowered['paypal-transmission-time'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: parsedBody,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    const status = response.data?.verification_status;
    return {
      verified: status === 'SUCCESS',
      status,
      event: parsedBody,
    };
  } catch (err) {
    return {
      verified: false,
      error: err?.response?.data || err?.message || 'verify-webhook-signature failed',
    };
  }
};

/**
 * Convert a captured PayPal order (or capture event) into the canonical
 * `parsedEvent` shape consumed by `bindPassToJob`. Works for both:
 *   - the body returned by `captureOrder()` (in-page SDK path), and
 *   - the resource of a `PAYMENT.CAPTURE.COMPLETED` webhook.
 */
const parseCapturedOrder = (raw, fallbackContext = {}) => {
  if (!raw) return null;

  // Webhook event shape: top-level has resource_type + resource (the capture).
  if (raw.resource_type === 'capture' && raw.resource) {
    const capture = raw.resource;
    const supplementary = capture?.supplementary_data?.related_ids || {};
    const orderId = supplementary.order_id || fallbackContext.providerOrderId || null;
    const amount = capture.amount || {};
    return {
      paymentProvider: PROVIDER_NAME,
      providerOrderId: orderId,
      providerPaymentId: capture.id,
      providerPayerId: fallbackContext.providerPayerId || null,
      providerPriceRef: fallbackContext.providerPriceRef || null,
      amountPaid: Math.round((Number(amount.value) || 0) * 100),
      currency: (amount.currency_code || 'AUD').toUpperCase(),
      productSku: fallbackContext.productSku || 'job_pass_single',
      packQuantity: fallbackContext.packQuantity || 1,
      priceVariant: fallbackContext.priceVariant || 'standard',
      userEmail: fallbackContext.userEmail || null,
      jobId: fallbackContext.jobId || capture.custom_id || null,
      passId: fallbackContext.passId || null,
      rawMetadata: { customId: capture.custom_id, invoiceId: capture.invoice_id },
    };
  }

  // captureOrder() return shape: order with purchase_units[].payments.captures[].
  if (raw.id && Array.isArray(raw.purchase_units)) {
    const pu = raw.purchase_units[0] || {};
    const capture = pu.payments?.captures?.[0] || {};
    const amount = capture.amount || pu.amount || {};
    return {
      paymentProvider: PROVIDER_NAME,
      providerOrderId: raw.id,
      providerPaymentId: capture.id || null,
      providerPayerId: raw.payer?.payer_id || null,
      providerPriceRef: pu.items?.[0]?.sku || fallbackContext.providerPriceRef || null,
      amountPaid: Math.round((Number(amount.value) || 0) * 100),
      currency: (amount.currency_code || 'AUD').toUpperCase(),
      productSku: fallbackContext.productSku || 'job_pass_single',
      packQuantity: fallbackContext.packQuantity || 1,
      priceVariant: fallbackContext.priceVariant || 'standard',
      userEmail: raw.payer?.email_address || fallbackContext.userEmail || null,
      jobId: fallbackContext.jobId || pu.custom_id || null,
      passId: fallbackContext.passId || pu.reference_id || null,
      rawMetadata: { customId: pu.custom_id, invoiceId: pu.invoice_id, referenceId: pu.reference_id },
    };
  }

  return null;
};

module.exports = {
  PROVIDER_NAME,
  PAYPAL_ENVIRONMENTS,
  isPayPalConfigured,
  validatePayPalEnv,
  fetchAccessToken,
  createJobPassOrder,
  captureOrder,
  retrieveOrder,
  refundCapture,
  verifyWebhookSignature,
  parseCapturedOrder,
};
