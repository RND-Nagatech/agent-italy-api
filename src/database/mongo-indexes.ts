import { Db } from 'mongodb';
import { UserDocument } from '../users/user.types';

export async function ensureMongoIndexes(db: Db): Promise<void> {
  const users = db.collection<UserDocument>('users');
  const sessions = db.collection('auth_sessions');
  const sources = db.collection('shipment_sources');
  const userSettings = db.collection('user_settings');
  const agentChatSessions = db.collection('agent_chat_sessions');
  const agentChatMessages = db.collection('agent_chat_messages');
  const agentChatAttachments = db.collection('agent_chat_attachments');
  const agentHistoryJobs = db.collection('agent_history_jobs');
  const agentRunTraces = db.collection('agent_run_traces');
  const agentSkills = db.collection('agent_skills');
  const agentGatewayRequestAudits = db.collection('agent_gateway_request_audits');

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' }),
    users.createIndex({ role: 1, active: 1 }, { name: 'users_role_active' }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true, name: 'sessions_token_hash_unique' }),
    sessions.createIndex({ userId: 1, revokedAt: 1 }, { name: 'sessions_user_revoked' }),
    sessions.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'sessions_ttl' }),
    sources.createIndex({ databaseName: 1 }, { unique: true, name: 'shipment_sources_database_unique' }),
    sources.createIndex({ branchId: 1 }, { unique: true, name: 'shipment_sources_branch_unique' }),
    sources.createIndex(
      { sourceType: 1 },
      { unique: true, partialFilterExpression: { sourceType: 'central' }, name: 'shipment_sources_single_central_unique' },
    ),
    userSettings.createIndex({ userId: 1 }, { unique: true, name: 'user_settings_user_unique' }),
    agentChatSessions.createIndex({ ownerId: 1, updatedAt: -1 }, { name: 'agent_chat_sessions_owner_updated' }),
    agentChatMessages.createIndex({ sessionId: 1, sequence: 1 }, { name: 'agent_chat_messages_session_sequence' }),
    agentChatMessages.createIndex({ ownerId: 1, content: 'text' }, { name: 'agent_chat_messages_owner_text' }),
    agentChatMessages.createIndex({ role: 1, historyIndexStatus: 1, _id: 1 }, { name: 'agent_chat_messages_history_backfill' }),
    agentChatMessages.createIndex(
      { sessionId: 1, requestId: 1, role: 1 },
      { unique: true, partialFilterExpression: { requestId: { $type: 'string' } }, name: 'agent_chat_messages_request_role_unique' },
    ),
    agentChatAttachments.createIndex({ sessionId: 1, ownerId: 1, messageId: 1 }, { name: 'agent_chat_attachments_room_owner_message' }),
    db.collection('agent_price_references').createIndex({ sessionId: 1, ownerId: 1, id: 1 }, { unique: true, name: 'agent_price_references_room_owner_id' }),
    db.collection('agent_price_extractions').createIndex({ sessionId: 1, ownerId: 1 }, { name: 'agent_price_extractions_room_owner' }),
    db.collection('agent_price_read_jobs').createIndex({ sessionId: 1, ownerId: 1, attachmentId: 1, parserVersion: 1 }, { unique: true, name: 'agent_price_read_identity' }),
    db.collection('agent_price_read_jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'agent_price_read_expiry' }),
    agentRunTraces.createIndex({ ownerId: 1, requestId: 1 }, { unique: true, name: 'agent_run_traces_owner_request_unique' }),
    agentHistoryJobs.createIndex({ dedupeKey: 1 }, { unique: true, name: 'agent_history_jobs_dedupe_unique' }),
    agentHistoryJobs.createIndex({ kind: 1, status: 1, availableAt: 1, leaseUntil: 1 }, { name: 'agent_history_jobs_queue' }),
    agentRunTraces.createIndex({ startedAt: -1, status: 1 }, { name: 'agent_run_traces_started_status' }),
    agentRunTraces.createIndex({ 'feedback.rating': 1, startedAt: -1 }, { name: 'agent_run_traces_feedback_started' }),
    agentSkills.createIndex({ enabled: 1, roles: 1, updatedAt: -1 }, { name: 'agent_skills_role_enabled_updated' }),
    // Do not add a standalone {_id: -1} index: MongoDB requires the built-in {_id: 1} index,
    // which already supports descending _id sorts by traversing it backwards.
    agentGatewayRequestAudits.createIndex({ exchangeRequestId: 1, _id: -1 }, { name: 'agent_gateway_audit_exchange_request' }),
    agentGatewayRequestAudits.createIndex({ sessionId: 1, _id: -1 }, { name: 'agent_gateway_audit_session' }),
    agentGatewayRequestAudits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'agent_gateway_audit_ttl' }),
  ]);
}
