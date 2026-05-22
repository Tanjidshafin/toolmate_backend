const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionTitle, normalizeTitleText } = require('../session-title');

describe('buildSessionTitle (user-origin only)', () => {
  it('derives title from meaningful user task text', () => {
    const title = buildSessionTitle('Fix leaking kitchen tap under the sink');
    assert.equal(title, 'Fix leaking kitchen tap under the sink');
  });

  it('rejects Matey-style opener text', () => {
    assert.equal(buildSessionTitle('Great question! Here is what you need.'), null);
    assert.equal(buildSessionTitle('What are we fixing, building, or figuring out?'), null);
    assert.equal(buildSessionTitle('G day mate'), null);
  });

  it('rejects short or empty user text', () => {
    assert.equal(buildSessionTitle('hi'), null);
    assert.equal(buildSessionTitle(''), null);
  });

  it('uses first sentence for long user messages', () => {
    const title = buildSessionTitle('Replace bathroom vanity. It is chipped on the corner.');
    assert.equal(title, 'Replace bathroom vanity');
  });

  it('normalizes unsafe patterns consistently', () => {
    assert.equal(normalizeTitleText('New Chat!!!'), 'new chat');
  });
});
