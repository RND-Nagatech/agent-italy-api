// Isolated upload requests with database/stream fixtures; no external connections.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://upload-check:fixture-password@127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'upload_check';
process.env.JWT_ACCESS_SECRET = 'offline-upload-check-secret-32-characters';
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { ObjectId } = require('mongodb');
const { Controller, Module, Post, Get, Req, UseGuards } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const multipart = require('@fastify/multipart');
const { AgentController } = require('../dist/src/agent/agent.controller');
const { AgentSessionsService } = require('../dist/src/agent/agent-sessions.service');
const { registerAttachmentUploadLogging } = require('../dist/src/agent/attachment-upload.logger');
const documentParser = require('../dist/src/knowledge/document-parser');

const logs = [];
const capture = level => message => {
  if (typeof message === 'string' && message.startsWith('{')) logs.push({ level, ...JSON.parse(message) });
};
const logSink = { log: capture('log'), error: capture('error'), warn: capture('warn'), debug() {}, verbose() {}, fatal: capture('fatal') };
const sessionId = new ObjectId().toHexString();
const ownerId = new ObjectId().toHexString();
const filename = 'private-bank-statement.png';
const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('private-file-content')]);
let mode = 'success', aborted = 0, deleted = 0;
const databaseError = () => Object.assign(new Error(
  `not authorized to execute operation ${process.env.MONGODB_URI} Bearer fixture-access-token ${filename}; full command is { documents: [private-file-content] }`,
), { name: 'MongoServerError', code: 13, codeName: 'Unauthorized', secretDocument: 'private-file-content' });
const service = new AgentSessionsService({ db: { collection: name => {
  if (name === 'agent_chat_sessions') return { findOne: async () => {
    if (mode === 'session_error') throw databaseError();
    return { _id: new ObjectId(sessionId), ownerId };
  } };
  if (name === 'agent_chat_attachments') return {
    countDocuments: async () => {
      if (mode === 'pending_error') throw databaseError();
      return 0;
    },
    insertOne: async () => {
      if (mode === 'metadata_error' || mode === 'cleanup_error') throw databaseError();
      return {};
    },
  };
  throw new Error('Unexpected collection in isolated check');
} } });
Object.defineProperty(service, 'bucket', { get: () => ({
  openUploadStream: () => {
    if (mode === 'gridfs_open_error') throw databaseError();
    const stream = new Writable({ write(_chunk, _encoding, callback) {
      callback(mode === 'gridfs_error' ? databaseError() : null);
    } });
    stream.id = new ObjectId();
    stream.abort = async () => { aborted++; };
    return stream;
  },
  delete: async () => {
    deleted++;
    if (mode === 'cleanup_error') throw Object.assign(new Error('Storage cleanup unavailable'), { code: 'ECONNRESET' });
  },
}) });

class UploadCheckController {
  async upload(request) {
    return AgentController.prototype.uploadAttachment.call({ sessions: service }, request.params.sessionId, request, { sub: ownerId });
  }
  probe() { return { ok: true }; }
}
Controller('agent')(UploadCheckController);
Post('sessions/:sessionId/attachments')(UploadCheckController.prototype, 'upload', Object.getOwnPropertyDescriptor(UploadCheckController.prototype, 'upload'));
Req()(UploadCheckController.prototype, 'upload', 0);
UseGuards({ canActivate: () => mode !== 'forbidden' })(UploadCheckController);
Get('probe')(UploadCheckController.prototype, 'probe', Object.getOwnPropertyDescriptor(UploadCheckController.prototype, 'probe'));
class UploadCheckModule {}
Module({ controllers: [UploadCheckController] })(UploadCheckModule);

