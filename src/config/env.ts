import 'dotenv/config';
import { z } from 'zod';
import { decodeRdsSettings } from './rds-options';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  MONGODB_URI: z.string().min(1),
  SYSTEM_DATABASE_NAME: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
  SHIPMENT_SOURCE_DATABASE_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,63}$/)
    .default('db_pntspst2'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(5).max(500).default(50),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(900).default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default(''),
  DEEPSEEK_API_KEY: z.string().trim().default(''),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_INTEGRATION_API_KEY: z.string().trim().default(''),
  DEEPSEEK_GATEWAY_URL: z.string().url().optional(),
  TOPUP_PAYMENT_METHODS: z.string().default('qris,va').transform(value => [...new Set(value.split(',').map(method => method.trim().toLowerCase()).filter(Boolean))]).pipe(z.array(z.enum(['qris', 'va']))),
  DEEPSEEK_MODEL: z.string().trim().min(1).default('deepseek-flash'),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(20_000).default(20_000),
  AGENT_GATEWAY_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  KNOWLEDGE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  KNOWLEDGE_MAX_FILE_MB: z.coerce.number().int().min(1).max(50).default(20),
  QDRANT_URL: z.string().url().default('http://127.0.0.1:6333'),
  QDRANT_COLLECTION: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('italy_knowledge_e5_v1'),
  AGENT_HISTORY_QDRANT_COLLECTION: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('italy_agent_history_e5_v1'),
  EMBEDDING_MODEL: z.string().default('Xenova/multilingual-e5-small'),
  EMBEDDING_REVISION: z.string().default('main'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4096).default(384),
  EMBEDDING_CACHE_DIR: z.string().default('.cache/embeddings'),
  HINDSIGHT_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  HINDSIGHT_BASE_URL: z.string().url().default('http://127.0.0.1:8888'),
  HINDSIGHT_API_KEY: z.string().trim().default(''),
  HINDSIGHT_AUTO_LEARN: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  HINDSIGHT_LEARN_HISTORY: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  HINDSIGHT_BANK_ID: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('italy-shared-v1'),
  ENC_KEY_DEC: z.string().trim().default(''),
  RDS_URLDB_API: z.string().trim().max(4096).regex(/^(?:[a-fA-F0-9]{2})*$/).default(''),
  RDS_DB_NAME: z.string().trim().max(512).regex(/^(?:[a-fA-F0-9]{2})*$/).default(''),
  RDS_USERNAME: z.string().trim().max(512).regex(/^(?:[a-fA-F0-9]{2})*$/).default(''),
  RDS_PASSWORD: z.string().trim().max(8192).regex(/^(?:[a-fA-F0-9]{2})*$/).default(''),
}).superRefine((values, context) => {
  const keys = ['RDS_URLDB_API', 'RDS_DB_NAME', 'RDS_USERNAME', 'RDS_PASSWORD'] as const;
  if (!keys.some(key => values[key] !== '')) return;
  for (const key of keys) if (values[key] === '') context.addIssue({ code: 'custom', path: [key], message: 'Complete all four RDS settings' });
  if (!values.ENC_KEY_DEC) context.addIssue({ code: 'custom', path: ['ENC_KEY_DEC'], message: 'Required to decrypt RDS settings' });
  if (keys.every(key => values[key] !== '') && values.ENC_KEY_DEC) {
    try { decodeRdsSettings({ url: values.RDS_URLDB_API, database: values.RDS_DB_NAME, username: values.RDS_USERNAME, password: values.RDS_PASSWORD }, values.ENC_KEY_DEC); }
    catch { context.addIssue({ code: 'custom', path: ['RDS_URLDB_API'], message: 'Check encrypted RDS settings and key' }); }
  }
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const invalidKeys = parsedEnvironment.error.issues
    .map((issue) => issue.path.join('.'))
    .filter((key, index, all) => all.indexOf(key) === index);
  throw new Error(`Invalid environment configuration. Check: ${invalidKeys.join(', ')}`);
}

const values = parsedEnvironment.data;

export const env = {
  nodeEnv: values.NODE_ENV,
  isProduction: values.NODE_ENV === 'production',
  port: values.PORT,
  mongoUri: values.MONGODB_URI,
  systemDatabaseName: values.SYSTEM_DATABASE_NAME,
  shipmentSourceDatabaseName: values.SHIPMENT_SOURCE_DATABASE_NAME,
  mongoMaxPoolSize: values.MONGODB_MAX_POOL_SIZE,
  jwtAccessSecret: values.JWT_ACCESS_SECRET,
  accessTokenTtlSeconds: values.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: values.REFRESH_TOKEN_TTL_DAYS,
  corsOrigins: values.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  trustProxy: values.TRUST_PROXY.split(',').map((proxy) => proxy.trim()).filter(Boolean),
  deepSeekApiKey: values.DEEPSEEK_API_KEY,
  deepSeekBaseUrl: values.DEEPSEEK_BASE_URL.replace(/\/+$/, ''),
  deepSeekIntegrationApiKey: values.DEEPSEEK_INTEGRATION_API_KEY,
  deepSeekGatewayUrl: values.DEEPSEEK_GATEWAY_URL,
  topupPaymentMethods: values.TOPUP_PAYMENT_METHODS,
  deepSeekModel: values.DEEPSEEK_MODEL,
  agentMaxOutputTokens: values.AGENT_MAX_OUTPUT_TOKENS,
  agentGatewayAuditRetentionDays: values.AGENT_GATEWAY_AUDIT_RETENTION_DAYS,
  encKeyDec: values.ENC_KEY_DEC,
  rds: decodeRdsSettings({ url: values.RDS_URLDB_API, database: values.RDS_DB_NAME, username: values.RDS_USERNAME, password: values.RDS_PASSWORD }, values.ENC_KEY_DEC),
  knowledgeEnabled: values.KNOWLEDGE_ENABLED,
  knowledgeMaxFileMb: values.KNOWLEDGE_MAX_FILE_MB,
  qdrantUrl: values.QDRANT_URL.replace(/\/+$/, ''),
  qdrantCollection: values.QDRANT_COLLECTION,
  agentHistoryQdrantCollection: values.AGENT_HISTORY_QDRANT_COLLECTION,
  embeddingModel: values.EMBEDDING_MODEL,
  embeddingRevision: values.EMBEDDING_REVISION,
  embeddingDimensions: values.EMBEDDING_DIMENSIONS,
  embeddingCacheDir: values.EMBEDDING_CACHE_DIR,
  hindsightEnabled: values.HINDSIGHT_ENABLED,
  hindsightBaseUrl: values.HINDSIGHT_BASE_URL.replace(/\/+$/, ''),
  hindsightApiKey: values.HINDSIGHT_API_KEY,
  hindsightBankId: values.HINDSIGHT_BANK_ID,
  hindsightAutoLearn: values.HINDSIGHT_AUTO_LEARN,
  hindsightLearnHistory: values.HINDSIGHT_LEARN_HISTORY,
};
