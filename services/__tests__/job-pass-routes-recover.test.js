const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryCollection } = require('./memory-mongo');

const getRouteHandler = (router, method, path) => {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const buildRouterForRecover = ({ checkoutSession, parsedCheckout = null }) => {
  const hadStripeSecret = Object.prototype.hasOwnProperty.call(process.env, 'STRIPE_SECRET_KEY');
  const previousStripeSecret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

  const stripePath = require.resolve('../payment-providers/stripe-provider');
  const bindPath = require.resolve('../job-pass-bind');
  const routesPath = require.resolve('../job-pass-routes');

  const stripeProvider = require(stripePath);
  const bindModule = require(bindPath);

  const originalRetrieve = stripeProvider.retrieveCheckoutSession;
  const originalParse = stripeProvider.parseCompletedCheckout;
  const originalBind = bindModule.bindPassToJob;

  let bindCalls = 0;
  stripeProvider.retrieveCheckoutSession = async () => checkoutSession;
  stripeProvider.parseCompletedCheckout = () => parsedCheckout;
  bindModule.bindPassToJob = async () => {
    bindCalls += 1;
    return { status: 'unlocked', alreadyBound: false, pass: { passId: 'pass-1' } };
  };

  delete require.cache[routesPath];
  const createJobPassRoutes = require('../job-pass-routes');

  const savedJobsStorage = createMemoryCollection([
    {
      jobId: 'job-1',
      userId: 'u1',
      userEmail: 'a@test.com',
      lockState: 'draft',
      snapshotFrozenAt: null,
      sourceSessionId: 'sess-1',
      deletedAt: null,
    },
  ]);

  const router = createJobPassRoutes({
    usersStorage: createMemoryCollection([{ clerkId: 'u1', userEmail: 'a@test.com' }]),
    subscriptionStorage: createMemoryCollection([]),
    jobPassesStorage: createMemoryCollection([]),
    savedJobsStorage,
    mateyChatSessionsStorage: createMemoryCollection([]),
    messagesJobStorage: createMemoryCollection([]),
    shedToolsStorage: createMemoryCollection([]),
    promoStorage: createMemoryCollection([]),
    offerAnalyticsStorage: createMemoryCollection([]),
    auditLogger: null,
    mongoClient: null,
  });

  const restore = () => {
    stripeProvider.retrieveCheckoutSession = originalRetrieve;
    stripeProvider.parseCompletedCheckout = originalParse;
    bindModule.bindPassToJob = originalBind;
    delete require.cache[routesPath];
    if (hadStripeSecret) process.env.STRIPE_SECRET_KEY = previousStripeSecret;
    else delete process.env.STRIPE_SECRET_KEY;
  };

  return { router, savedJobsStorage, getBindCalls: () => bindCalls, restore };
};

describe('POST /api/job-pass/recover-session', () => {
  it('does not unlock for unpaid stripe session and returns non-success', async () => {
    const ctx = buildRouterForRecover({
      checkoutSession: { id: 'cs_1', payment_status: 'unpaid' },
      parsedCheckout: {
        paymentProvider: 'stripe',
        providerPaymentId: 'pi_1',
        userEmail: 'a@test.com',
        jobId: 'job-1',
      },
    });

    try {
      const handler = getRouteHandler(ctx.router, 'post', '/api/job-pass/recover-session');
      const res = createRes();
      await handler(
        {
          authUser: { userId: 'u1', userEmail: 'a@test.com' },
          body: { sessionId: 'cs_1' },
        },
        res,
      );

      assert.equal(res.statusCode, 409);
      assert.equal(ctx.getBindCalls(), 0);

      const job = await ctx.savedJobsStorage.findOne({ jobId: 'job-1' });
      assert.equal(job.lockState, 'draft');
      assert.equal(job.snapshotFrozenAt, null);
    } finally {
      ctx.restore();
    }
  });

  it('does not unlock for canceled/expired stripe session and returns non-success', async () => {
    const ctx = buildRouterForRecover({
      checkoutSession: { id: 'cs_2', payment_status: 'expired' },
      parsedCheckout: {
        paymentProvider: 'stripe',
        providerPaymentId: 'pi_2',
        userEmail: 'a@test.com',
        jobId: 'job-1',
      },
    });

    try {
      const handler = getRouteHandler(ctx.router, 'post', '/api/job-pass/recover-session');
      const res = createRes();
      await handler(
        {
          authUser: { userId: 'u1', userEmail: 'a@test.com' },
          body: { sessionId: 'cs_2' },
        },
        res,
      );

      assert.equal(res.statusCode, 409);
      assert.equal(ctx.getBindCalls(), 0);

      const job = await ctx.savedJobsStorage.findOne({ jobId: 'job-1' });
      assert.equal(job.lockState, 'draft');
      assert.equal(job.snapshotFrozenAt, null);
    } finally {
      ctx.restore();
    }
  });
});
