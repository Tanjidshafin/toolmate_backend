/**
 * Minimal in-memory collection for node:test (subset of Mongo filter/update).
 */

const getField = (doc, path) => {
  if (!path) return doc;
  const parts = String(path).split('.');
  let cur = doc;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
};

const matchesValue = (docVal, cond) => {
  /* Mongo: equality with null matches missing field */
  if (cond === null && (docVal === null || docVal === undefined)) return true;
  if (cond == null) return false;
  if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
    if (Object.hasOwn(cond, '$in')) {
      const list = cond.$in;
      const u = docVal === undefined;
      return list.some(
        (c) =>
          c === docVal
          || (c === null && (docVal === null || u))
          || (c === undefined && u),
      );
    }
    if (Object.hasOwn(cond, '$gt')) {
      return docVal > cond.$gt;
    }
    if (Object.hasOwn(cond, '$gte')) {
      return docVal >= cond.$gte;
    }
    if (Object.hasOwn(cond, '$ne')) {
      return docVal !== cond.$ne;
    }
    if (Object.hasOwn(cond, '$exists')) {
      const ex = cond.$exists;
      const has = docVal !== undefined;
      return ex ? has : !has;
    }
  }
  return docVal === cond;
};

const matches = (doc, filter) => {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(val) || !val.some((f) => matches(doc, f))) return false;
      continue;
    }
    const docVal = doc[key];
    if (!matchesValue(docVal, val)) return false;
  }
  return true;
};

const applyUpdate = (doc, update) => {
  if (!update || typeof update !== 'object') return;
  if (update.$setOnInsert && doc.__inserting) {
    Object.assign(doc, update.$setOnInsert);
  }
  if (update.$set) {
    Object.assign(doc, update.$set);
  }
  if (update.$inc) {
    for (const [k, inc] of Object.entries(update.$inc)) {
      doc[k] = (Number(doc[k]) || 0) + Number(inc);
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      doc[k].push(v && typeof v === 'object' ? { ...v } : v);
    }
  }
  if (update.$pull && doc.consumptions) {
    const crit = update.$pull;
    doc.consumptions = doc.consumptions.filter((row) => !matches(row, crit));
  }
};

function createMemoryCollection(initialDocs = []) {
  let docs = initialDocs.map((d, i) => ({
    ...d,
    _id: d._id ?? `mem-${i}`,
  }));

  const api = {
    /** @param filter unknown */
    async findOne(filter, _opts) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    async insertOne(doc) {
      const row = { ...doc, _id: doc._id ?? `mem-${docs.length}` };
      docs.push(row);
      return { insertedId: row._id };
    },
    async updateOne(filter, update, _opts) {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return { modifiedCount: 0 };
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    },
    async countDocuments(filter) {
      return docs.filter((d) => matches(d, filter)).length;
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      let idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1 && opts.upsert) {
        const doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$')) doc[k] = v;
        }
        doc.__inserting = true;
        applyUpdate(doc, update);
        delete doc.__inserting;
        docs.push(doc);
        idx = docs.length - 1;
      }
      if (idx === -1) return null;
      const doc = docs[idx];
      doc.__inserting = false;
      applyUpdate(doc, update);
      const ret = { ...doc };
      return opts.returnDocument === 'after' ? ret : ret;
    },
    find(filter) {
      let rows = docs.filter((d) => matches(d, filter));
      return {
        project() {
          return this;
        },
        sort(spec = {}) {
          const [field, dir] = Object.entries(spec)[0] || [];
          if (!field) return this;
          const mult = Number(dir) >= 0 ? 1 : -1;
          rows = [...rows].sort((a, b) => {
            const av = getField(a, field);
            const bv = getField(b, field);
            if (av === bv) return 0;
            if (av == null) return -1 * mult;
            if (bv == null) return 1 * mult;
            return av > bv ? 1 * mult : -1 * mult;
          });
          return this;
        },
        limit(n) {
          const cap = Number(n);
          if (Number.isFinite(cap) && cap >= 0) {
            rows = rows.slice(0, cap);
          }
          return this;
        },
        async toArray() {
          return rows.map((r) => ({ ...r }));
        },
      };
    },
    /** test helper */
    _dump() {
      return [...docs];
    },
    _seed(nextDocs) {
      docs = nextDocs.map((d, i) => ({
        ...d,
        _id: d._id ?? `mem-${i}`,
      }));
    },
  };

  return api;
}

module.exports = {
  createMemoryCollection,
  matches,
};
