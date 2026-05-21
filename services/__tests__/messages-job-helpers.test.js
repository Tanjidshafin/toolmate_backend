const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeShoppingItem,
  mergeSurfaceEntry,
  defaultSurfaceState,
  mergeShoppingItems,
  projectShoppingItemsToLists,
  reconstructShoppingItemsFromSavedList,
  buildShoppingItemsFromAssistant,
} = require('../messages-job-helpers');

describe('canonicalizeShoppingItem (shed dedupe)', () => {
  it('maps drill variants to drill', () => {
    assert.equal(canonicalizeShoppingItem('a drill'), 'drill');
    assert.equal(canonicalizeShoppingItem('cordless drill'), 'drill');
    assert.equal(canonicalizeShoppingItem('the drill'), 'drill');
    assert.equal(canonicalizeShoppingItem('My Drill'), 'drill');
  });

  it('keeps hammer drill distinct where aliased', () => {
    const h = canonicalizeShoppingItem('hammer drill');
    assert.ok(h.includes('hammer') || h === 'hammer drill');
  });
});

describe('mergeSurfaceEntry', () => {
  it('dismiss stays dismissed until explicit reopen', () => {
    const base = defaultSurfaceState();
    let b = mergeSurfaceEntry(base.budget, { action: 'dismiss' });
    assert.equal(b.dismissed, true);
    b = mergeSurfaceEntry(b, { action: 'show', openedBy: 'intent' });
    assert.equal(b.dismissed, true);
    b = mergeSurfaceEntry(b, { action: 'reopen', openedBy: 'manual' });
    assert.equal(b.dismissed, false);
  });

  it('image_upload dismiss same semantics', () => {
    const base = defaultSurfaceState();
    let u = mergeSurfaceEntry(base.image_upload, { action: 'dismiss' });
    assert.equal(u.dismissed, true);
    u = mergeSurfaceEntry(u, { action: 'reopen', openedBy: 'manual' });
    assert.equal(u.dismissed, false);
  });
});

describe('shopping list ownership merge', () => {
  it('reconstructs categorized lists when items[] is missing', () => {
    const reconstructed = reconstructShoppingItemsFromSavedList({
      mustBuy: ['cordless drill', 'screws'],
      alreadyOwned: ['hammer'],
      optionalUpgrades: ['laser level'],
      consumables: ['sandpaper'],
      safety: ['gloves'],
      hireOrBorrow: ['tile cutter'],
      notNeeded: ['wall plugs'],
    });

    const byStatus = new Map(reconstructed.map((row) => [row.item, row.status]));
    assert.equal(byStatus.get('drill'), 'must_buy');
    assert.equal(byStatus.get('screws'), 'must_buy');
    assert.equal(byStatus.get('hammer'), 'already_owned');
    assert.equal(byStatus.get('laser level'), 'optional');
    assert.equal(byStatus.get('sandpaper'), 'consumable');
    assert.equal(byStatus.get('gloves'), 'safety');
    assert.equal(byStatus.get('tile cutter'), 'hire_or_borrow');
    assert.equal(byStatus.get('wall plugs'), 'not_needed');
  });

  it('moves drill to alreadyOwned and keeps unrelated mustBuy entries', () => {
    const previousFromCategories = reconstructShoppingItemsFromSavedList({
      mustBuy: ['cordless drill', 'screws'],
      alreadyOwned: [],
    });
    const merged = mergeShoppingItems(
      previousFromCategories,
      [{ item: 'drill', status: 'already_owned' }],
    );
    const lists = projectShoppingItemsToLists(merged, ['drill']);

    assert.deepEqual(lists.alreadyOwned, ['drill']);
    assert.deepEqual(lists.mustBuy, ['screws']);
    assert.equal(lists.mustBuy.includes('drill'), false);
    assert.equal(lists.mustBuy.includes('cordless drill'), false);
  });

  it('dedupes drill variants and keeps hammer drill distinct', () => {
    const merged = mergeShoppingItems(
      [
        { item: 'a drill', status: 'must_buy' },
        { item: 'the drill', status: 'must_buy' },
        { item: 'my drill', status: 'must_buy' },
        { item: 'cordless drill', status: 'must_buy' },
        { item: 'battery drill', status: 'must_buy' },
        { item: 'power drill', status: 'must_buy' },
      ],
      [{ item: 'drill', status: 'already_owned' }, { item: 'hammer drill', status: 'must_buy' }],
    );

    const names = merged.map((entry) => entry.item);
    const drillCount = names.filter((name) => name === 'drill').length;
    assert.equal(drillCount, 1);
    assert.ok(names.includes('hammer drill'));
  });
});

describe('user shopping overrides', () => {
  it('keeps already_owned when Matey says you need a drill', () => {
    const previous = [
      {
        item: 'drill',
        status: 'already_owned',
        reason: 'Updated by user',
        userOverrides: { status: true, reason: true },
      },
    ];
    const next = buildShoppingItemsFromAssistant(
      "You'll need a drill for this job — grab one from the store.",
      previous,
      {},
    );
    const drill = next.find((row) => row.item === 'drill');
    assert.ok(drill);
    assert.equal(drill.status, 'already_owned');
    assert.equal(drill.reason, 'Updated by user');
    assert.equal(drill.userOverrides?.status, true);
  });

  it('does not re-add items the user removed', () => {
    const next = buildShoppingItemsFromAssistant(
      'Pick up screws and a drill while you are there.',
      [],
      { userRemovedItems: ['drill'] },
    );
    assert.equal(next.some((row) => row.item === 'drill'), false);
    assert.ok(next.some((row) => row.item === 'screws'));
  });

  it('preserves user note when Matey re-mentions item without status lock', () => {
    const previous = [
      {
        item: 'screws',
        status: 'must_buy',
        reason: 'For the bracket',
        userOverrides: { reason: true },
      },
    ];
    const next = buildShoppingItemsFromAssistant('You will need screws for the fix.', previous, {});
    const row = next.find((entry) => entry.item === 'screws');
    assert.equal(row?.reason, 'For the bracket');
  });
});
