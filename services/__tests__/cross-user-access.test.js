const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ownsSavedJob, ownsChatSession } = require('../saved-jobs-internal');

describe('ownsSavedJob', () => {
  it('matches userId exactly', () => {
    assert.equal(
      ownsSavedJob(
        { userId: 'user_a', jobId: 'j1', deletedAt: null },
        { userId: 'user_a', userEmail: 'a@test.com' },
      ),
      true,
    );
    assert.equal(
      ownsSavedJob(
        { userId: 'user_a', jobId: 'j1', deletedAt: null },
        { userId: 'user_b', userEmail: 'a@test.com' },
      ),
      false,
    );
  });

  it('rejects soft-deleted rows', () => {
    assert.equal(
      ownsSavedJob({ userId: 'user_a', jobId: 'j1', deletedAt: new Date() }, { userId: 'user_a' }),
      false,
    );
  });

  it('legacy email-scoped row matches email when no userId on job', () => {
    assert.equal(
      ownsSavedJob({ userEmail: 'legacy@test.com', jobId: 'j1' }, { userEmail: 'legacy@test.com' }),
      true,
    );
  });
});

describe('ownsChatSession', () => {
  it('requires auth userId', () => {
    assert.equal(ownsChatSession({ sessionId: 's', userId: 'u1' }, { userEmail: 'x@test.com' }), false);
  });

  it('matches session userId', () => {
    assert.equal(ownsChatSession({ sessionId: 's', userId: 'u1' }, { userId: 'u1', userEmail: 'x@test.com' }), true);
  });
});
