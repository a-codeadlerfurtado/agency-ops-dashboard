import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  IMOBI_APP_PASSWORD: z.string().min(16).optional(),
  REDIS_URL: z.string().min(1),
  MINIO_ENDPOINT: z.string().default('imobia-minio'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().default(''),
  MINIO_SECRET_KEY: z.string().default(''),
  MINIO_BUCKET: z.string().default('imobia-media'),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_BROKER_URL: z.string().url().optional(),
  META_BROKER_TOKEN: z.string().min(32).optional(),
  META_VERIFY_TOKEN: z.string().default('configure-imobia-webhook-token'),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().default(''),
  META_EMBEDDED_SIGNUP_EXTRAS_JSON: z.string().default('{}'),
  APP_ENCRYPTION_KEY_B64: z.string().min(40),
  INTERNAL_AGENT_TOKEN: z.string().min(32),
  N8N_AGENT_WEBHOOK: z.string().url().optional(),
  N8N_FOLLOWUP_WEBHOOK: z.string().url().optional()
});

export const env = schema.parse(process.env);
export const META_BASE = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
export const metaConfigured = Boolean(
  env.META_VERIFY_TOKEN &&
  (env.META_APP_SECRET || (env.META_BROKER_URL && env.META_BROKER_TOKEN))
);
export const embeddedSignupConfigured = Boolean(
  metaConfigured && env.META_APP_ID && env.META_EMBEDDED_SIGNUP_CONFIG_ID
);
