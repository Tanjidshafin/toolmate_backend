const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotHelpers } = require('../saved-jobs-snapshot');
const { unlockSavedJob } = require('../job-pass-bind');
const { createMemoryCollection } = require('./memory-mongo');

describe('freezeSnapshotIfNotFrozen', () => {
  let mateyChatSessionsStorage;
  let messagesJobStorage;
  let shedToolsStorage;
  let savedJobsStorage;

  beforeEach(() => {
    mateyChatSessionsStorage = createMemoryCollection([
      {
        sessionId: 's1',
        userId: 'u1',
        jobState: {
          stageTracker: {
            currentStage: 'execution',
            lastRecommendation: 'Countersink carefully around hinge screws',
            nextDecision: 'Hang doors starting with top hinge',
          },
          savedShoppingList: { mustBuy: ['cabinet screws', '220 grit sandpaper'] },
          decisionLog: [{ key: 'budgetTier', value: 'medium', label: 'Budget' }],
        },
      },
    ]);
    messagesJobStorage = createMemoryCollection([
      { sessionId: 's1', role: 'user', suggestedTools: [{ name: 'track saw' }], createdAt: new Date() },
    ]);
    shedToolsStorage = createMemoryCollection([]);
    savedJobsStorage = createMemoryCollection([
      {
        jobId: 'job-1',
        sourceSessionId: 's1',
        userId: 'u1',
        lockState: 'draft',
        snapshotFrozenAt: null,
        jobSummary: 'old summary',
      },
    ]);
  });

  it('writes snapshot once and second freeze is a no-op', async () => {
    const helpers = createSnapshotHelpers({
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
    });
    const jobBefore = await savedJobsStorage.findOne({ jobId: 'job-1' });
    let updates = 0;
    const orig = savedJobsStorage.findOneAndUpdate.bind(savedJobsStorage);
    savedJobsStorage.findOneAndUpdate = async (...args) => {
      updates += 1;
      return orig(...args);
    };

    const first = await helpers.freezeSnapshotIfNotFrozen({
      savedJobsStorage,
      jobDoc: jobBefore,
      snapshotReason: 'payment_success',
      session: null,
    });

    assert.ok(first.snapshotFrozenAt);
    assert.notEqual(first.jobSummary, 'old summary');

    updates = 0;
    const second = await helpers.freezeSnapshotIfNotFrozen({
      savedJobsStorage,
      jobDoc: first,
      snapshotReason: 'payment_success',
      session: null,
    });
    assert.equal(updates, 0);
    assert.equal(second.jobSummary, first.jobSummary);
    assert.ok(second.snapshotFrozenAt);
  });

  it('unlockSavedJob flips lock then freezes snapshot', async () => {
    const jobDoc = await savedJobsStorage.findOne({ jobId: 'job-1' });
    const unlocked = await unlockSavedJob({
      savedJobsStorage,
      jobDoc,
      passId: 'pass-1',
      paymentProvider: 'stripe',
      paymentId: 'pi_test',
      session: null,
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
      freezeReason: 'job_pass_unlock',
    });

    assert.equal(unlocked.lockState, 'unlocked');
    assert.ok(unlocked.snapshotFrozenAt);
    assert.ok(unlocked.jobStateSnapshot);
  });

  it('keeps suggested tools separate from ownedToolsSnapshot', async () => {
    const helpers = createSnapshotHelpers({
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
    });

    await shedToolsStorage.insertOne({
      user_id: 'u1',
      name: 'impact driver',
      category: 'tool',
      source: 'shed',
      originalPhrase: 'my impact driver',
    });

    await mateyChatSessionsStorage.updateOne(
      { sessionId: 's1' },
      {
        $set: {
          jobState: {
            stageTracker: { currentStage: 'planning' },
            savedShoppingList: { alreadyOwned: ['drill'] },
          },
        },
      },
    );

    const jobBefore = await savedJobsStorage.findOne({ jobId: 'job-1' });
    const frozen = await helpers.freezeSnapshotIfNotFrozen({
      savedJobsStorage,
      jobDoc: jobBefore,
      snapshotReason: 'payment_success',
      session: null,
    });

    const ownedNames = (frozen.ownedToolsSnapshot || []).map((tool) => tool.name).sort();
    const suggestedNames = (frozen.suggestedToolsSnapshot || []).map((tool) => tool.name).sort();

    assert.deepEqual(ownedNames, ['drill', 'impact driver']);
    assert.deepEqual(suggestedNames, ['track saw']);
    assert.equal(ownedNames.includes('track saw'), false);
  });

  it('frozen snapshot stays exact after source session mutates heavily', async () => {
    const helpers = createSnapshotHelpers({
      mateyChatSessionsStorage,
      messagesJobStorage,
      shedToolsStorage,
    });

    const jobBefore = await savedJobsStorage.findOne({ jobId: 'job-1' });
    const frozen = await helpers.freezeSnapshotIfNotFrozen({
      savedJobsStorage,
      jobDoc: jobBefore,
      snapshotReason: 'payment_success',
      session: null,
    });

    const frozenFields = {
      jobSummary: frozen.jobSummary,
      shortlistPlan: frozen.shortlistPlan,
      ownedToolsSnapshot: frozen.ownedToolsSnapshot,
      imageRefs: frozen.imageRefs,
      budgetTier: frozen.budgetTier,
      nextSteps: frozen.nextSteps,
      jobState: frozen.jobState,
      jobStateSnapshot: frozen.jobStateSnapshot,
      snapshotFrozenAt: frozen.snapshotFrozenAt,
      snapshotVersion: frozen.snapshotVersion,
    };

    await mateyChatSessionsStorage.updateOne(
      { sessionId: 's1' },
      {
        $set: {
          title: 'completely changed title',
          jobState: {
            stageTracker: {
              currentStage: 'done',
              lastRecommendation: 'Buy a circular saw and nail gun',
              nextDecision: 'Replace entire deck frame',
            },
            savedShoppingList: {
              mustBuy: ['nail gun', 'decking screws', 'circular saw'],
              alreadyOwned: ['none'],
              consumables: ['paint'],
            },
            decisionLog: [
              { key: 'budgetTier', value: 'high', label: 'Budget' },
              { key: 'material', value: 'merbau', label: 'Material' },
            ],
            missingItems: { missing: ['new posts', 'bearers'] },
          },
        },
      },
    );

    await messagesJobStorage.insertOne({
      sessionId: 's1',
      role: 'matey',
      suggestedTools: [{ name: 'nail gun' }, { name: 'circular saw' }],
      images: ['https://img/new-photo.jpg'],
      content: 'new shopping list',
      createdAt: new Date(Date.now() + 1000),
    });

    const second = await helpers.freezeSnapshotIfNotFrozen({
      savedJobsStorage,
      jobDoc: frozen,
      snapshotReason: 'payment_success',
      session: null,
    });

    assert.deepEqual(
      {
        jobSummary: second.jobSummary,
        shortlistPlan: second.shortlistPlan,
        ownedToolsSnapshot: second.ownedToolsSnapshot,
        imageRefs: second.imageRefs,
        budgetTier: second.budgetTier,
        nextSteps: second.nextSteps,
        jobState: second.jobState,
        jobStateSnapshot: second.jobStateSnapshot,
        snapshotFrozenAt: second.snapshotFrozenAt,
        snapshotVersion: second.snapshotVersion,
      },
      frozenFields,
    );
  });
});
