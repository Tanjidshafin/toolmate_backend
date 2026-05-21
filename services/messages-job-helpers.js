/**
 * Pure helpers for chat session surface state + shopping-list merge (unit-tested).
 */

const normalizeArray = (value) => (Array.isArray(value) ? value : []);
const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeStringArray = (value) =>
  normalizeArray(value)
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);

const SHOPPING_CATEGORY_PATTERNS = [
  { category: 'PPE', regex: /\b(safety specs|safety glasses|goggles|gloves|respirator|dust mask|ear protection)\b/i },
  { category: 'fastener', regex: /\b(screws?|nails?|bolts?)\b/i },
  { category: 'fixing', regex: /\b(wall plugs?|anchors?|anchor bolts?)\b/i },
  { category: 'consumable', regex: /\b(sandpaper|blades?|adhesive|sealant|tape|filler|paint|primer|caulk)\b/i },
  { category: 'material', regex: /\b(joint compound|plaster patch|compound|primer|filler|sealant|paint)\b/i },
  { category: 'tool', regex: /\b(drill|driver|knife|hammer|screwdriver|sander|taping knife|level)\b/i },
  { category: 'accessory', regex: /\b(adapter|attachment|extension cord|extension|charger|battery pack|battery)\b/i },
  { category: 'rental', regex: /\b(rent|rental|hire|borrow)\b/i },
];

const CANONICAL_SHOPPING_ALIASES = {
  'safety specs': 'safety glasses',
  'safety spectacles': 'safety glasses',
  goggles: 'safety glasses',
  'safety goggles': 'safety glasses',
  'p2 mask': 'p2 respirator',
  'dust mask': 'p2 respirator',
  respirator: 'p2 respirator',
  'drill bits': 'drill bit',
  'masonry bits': 'masonry bit',
  /** Shed / ownership dedupe: treat variants as same core tool where safe */
  'a drill': 'drill',
  'the drill': 'drill',
  'my drill': 'drill',
  'cordless drill': 'drill',
  'battery drill': 'drill',
  'power drill': 'drill',
  'electric drill': 'drill',
};

const canonicalizeShoppingItem = (rawItem) => {
  let normalized = normalizeText(rawItem).toLowerCase();
  if (!normalized) return '';
  const alias = CANONICAL_SHOPPING_ALIASES[normalized];
  if (alias) return alias;
  if (normalized.endsWith(' bits')) normalized = normalized.slice(0, -1);
  const stripped = normalized.replace(/^(a|an|the|my|our)\s+/i, '').trim();
  if (stripped && stripped !== normalized) {
    const alias2 = CANONICAL_SHOPPING_ALIASES[stripped];
    if (alias2) return alias2;
    normalized = stripped;
  }
  if (normalized.endsWith(' bit')) return normalized;
  return normalized;
};

const inferShoppingCategory = (itemName) => {
  for (const matcher of SHOPPING_CATEGORY_PATTERNS) {
    if (matcher.regex.test(itemName)) return matcher.category;
  }
  return 'unknown';
};

/** Higher wins on conflict (user-owned beats assistant must_buy). */
const STATUS_PRIORITY = {
  already_owned: 100,
  not_needed: 90,
  safety: 85,
  hire_or_borrow: 80,
  consumable: 70,
  optional: 60,
  must_buy: 50,
};

const DERIVED_SHOPPING_REASONS = new Set([
  'derived from assistant guidance',
  'reconstructed from saved shopping list category',
]);

