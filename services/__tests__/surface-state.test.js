const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSurfaceStatePatch,
  mergeSurfaceEntry,
  defaultSurfaceState,
} = require('../messages-job-helpers');

describe('surface-state PATCH helpers', () => {
  it('normalizeSurfaceStatePatch rejects invalid surface', () => {
    const bad = normalizeSurfaceStatePatch({ surface: 'budgets', action: 'dismiss' });
    assert.ok(bad.error);
  });

  it('budget dismissed cannot be reopened by show — only reopen', () => {
    const prev = defaultSurfaceState().budget;
    const dismissed = mergeSurfaceEntry(prev, { action: 'dismiss' });
    assert.equal(dismissed.dismissed, true);
    const afterShow = mergeSurfaceEntry(dismissed, { action: 'show', openedBy: 'intent' });
    assert.equal(afterShow.dismissed, true);
    const afterReopen = mergeSurfaceEntry(afterShow, { action: 'reopen', openedBy: 'manual' });
    assert.equal(afterReopen.dismissed, false);
  });
});
