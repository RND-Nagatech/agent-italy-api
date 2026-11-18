process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'agent_skills_offline_check';
process.env.JWT_ACCESS_SECRET = 'offline-agent-skills-secret-at-least-32-characters';
process.env.DEEPSEEK_API_KEY = 'offline-agent-skills-model';

require('reflect-metadata');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { AgentSkillsService } = require('../dist/src/agent/agent-skills.service');
const { AgentService } = require('../dist/src/agent/agent.service');

function matches(document, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = document[field];
    if (field === '_id') return String(actual) === String(expected);
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

function memoryMongo() {
  const documents = [];
  const collection = {
    find(filter = {}) {
      let sortSpec = {};
      let limit = Infinity;
      const cursor = {
        sort(spec) { sortSpec = spec; return cursor; },
        limit(value) { limit = value; return cursor; },
        async toArray() {
          const rows = documents.filter(document => matches(document, filter));
          const fields = Object.entries(sortSpec);
          rows.sort((left, right) => {
            for (const [field, direction] of fields) {
              const a = left[field] instanceof Date ? left[field].getTime() : left[field];
              const b = right[field] instanceof Date ? right[field].getTime() : right[field];
              if (a < b) return -direction;
              if (a > b) return direction;
            }
            return 0;
          });
          return rows.slice(0, limit);
        },
      };
      return cursor;
    },
    async insertOne(document) { documents.push(document); return { insertedId: document._id }; },
    async findOne(filter) { return documents.find(document => matches(document, filter)) ?? null; },
    async updateOne(filter, update) {
      const document = documents.find(candidate => matches(candidate, filter));
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(document, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const index = documents.findIndex(document => matches(document, filter));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
  return { db: { collection: name => name === 'agent_skills' ? collection : (() => { throw new Error(`Unexpected collection ${name}`); })() } };
}

(async () => {
  const principal = { sub: new ObjectId().toHexString(), role: 'admin', branchId: null };
  const service = new AgentSkillsService(memoryMongo());
  const instructions = 'INSTRUKSI_SKILL_SHORTFALL_TEST: gunakan sisa kebutuhan setelah transfer.';
  const created = await service.create({
    name: 'Tindak lanjut kekurangan alokasi stok',
    description: 'Uji keyword dan role',
    triggerKeywords: [' kebutuhan belum terpenuhi ', 'sisa kebutuhan'],
    roles: ['admin', 'pusat'],
    instructions,
    alwaysApply: false,
    enabled: true,
  }, principal);
  assert.equal(created.version, 1);
  assert.deepEqual(created.triggerKeywords, ['kebutuhan belum terpenuhi', 'sisa kebutuhan']);
  assert.equal((await service.list()).items.length, 1);

  const matched = await service.match('Berapa kebutuhan belum terpenuhi untuk CN?', 'admin');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, created.id);
  assert.deepEqual(await service.match('Berapa kebutuhan belum terpenuhi untuk CN?', 'cabang'), []);
  assert.deepEqual(await service.match('Tampilkan ringkasan penjualan bulan ini', 'admin'), []);

  const agent = new AgentService();
  agent.getAllowedSources = async () => [{ databaseName: 'central', alias: 'italy Pusat', branchId: 'PUSAT', sourceType: 'central' }];
  let capturedMessages;
  agent.requestModel = async messages => {
    capturedMessages = messages;
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Pemeriksaan skill berhasil.' } }] };
  };
  await agent.runChat(
    { requestId: 'agent-skills-offline-check', messages: [{ role: 'user', content: 'Berapa kebutuhan belum terpenuhi untuk CN?' }] },
    principal,
    { references: [], memories: [], warnings: [] },
    '', matched,
  );
  assert(capturedMessages[0].content.includes(instructions), 'Matched skill instructions must be inserted into the system message.');

  const updated = await service.update(created.id, { triggerKeywords: ['belum kebagian'], instructions: `${instructions} versi kedua.` }, principal);
  assert.equal(updated.version, 2);
  assert.deepEqual(await service.match('Berapa kebutuhan belum terpenuhi?', 'admin'), []);
  assert.equal((await service.match('Cabang ini belum kebagian stok', 'admin'))[0].version, 2);
  const disabled = await service.update(created.id, { enabled: false }, principal);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await service.match('Cabang ini belum kebagian stok', 'admin'), []);
  await assert.rejects(service.create({
    name: 'Skill tanpa pemicu', description: '', triggerKeywords: [], roles: ['admin'],
    instructions: 'Instruksi cukup panjang.', alwaysApply: false, enabled: true,
  }, principal), /Tambahkan kata pemicu/);
  await service.remove(created.id);
  assert.equal((await service.list()).items.length, 0);

  const universal = await service.create({
    name: 'Panduan umum Admin', description: 'Uji selalu aktif', triggerKeywords: [], roles: ['admin'],
    instructions: 'Panduan umum untuk pertanyaan admin.', alwaysApply: true, enabled: true,
  }, principal);
  assert.equal((await service.match('Pertanyaan tanpa kata pemicu', 'admin'))[0].id, universal.id);
  assert.deepEqual(await service.match('Pertanyaan tanpa kata pemicu', 'pusat'), []);
  console.log('PASS Agent skill feature: create/list, keyword normalization and match, role filter, prompt injection, update/version, disable, validation, delete, and alwaysApply. In-memory only; no database or model calls.');
})().catch(error => { console.error(error); process.exitCode = 1; });
