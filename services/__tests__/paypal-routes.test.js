const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createPaypalRoutes = require('../paypal-routes');
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

describe('paypal capture ownership guards', () => {
  it('forbids capture when another user tries to capture user A order', async () => {
    const jobPassesStorage = createMemoryCollection([
      {
        passId: 'pass-1',
        paymentProvider: 'paypal',
        providerOrderId: 'order-1',
        userId: 'user_a',
        userEmail: 'a@test.com',
        targetJobId: 'job-a',
        status: 'pending',
        packRemaining: 1,
      },
    ]);

    const savedJobsStorage = createMemoryCollection([
      {
        jobId: 'job-a',
        userId: 'user_a',
        userEmail: 'a@test.com',
        sourceSessionId: 'sess-a',
        lockState: 'draft',
        snapshotFrozenAt: null,
        deletedAt: null,
      },
      {
        jobId: 'job-b',
        userId: 'user_b',
        userEmail: 'b@test.com',
        sourceSessionId: 'sess-b',
        lockState: 'draft',
        snapshotFrozenAt: null,
        deletedAt: null,
      },
    ]);

    const router = createPaypalRoutes({
      usersStorage: createMemoryCollection([
        { clerkId: 'user_a', userEmail: 'a@test.com' },
        { clerkId: 'user_b', userEmail: 'b@test.com' },
      ]),
      subscriptionStorage: createMemoryCollection([]),
      jobPassesStorage,
      savedJobsStorage,
      mateyChatSessionsStorage: createMemoryCollection([]),
      messagesJobStorage: createMemoryCollection([]),
      shedToolsStorage: createMemoryCollection([]),
      promoStorage: createMemoryCollection([]),
      offerAnalyticsStorage: createMemoryCollection([]),
      auditLogger: null,
      mongoClient: null,
    });

    const captureHandler = getRouteHandler(router, 'post', '/api/paypal/orders/:orderId/capture');
    const res = createRes();

    await captureHandler(
      {
        authUser: { userId: 'user_b', userEmail: 'b@test.com' },
        params: { orderId: 'order-1' },
        body: {},
      },
      res,
    );

    assert.equal(res.statusCode, 403);

    const jobA = await savedJobsStorage.findOne({ jobId: 'job-a' });
    const jobB = await savedJobsStorage.findOne({ jobId: 'job-b' });
    assert.equal(jobA.lockState, 'draft');
    assert.equal(jobA.snapshotFrozenAt, null);
    assert.equal(jobB.lockState, 'draft');
    assert.equal(jobB.snapshotFrozenAt, null);
  });
});
