const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createSavedJobsRouter = require('../saved-jobs-routes');
const { createMemoryCollection } = require('./memory-mongo');

const BASE_SNAPSHOT = {
  jobName: 'Deck repair',
  jobSummary: 'Initial frozen summary',
  shortlistPlan: [{ name: 'drill', group: 'must_buy' }],
  ownedToolsSnapshot: [{ name: 'impact driver', source: 'shed' }],
  imageRefs: [{ url: 'https://img/a.jpg', capturedAt: new Date('2026-01-01T00:00:00.000Z') }],
  budgetTier: 'mid',
  nextSteps: [{ label: 'Confirm timber dimensions', source: 'next_decision' }],
  jobState: {
    stageTracker: { currentStage: 'planning', nextDecision: 'Measure deck frame' },
    savedShoppingList: { mustBuy: ['drill'], alreadyOwned: ['impact driver'] },
  },
  jobStateSnapshot: {
    stageTracker: { currentStage: 'planning', nextDecision: 'Measure deck frame' },
    savedShoppingList: { mustBuy: ['drill'], alreadyOwned: ['impact driver'] },
  },
  snapshotFrozenAt: new Date('2026-01-01T00:00:00.000Z'),
  snapshotVersion: 1,
};

const getRouteHandler = (router, method, path) => {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const createRes = () => {
  return {
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
  };
};

const buildHarness = () => {
  const usersStorage = createMemoryCollection([{ userEmail: 'a@test.com', clerkId: 'u1' }]);
  const savedJobsStorage = createMemoryCollection([
    {
      jobId: 'job-1',
      userId: 'u1',
      userEmail: 'a@test.com',
      sourceSessionId: 'sess-a',
      lockState: 'draft',
      unlockType: 'none',
      deletedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
      resumeCount: 0,
      ...BASE_SNAPSHOT,
    },
    {
      jobId: 'job-unlocked',
      userId: 'u1',
      userEmail: 'a@test.com',
      sourceSessionId: 'sess-a',
      lockState: 'unlocked',
      unlockType: 'job_pass',
      paymentProvider: 'stripe',
      paymentId: 'pi_1',
      passId: 'pass_1',
      deletedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
      resumeCount: 0,
      ...BASE_SNAPSHOT,
    },
  ]);
  const jobPassesStorage = createMemoryCollection([]);
  const mateyChatSessionsStorage = createMemoryCollection([
    {
      sessionId: 'sess-a',
      userId: 'u1',
      userEmail: 'a@test.com',
      title: 'Original title',
      jobState: {
        stageTracker: { currentStage: 'planning', nextDecision: 'Measure deck frame' },
        savedShoppingList: { mustBuy: ['drill'], alreadyOwned: ['impact driver'] },
      },
    },
    {
      sessionId: 'sess-b',
      userId: 'u2',
      userEmail: 'b@test.com',
      title: 'Another user session',
      jobState: {},
    },
  ]);
  const messagesJobStorage = createMemoryCollection([
    {
      sessionId: 'sess-a',
      role: 'matey',
      suggestedTools: [{ name: 'track saw' }],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);
  const shedToolsStorage = createMemoryCollection([
    {
      user_id: 'u1',
      name: 'impact driver',
      category: 'tool',
      source: 'shed',
      originalPhrase: 'my impact driver',
    },
  ]);

  const router = createSavedJobsRouter({
    usersStorage,
    savedJobsStorage,
    jobPassesStorage,
    mateyChatSessionsStorage,
    messagesJobStorage,
    shedToolsStorage,
    offerAnalyticsStorage: createMemoryCollection([]),
    auditLogger: null,
  });

  return {
    router,
    usersStorage,
    savedJobsStorage,
    mateyChatSessionsStorage,
    messagesJobStorage,
  };
};

const snapshotSlice = (doc) => ({
  jobName: doc.jobName,
  jobSummary: doc.jobSummary,
  shortlistPlan: doc.shortlistPlan,
  ownedToolsSnapshot: doc.ownedToolsSnapshot,
  imageRefs: doc.imageRefs,
  budgetTier: doc.budgetTier,
  nextSteps: doc.nextSteps,
  jobState: doc.jobState,
  jobStateSnapshot: doc.jobStateSnapshot,
  snapshotFrozenAt: doc.snapshotFrozenAt,
  snapshotVersion: doc.snapshotVersion,
});

describe('saved-jobs-routes route-level behavior', () => {
  it('blocks PATCH edit before unlock', async () => {
    const { router } = buildHarness();
    const handler = getRouteHandler(router, 'patch', '/jobs/:jobId');
    const req = {
      authUser: { userId: 'u1', userEmail: 'a@test.com' },
      params: { jobId: 'job-1' },
      body: { jobSummary: 'mutated' },
    };
    const res = createRes();

    await handler(req, res);
    assert.equal(res.statusCode, 402);
  });

  it('blocks resume before unlock', async () => {
    const { router } = buildHarness();
    const handler = getRouteHandler(router, 'post', '/jobs/:jobId/resume');
    const req = {
      authUser: { userId: 'u1', userEmail: 'a@test.com' },
      params: { jobId: 'job-1' },
      body: {},
    };
    const res = createRes();

    await handler(req, res);
    assert.equal(res.statusCode, 402);
  });

  it('blocks cross-user jobId tampering on read and resume', async () => {
    const { router } = buildHarness();
    const readHandler = getRouteHandler(router, 'get', '/jobs/:jobId');
    const resumeHandler = getRouteHandler(router, 'post', '/jobs/:jobId/resume');

    const readRes = createRes();
    await readHandler(
      {
        authUser: { userId: 'u2', userEmail: 'b@test.com' },
        params: { jobId: 'job-unlocked' },
      },
      readRes,
    );
    assert.equal(readRes.statusCode, 404);

    const resumeRes = createRes();
    await resumeHandler(
      {
        authUser: { userId: 'u2', userEmail: 'b@test.com' },
        params: { jobId: 'job-unlocked' },
        body: {},
      },
      resumeRes,
    );
    assert.equal(resumeRes.statusCode, 404);
  });

  it('blocks cross-user source session tampering on save-readiness', async () => {
    const { router } = buildHarness();
    const readinessHandler = getRouteHandler(router, 'get', '/jobs/save-readiness');
    const req = {
      authUser: { userId: 'u2', userEmail: 'b@test.com' },
      query: { sessionId: 'sess-a' },
    };
    const res = createRes();

    await readinessHandler(req, res);
    assert.equal(res.statusCode, 403);
  });

  it('GET /jobs does not mutate frozen snapshot fields after source changes', async () => {
    const { router, savedJobsStorage, mateyChatSessionsStorage, messagesJobStorage } = buildHarness();
    const listHandler = getRouteHandler(router, 'get', '/jobs');

    const before = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });
    const expected = snapshotSlice(before);

    await mateyChatSessionsStorage.updateOne(
      { sessionId: 'sess-a' },
      {
        $set: {
          title: 'Mutated source title',
          jobState: {
            stageTracker: { currentStage: 'done', nextDecision: 'Buy everything again' },
            savedShoppingList: { mustBuy: ['new saw', 'new ladder'] },
          },
        },
      },
    );
    await messagesJobStorage.insertOne({
      sessionId: 'sess-a',
      role: 'matey',
      suggestedTools: [{ name: 'nail gun' }],
      images: ['https://img/new.jpg'],
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const res = createRes();
    await listHandler({ authUser: { userId: 'u1', userEmail: 'a@test.com' }, query: {} }, res);
    assert.equal(res.statusCode, 200);

    const after = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });
    assert.deepEqual(snapshotSlice(after), expected);
  });

  it('GET /jobs/:jobId does not mutate frozen snapshot fields', async () => {
    const { router, savedJobsStorage } = buildHarness();
    const handler = getRouteHandler(router, 'get', '/jobs/:jobId');
    const before = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });
    const expected = snapshotSlice(before);

    const res = createRes();
    await handler(
      {
        authUser: { userId: 'u1', userEmail: 'a@test.com' },
        params: { jobId: 'job-unlocked' },
      },
      res,
    );
    assert.equal(res.statusCode, 200);

    const after = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });
    assert.deepEqual(snapshotSlice(after), expected);
  });

  it('resume mutates only resume metadata and keeps snapshot exact', async () => {
    const { router, savedJobsStorage } = buildHarness();
    const handler = getRouteHandler(router, 'post', '/jobs/:jobId/resume');
    const before = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });
    const expected = snapshotSlice(before);

    const res = createRes();
    await handler(
      {
        authUser: { userId: 'u1', userEmail: 'a@test.com' },
        params: { jobId: 'job-unlocked' },
        body: {},
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    const after = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });

    assert.equal(after.resumeCount, 1);
    assert.ok(after.lastResumedAt);
    assert.ok(after.lastActivityAt);
    assert.deepEqual(snapshotSlice(after), expected);
  });

  it('PATCH updates only allowed fields and never resyncs snapshot fields from source', async () => {
    const { router, savedJobsStorage } = buildHarness();
    const handler = getRouteHandler(router, 'patch', '/jobs/:jobId');
    const before = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });

    const attemptedOwned = [{ name: 'hijacked-tool' }];
    const attemptedImages = [{ url: 'https://img/hijack.jpg' }];
    const attemptedState = { stageTracker: { currentStage: 'done' } };

    const res = createRes();
    await handler(
      {
        authUser: { userId: 'u1', userEmail: 'a@test.com' },
        params: { jobId: 'job-unlocked' },
        body: {
          jobName: 'Updated name',
          jobSummary: 'Updated summary',
          budgetTier: 'high',
          ownedToolsSnapshot: attemptedOwned,
          imageRefs: attemptedImages,
          jobState: attemptedState,
          jobStateSnapshot: attemptedState,
          snapshotFrozenAt: null,
          snapshotVersion: 999,
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    const after = await savedJobsStorage.findOne({ jobId: 'job-unlocked' });

    assert.equal(after.jobName, 'Updated name');
    assert.equal(after.jobSummary, 'Updated summary');
    assert.equal(after.budgetTier, 'high');

    assert.deepEqual(after.ownedToolsSnapshot, before.ownedToolsSnapshot);
    assert.deepEqual(after.imageRefs, before.imageRefs);
    assert.deepEqual(after.jobState, before.jobState);
    assert.deepEqual(after.jobStateSnapshot, before.jobStateSnapshot);
    assert.equal(after.snapshotVersion, before.snapshotVersion);
    assert.deepEqual(after.snapshotFrozenAt, before.snapshotFrozenAt);
  });
});