const mergeUserOverrides = (a, b) => {
  const ao = a && typeof a === 'object' ? a : {};
  const bo = b && typeof b === 'object' ? b : {};
  const merged = {};
  if (ao.status || bo.status) merged.status = true;
  if (ao.reason || bo.reason) merged.reason = true;
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const isDerivedShoppingReason = (reason) => {
  const r = normalizeText(reason).toLowerCase();
  return !r || DERIVED_SHOPPING_REASONS.has(r);
};

const normalizeUserRemovedSet = (savedShoppingList = {}) => {
  const source = savedShoppingList && typeof savedShoppingList === 'object' ? savedShoppingList : {};
  return new Set(
    normalizeStringArray(source.userRemovedItems)
      .map((name) => canonicalizeShoppingItem(name))
      .filter(Boolean),
  );
};

function mergeShoppingItems(...itemGroups) {
  const merged = new Map();
  itemGroups.forEach((group, gi) => {
    normalizeArray(group).forEach((entry, ei) => {
      if (!entry || typeof entry !== 'object') return;
      const item = canonicalizeShoppingItem(entry.item || entry.name || '');
      if (!item) return;
      const status = entry.status || 'must_buy';
      const pri = STATUS_PRIORITY[status] ?? 0;
      const order = gi * 10000 + ei;
      const existing = merged.get(item);
      const oldPri = existing ? STATUS_PRIORITY[existing.status || 'must_buy'] ?? 0 : -1;
      const statusLocked = Boolean(existing?.userOverrides?.status);
      const reasonLocked = Boolean(existing?.userOverrides?.reason);
      const shouldTakeNew =
        !existing || (!statusLocked && (pri > oldPri || (pri === oldPri && order > existing._order)));
      if (shouldTakeNew) {
        let finalStatus = status;
        let finalReason = entry.reason || '';
        if (existing?.userOverrides?.status) {
          finalStatus = existing.status || status;
        }
        if (reasonLocked && existing?.reason) {
          finalReason = existing.reason;
        } else if (entry.userOverrides?.reason && !isDerivedShoppingReason(entry.reason)) {
          finalReason = entry.reason || finalReason;
        }
        const userOverrides = mergeUserOverrides(existing?.userOverrides, entry.userOverrides);
        const row = {
          item,
          category: entry.category || existing?.category || inferShoppingCategory(item),
          status: finalStatus,
          reason: finalReason,
          _order: order,
        };
        if (userOverrides) row.userOverrides = userOverrides;
        merged.set(item, row);
      } else if (existing) {
        const userOverrides = mergeUserOverrides(existing.userOverrides, entry.userOverrides);
        if (userOverrides) {
          merged.set(item, { ...existing, userOverrides, _order: existing._order });
        }
      }
    });
  });
  return Array.from(merged.values()).map(({ _order, ...rest }) => rest);
}

const SHOPPING_ITEM_REGEX =
  /\b(joint compound|plaster patch|taping knife|sandpaper|primer|safety specs|safety glasses|goggles|dust mask|p2 mask|gloves|respirator|drill|hammer drill|drill bits?|masonry bits?|screws?|wall plugs?|anchors?|adhesive|sealant|tape|filler|paint|caulk|blades?|ear protection|sanding block|adapter|attachment|extension cord|extension|charger|battery pack|battery)\b/gi;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const inferShoppingStatus = (content, itemName) => {
  const lowered = content.toLowerCase();
  const item = itemName.toLowerCase();
  const aroundItemRegex = new RegExp(`(.{0,40}${escapeRegex(item)}.{0,40})`, 'i');
  const local = (lowered.match(aroundItemRegex)?.[0] || lowered).toLowerCase();
  if (/\b(don['’]?t need|not needed|no need|won['’]?t need|skip|avoid buying)\b/.test(local)) return 'not_needed';
  if (/\b(safety|ppe|goggles|mask|respirator|gloves|ear protection)\b/.test(item)) return 'safety';
  if (/\b(hire|rent|borrow)\b/.test(local)) return 'hire_or_borrow';
  if (/\b(optional|better option|worth upgrading|upgrade|cleaner finish)\b/.test(local)) return 'optional';
  if (/\b(consumable|single use|used up)\b/.test(local)) return 'consumable';
  if (/\b(you(?:'| wi)ll need|you need|grab|pick up|get|use)\b/.test(local)) return 'must_buy';
  return 'must_buy';
};

/**
 * Parse Matey message text into shopping rows, respecting user locks and removals.
 */
function buildShoppingItemsFromAssistant(content, previousItems = [], savedShoppingList = {}) {
  const source = typeof content === 'string' ? content : '';
  const userRemoved = normalizeUserRemovedSet(savedShoppingList);
  const nextByKey = new Map();
  normalizeArray(previousItems).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const item = canonicalizeShoppingItem(entry.item || entry.name || '');
    if (!item || userRemoved.has(item)) return;
    nextByKey.set(item, {
      item,
      category: entry.category || inferShoppingCategory(item),
      status: entry.status || 'must_buy',
      reason: entry.reason || '',
      ...(entry.userOverrides && typeof entry.userOverrides === 'object' ? { userOverrides: entry.userOverrides } : {}),
    });
  });

  if (!source.trim()) return Array.from(nextByKey.values());

  const matches = source.match(SHOPPING_ITEM_REGEX) || [];
  matches.forEach((rawMatch) => {
    const item = canonicalizeShoppingItem(rawMatch);
    if (!item || userRemoved.has(item)) return;
    const key = item;
    const inferredStatus = inferShoppingStatus(source, item);
    const inferredPri = STATUS_PRIORITY[inferredStatus] ?? 0;
    const existing = nextByKey.get(key);
    let status = inferredStatus;
    let reason = existing?.reason || 'Derived from assistant guidance';

    if (existing?.userOverrides?.status) {
      status = existing.status || status;
    } else if (existing) {
      const existingPri = STATUS_PRIORITY[existing.status || 'must_buy'] ?? 0;
      if (inferredPri <= existingPri) {
        status = existing.status || status;
      }
    }

    if (existing?.userOverrides?.reason && existing.reason) {
      reason = existing.reason;
    } else if (!existing?.reason) {
      reason = 'Derived from assistant guidance';
    }

    nextByKey.set(key, {
      item: existing?.item || item,
      category: existing?.category || inferShoppingCategory(item),
      status,
      reason,
      ...(existing?.userOverrides ? { userOverrides: existing.userOverrides } : {}),
    });
  });

  return Array.from(nextByKey.values());
}

function reconstructShoppingItemsFromSavedList(savedShoppingList = {}) {
  const source = savedShoppingList && typeof savedShoppingList === 'object' ? savedShoppingList : {};
  const groups = [
    { key: 'mustBuy', status: 'must_buy' },
    { key: 'alreadyOwned', status: 'already_owned' },
    { key: 'already_owned', status: 'already_owned' },
    { key: 'optionalUpgrades', status: 'optional' },
    { key: 'consumables', status: 'consumable' },
    { key: 'safety', status: 'safety' },
    { key: 'hireOrBorrow', status: 'hire_or_borrow' },
    { key: 'notNeeded', status: 'not_needed' },
  ];

  const items = [];
  for (const group of groups) {
    normalizeStringArray(source[group.key]).forEach((name) => {
      const item = canonicalizeShoppingItem(name);
      if (!item) return;
      items.push({
        item,
        category: inferShoppingCategory(item),
        status: group.status,
        reason: 'Reconstructed from saved shopping list category',
      });
    });
  }
  return mergeShoppingItems(items);
}

function projectShoppingItemsToLists(items = [], alreadyOwnedFallback = [], existingSavedShoppingList = null) {
  const normalizedItems = normalizeArray(items);
  const rebuiltItems =
    normalizedItems.length > 0 ?
      normalizedItems
    : reconstructShoppingItemsFromSavedList(existingSavedShoppingList || {});

  const lists = {
    mustBuy: [],
    alreadyOwned: normalizeStringArray(alreadyOwnedFallback),
    optionalUpgrades: [],
    consumables: [],
    safety: [],
    hireOrBorrow: [],
    notNeeded: [],
  };
  rebuiltItems.forEach((entry) => {
    const item = canonicalizeShoppingItem(entry.item || entry.name || '');
    if (!item) return;
    switch (entry.status) {
      case 'already_owned':
        lists.alreadyOwned.push(item);
        break;
      case 'optional':
        lists.optionalUpgrades.push(item);
        break;
      case 'consumable':
        lists.consumables.push(item);
        break;
      case 'safety':
        lists.safety.push(item);
        break;
      case 'hire_or_borrow':
        lists.hireOrBorrow.push(item);
        break;
      case 'not_needed':
        lists.notNeeded.push(item);
        break;
      default:
        lists.mustBuy.push(item);
        break;
    }
  });

  Object.keys(lists).forEach((key) => {
    lists[key] = Array.from(new Set(lists[key].map((item) => item.trim()).filter(Boolean)));
  });
  lists.mustBuy = lists.mustBuy.filter((x) => !lists.alreadyOwned.includes(x));
  return lists;
}

function defaultSurfaceState() {
  const entry = () => ({ dismissed: false });
  return {
    budget: entry(),
    shed: entry(),
    image_upload: entry(),
  };
}

function normalizeSurfaceStatePatch(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  const surface = body.surface;
  const action = body.action;
  const openedBy = body.openedBy;
  const validSurfaces = new Set(['budget', 'shed', 'image_upload']);
  const validActions = new Set(['dismiss', 'show', 'reopen']);
  if (!validSurfaces.has(surface)) return { error: 'Invalid surface' };
  if (!validActions.has(action)) return { error: 'Invalid action' };
  if (openedBy !== undefined && openedBy !== null && !['intent', 'manual', 'system'].includes(openedBy)) {
    return { error: 'Invalid openedBy' };
  }
  return { surface, action, openedBy };
}

function mergeSurfaceEntry(prev = {}, patch) {
  const now = new Date().toISOString();
  const base = {
    dismissed: Boolean(prev.dismissed),
    ...(typeof prev.dismissedAt === 'string' ? { dismissedAt: prev.dismissedAt } : {}),
    ...(typeof prev.lastShownAt === 'string' ? { lastShownAt: prev.lastShownAt } : {}),
    ...(prev.openedBy ? { openedBy: prev.openedBy } : {}),
    ...(typeof prev.reopenRequestedAt === 'string' ? { reopenRequestedAt: prev.reopenRequestedAt } : {}),
  };
  if (patch.action === 'dismiss') {
    return {
      ...base,
      dismissed: true,
      dismissedAt: now,
    };
  }
  if (patch.action === 'reopen') {
    return {
      ...base,
      dismissed: false,
      reopenRequestedAt: now,
      ...(patch.openedBy ? { openedBy: patch.openedBy } : {}),
    };
  }
  if (patch.action === 'show') {
    return {
      ...base,
      lastShownAt: now,
      ...(patch.openedBy ? { openedBy: patch.openedBy } : {}),
    };
  }
  return base;
}

module.exports = {
  normalizeArray,
  normalizeText,
  normalizeStringArray,
  CANONICAL_SHOPPING_ALIASES,
  canonicalizeShoppingItem,
  inferShoppingCategory,
  mergeShoppingItems,
  mergeUserOverrides,
  isDerivedShoppingReason,
  normalizeUserRemovedSet,
  buildShoppingItemsFromAssistant,
  reconstructShoppingItemsFromSavedList,
  projectShoppingItemsToLists,
  defaultSurfaceState,
  normalizeSurfaceStatePatch,
  mergeSurfaceEntry,
  STATUS_PRIORITY,
  inferShoppingStatus,
};
