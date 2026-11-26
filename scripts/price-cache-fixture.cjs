// In-memory Mongo collection for offline content-cache checks; no real credentials or models.
exports.withPriceCache = (storage, cached = new Map()) => ({ ...storage, db: { ...storage.db, collection(name) {
  if (name !== 'agent_price_extractions') return storage.db.collection(name);
  return {
    async findOne(query) { return cached.has(query._id) ? structuredClone(cached.get(query._id)) : null; },
    async findOneAndUpdate(query, update) {
      if (!cached.has(query._id)) cached.set(query._id, structuredClone(update.$setOnInsert));
      return structuredClone(cached.get(query._id));
    },
  };
} } });
