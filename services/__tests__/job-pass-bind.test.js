const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { bindPassToJob } = require('../job-pass-bind');
const { createMemoryCollection } = require('./memory-mongo');

describe('bindPassToJob', () => {
  it('returns owner_mismatch when buyer userId does not own target job', async () => {
    const savedJobsStorage = createMemoryCollection([
      {
        jobId: 'job-owned-by-alice',
        userId: 'user_alice',
        lockState: 'draft',
        sourceSessionId: 'sess1',
        deletedAt: null,
      },
    ]);
    const jobPassesStorage = createMemoryCollection([]);
    const mateyChatSessionsStorage = createMemoryCollection([]);
    const messagesJobStorage = createMemoryCollection([]);
    const shedToolsStorage = createMemoryCollection([]);

    const result = await bindPassToJob({
      mongoClient: null,
      jobPassesStorage,
      savedJobsStorage,
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
      subscriptionStorage: null,
      offerAnalyticsStorage: createMemoryCollection([]),
      auditLogger: null,
      parsedEvent: {
        paymentProvider: 'stripe',
        providerPaymentId: 'pi_evil_1',
        providerOrderId: 'ord_evil_1',
        jobId: 'job-owned-by-alice',
        userId: 'user_bob',
        userEmail: 'bob@test.com',
        amountPaid: 999,
        currency: 'aud',
        productSku: 'job_pass_single',
        packQuantity: 1,
      },
      rawEvent: {},
    });

    assert.equal(result.status, 'owner_mismatch');
    assert.equal(result.savedJob, null);
    const job = await savedJobsStorage.findOne({ jobId: 'job-owned-by-alice' });
    assert.equal(job.lockState, 'draft');
  });

  it('unlocks and freezes snapshot on happy path', async () => {
    const savedJobsStorage = createMemoryCollection([
      {
        jobId: 'job-happy',
        userId: 'user_alice',
        lockState: 'draft',
        sourceSessionId: 'sess-h',
        deletedAt: null,
      },
    ]);
    const mateyChatSessionsStorage = createMemoryCollection([
      {
        sessionId: 'sess-h',
        userId: 'user_alice',
        jobState: {
          stageTracker: { lastRecommendation: 'Seal edges', nextDecision: 'Wait 24h' },
          savedShoppingList: { mustBuy: ['silicone'] },
        },
      },
    ]);
    const messagesJobStorage = createMemoryCollection([]);
    const shedToolsStorage = createMemoryCollection([]);
    const jobPassesStorage = createMemoryCollection([]);

    const result = await bindPassToJob({
      mongoClient: null,
      jobPassesStorage,
      savedJobsStorage,
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
      subscriptionStorage: null,
      offerAnalyticsStorage: createMemoryCollection([]),
      auditLogger: null,
      parsedEvent: {
        paymentProvider: 'stripe',
        providerPaymentId: 'pi_ok_1',
        providerOrderId: 'ord_ok_1',
        jobId: 'job-happy',
        userId: 'user_alice',
        userEmail: 'alice@test.com',
        amountPaid: 999,
        currency: 'aud',
        productSku: 'job_pass_single',
        packQuantity: 1,
      },
      rawEvent: {},
    });

    assert.equal(result.status, 'unlocked');
    assert.ok(result.savedJob);
    assert.equal(result.savedJob.lockState, 'unlocked');
    assert.ok(result.savedJob.snapshotFrozenAt);
  });

  it('paypal-style event unlocks only target job and replay is idempotent', async () => {
    const savedJobsStorage = createMemoryCollection([
      {
        jobId: 'job-target',
        userId: 'user_alice',
        lockState: 'draft',
        sourceSessionId: 'sess-target',
        deletedAt: null,
      },
      {
        jobId: 'job-other',
        userId: 'user_alice',
        lockState: 'draft',
        sourceSessionId: 'sess-other',
        deletedAt: null,
      },
    ]);
    const mateyChatSessionsStorage = createMemoryCollection([
      {
        sessionId: 'sess-target',
        userId: 'user_alice',
        jobState: {
          stageTracker: { lastRecommendation: 'Use treated pine', nextDecision: 'Confirm joist spacing' },
          savedShoppingList: { mustBuy: ['treated pine'] },
        },
      },
      {
        sessionId: 'sess-other',
        userId: 'user_alice',
        jobState: {
          stageTracker: { lastRecommendation: 'Keep as-is', nextDecision: 'None' },
          savedShoppingList: { mustBuy: ['paint'] },
        },
      },
    ]);
    const messagesJobStorage = createMemoryCollection([]);
    const shedToolsStorage = createMemoryCollection([]);
    const jobPassesStorage = createMemoryCollection([]);

    const parsedEvent = {
      paymentProvider: 'paypal',
      providerPaymentId: 'paypal_cap_1',
      providerOrderId: 'paypal_ord_1',
      jobId: 'job-target',
      userId: 'user_alice',
      userEmail: 'alice@test.com',
      amountPaid: 499,
      currency: 'aud',
      productSku: 'job_pass_single',
      packQuantity: 1,
    };

    const first = await bindPassToJob({
      mongoClient: null,
      jobPassesStorage,
      savedJobsStorage,
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
      subscriptionStorage: null,
      offerAnalyticsStorage: createMemoryCollection([]),
      auditLogger: null,
      parsedEvent,
      rawEvent: { source: 'paypal_webhook' },
    });

    assert.equal(first.status, 'unlocked');
    const targetAfterFirst = await savedJobsStorage.findOne({ jobId: 'job-target' });
    const otherAfterFirst = await savedJobsStorage.findOne({ jobId: 'job-other' });
    assert.equal(targetAfterFirst.lockState, 'unlocked');
    assert.ok(targetAfterFirst.snapshotFrozenAt);
    assert.equal(otherAfterFirst.lockState, 'draft');

    const frozenAtFirst = targetAfterFirst.snapshotFrozenAt;
    const stateFirst = targetAfterFirst.jobStateSnapshot;

    const second = await bindPassToJob({
      mongoClient: null,
      jobPassesStorage,
      savedJobsStorage,
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
      subscriptionStorage: null,
      offerAnalyticsStorage: createMemoryCollection([]),
      auditLogger: null,
      parsedEvent,
      rawEvent: { source: 'paypal_webhook_replay' },
    });

    assert.equal(second.status, 'already_bound');
    const targetAfterReplay = await savedJobsStorage.findOne({ jobId: 'job-target' });
    const otherAfterReplay = await savedJobsStorage.findOne({ jobId: 'job-other' });
    assert.deepEqual(targetAfterReplay.snapshotFrozenAt, frozenAtFirst);
    assert.deepEqual(targetAfterReplay.jobStateSnapshot, stateFirst);
    assert.equal(otherAfterReplay.lockState, 'draft');
  });
});