function multipartPayload(file = image, name = filename) {
  return Buffer.concat([
    Buffer.from(`--upload-check\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file, Buffer.from('\r\n--upload-check--\r\n'),
  ]);
}

(async () => {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(UploadCheckModule, adapter, { logger: logSink });
  const fastify = adapter.getInstance();
  registerAttachmentUploadLogging(fastify);
  await fastify.register(multipart, { limits: { files: 1, fields: 1, parts: 2 } });
  app.setGlobalPrefix('api/v1');
  await app.init();
  await fastify.ready();
  const upload = async (selectedMode, payload = multipartPayload(), contentType = 'multipart/form-data; boundary=upload-check') => {
    logs.length = 0;
    mode = selectedMode;
    const response = await fastify.inject({
      method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/attachments`,
      headers: { 'content-type': contentType }, payload,
    });
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert(logs.length >= 2);
    assert(logs.every(log => log.requestId === response.headers['x-request-id']));
    assert.equal(logs[0].event, 'upload_received');
    assert.equal(logs.at(-1).event, 'upload_response');
    assert.equal(logs.at(-1).statusCode, response.statusCode);
    return response;
  };
  const failure = (stage, code) => {
    const failures = logs.filter(log => log.event === 'upload_failed');
    assert.equal(failures.length, 1, 'one diagnostic per failure, without duplicate controller/service errors');
    assert.equal(failures[0].stage, stage);
    if (code) {
      assert.equal(failures[0].level, 'error');
      assert.equal((failures[0].error.cause ?? failures[0].error).code, code);
    }
  };
  try {
    const success = await upload('success');
    assert.equal(success.statusCode, 201);
    assert.equal(success.json().filename, filename);
    assert(logs.some(log => log.event === 'upload_saved' && log.sizeBytes === image.length));

    const invalid = await upload('success', multipartPayload(Buffer.from('invalid')));
    assert.equal(invalid.statusCode, 400);
    failure('validate_file');

    const malformed = await upload('success', Buffer.from('invalid multipart'), 'multipart/form-data');
    assert.equal(malformed.statusCode, 400);
    failure('multipart');
    assert(logs.find(log => log.event === 'upload_failed').error.cause);

    const readError = Object.assign(new Error('File too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    logs.length = 0;
    await assert.rejects(AgentController.prototype.uploadAttachment.call({ sessions: service }, sessionId, {
      file: async () => ({ fieldname: 'file', filename, toBuffer: async () => { throw readError; } }),
    }, { sub: ownerId }), error => error.getStatus() === 400);
    failure('read_file', 'FST_REQ_FILE_TOO_LARGE');

    const originalExtract = documentParser.extractDocument;
    documentParser.extractDocument = async () => { throw Object.assign(new Error('PDF worker unavailable'), { code: 'MODULE_NOT_FOUND' }); };
    try {
      const pdf = await upload('success', multipartPayload(Buffer.from('%PDF-fixture'), 'private-bank-statement.pdf'));
      assert.equal(pdf.statusCode, 400);
      failure('parse_pdf', 'MODULE_NOT_FOUND');
    } finally { documentParser.extractDocument = originalExtract; }

    for (const [selectedMode, stage] of [
      ['session_error', 'session_access'], ['pending_error', 'pending_attachments'],
      ['gridfs_open_error', 'gridfs_upload'], ['metadata_error', 'save_metadata'],
    ]) {
      const response = await upload(selectedMode);
      assert.equal(response.statusCode, 500);
      assert(!/Unauthorized|MongoServerError|stack|fixture-password/.test(response.body));
      failure(stage, '13');
      const serialized = JSON.stringify(logs);
      for (const hidden of [process.env.MONGODB_URI, 'fixture-password', 'fixture-access-token', filename, ownerId, sessionId, 'private-file-content']) {
        assert(!serialized.includes(hidden), `sensitive value must not appear in logs: ${hidden === filename ? 'filename' : 'redacted fixture'}`);
      }
      assert.equal(logs.find(log => log.event === 'upload_failed').error.codeName, 'Unauthorized');
    }
    assert.equal(deleted, 1, 'failed metadata insert cleans up the stored file');

    const gridfs = await upload('gridfs_error');
    assert.equal(gridfs.statusCode, 400);
    failure('gridfs_upload', '13');
    assert.equal(logs.find(log => log.event === 'upload_failed').statusCode, 400);
    assert.equal(aborted, 1);

    const cleanup = await upload('cleanup_error');
    assert.equal(cleanup.statusCode, 500);
    failure('save_metadata', '13');
    assert(logs.some(log => log.event === 'upload_cleanup_failed' && log.error.code === 'ECONNRESET'));

    const forbidden = await upload('forbidden');
    assert.equal(forbidden.statusCode, 403);
    assert.equal(logs.at(-1).stage, 'request', 'guard failures are logged before entering the controller');

    logs.length = 0;
    mode = 'success';
    await fastify.inject({ method: 'GET', url: '/api/v1/agent/probe' });
    assert.equal(logs.length, 0, 'other endpoints do not produce upload logs');
    console.log('Agent upload logging checks passed: lifecycle, multipart, file read, PDF, MongoDB, GridFS, cleanup, guards, correlation, and redaction.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
