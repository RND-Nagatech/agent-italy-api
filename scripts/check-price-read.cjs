// Persistent-job semantics with an atomic in-memory Mongo fixture; no external calls.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'price_read_test';
process.env.JWT_ACCESS_SECRET = 'offline-test-secret-at-least-32-characters';
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { BadGatewayException } = require('@nestjs/common');
const { PriceReadService } = require('../dist/src/agent/price-read.service');
const jobs = [];
const equal = (a, b) => a instanceof ObjectId ? a.equals(b) : a === b;
const matches = (doc, query) => Object.entries(query).every(([key, value]) => key === '$or'
  ? value.some(child => matches(doc, child))
  : value && typeof value === 'object' && '$lte' in value ? doc[key] <= value.$lte : equal(doc[key], value));
const apply = (doc, update) => { Object.assign(doc, update.$set); for (const key of Object.keys(update.$unset ?? {})) delete doc[key]; };
const collection = {
  async findOne(query) { const row = jobs.find(doc => matches(doc, query)); return row ? { ...row } : null; },
  async findOneAndUpdate(query, update, options = {}) {
    let row = jobs.find(doc => matches(doc, query));
    if (!row && options.upsert) { row = { _id: new ObjectId(), ...update.$setOnInsert }; jobs.push(row); }
    if (!row) return null; apply(row, update); return { ...row };
  },
  async updateOne(query, update) { const row = jobs.find(doc => matches(doc, query)); if (!row) return { matchedCount: 0 }; apply(row, update); return { matchedCount: 1 }; },
};
const mongo = { db: { collection: () => collection } };
const sessionId = new ObjectId().toHexString(), attachmentId = new ObjectId().toHexString();
let ownerAllowed = true, metadataChecks = 0, calls = 0, release;
const sessions = {
  async assertOwner(id, owner) { assert.equal(id, sessionId); if (owner !== 'owner' || !ownerAllowed) throw new Error('owner rejected'); },
  async prepareAttachments(id, owner, ids, required, metadata) { await this.assertOwner(id, owner); assert.equal(metadata, true); assert.deepEqual(ids, [attachmentId]); metadataChecks++; },
};
const reference = { id: attachmentId, filename: 'harga.jpeg', date: '2026-11-20', complete: true, warnings: [], rows: [] };
const references = {
  async scope(dto, owner, progress) {
    assert.equal(owner, 'owner'); assert.deepEqual(dto.attachmentIds, [attachmentId]); calls++;
    await progress({ message: 'Membaca tabel · percobaan 1/2' });
    return new Promise((resolve, reject) => { release = { resolve, reject }; });
  },
  async read() { return [reference]; },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const first = new PriceReadService(mongo, sessions, references);
  const otherInstance = new PriceReadService(mongo, sessions, references);
  const [started, duplicate] = await Promise.all([first.start(sessionId, attachmentId, 'owner'), otherInstance.start(sessionId, attachmentId, 'owner')]);
  assert.equal(started.id, duplicate.id); await tick(); assert.equal(calls, 1, 'atomic lease prevents duplicate model calls across instances');
  const progress = await otherInstance.get(started.id, 'owner');
  assert.equal(progress.status, 'reading'); assert.match(progress.message, /percobaan 1\/2/); assert.ok(progress.elapsedMs >= 0);
  release.resolve({ handled: true }); await tick();
  const ready = await otherInstance.get(started.id, 'owner');
  assert.equal(ready.status, 'complete'); assert.equal(ready.reference.id, attachmentId);
  await first.start(sessionId, attachmentId, 'owner'); assert.equal(calls, 1, 'successful extraction is reused');
  await assert.rejects(() => first.get(started.id, 'another-owner'), error => error.getStatus() === 404);
  await assert.rejects(() => first.start(sessionId, attachmentId, 'another-owner'), /owner rejected/);
  ownerAllowed = false; await assert.rejects(() => first.get(started.id, 'owner'), /owner rejected/); ownerAllowed = true;

  // Simulate a crashed worker, then verify another instance can resume its lease.
  jobs[0].status = 'reading'; jobs[0].leaseUntil = new Date(0); jobs[0].leaseToken = 'dead-worker';
  await otherInstance.get(started.id, 'owner'); await tick(); assert.equal(calls, 2);
  release.reject(new BadGatewayException('Layanan pembaca belum merespons; lampiran tetap tersimpan.')); await tick();
  const failure = await first.get(started.id, 'owner'); assert.equal(failure.status, 'error'); assert.match(failure.message, /lampiran tetap/);
  const retry = await first.start(sessionId, attachmentId, 'owner'); await tick();
  assert.equal(retry.id, started.id); assert.equal(calls, 3); assert.equal(jobs.length, 1, 'retry resumes the same persisted job and attachment');
  release.resolve({ handled: true }); await tick(); assert.equal((await first.get(started.id, 'owner')).status, 'complete');
  assert.ok(metadataChecks >= 3);
  console.log('Price read jobs passed: prompt response, progress, owner checks, concurrent instances, cached completion, stale-lease recovery, and same-file retry.');
})().catch(error => { console.error(error); process.exitCode = 1; });
