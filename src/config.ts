import 'dotenv/config';
import { z } from 'zod';
import { IANAZone } from 'luxon';

const required = z.string().trim().min(1);
const optionalSetting = z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().trim().min(1).optional());
export const ConfigSchema = z.object({
  SPECTRUM_PROJECT_ID: z.string().uuid(), SPECTRUM_PROJECT_SECRET: required,
  ADMIN_IMESSAGE_HANDLE: required, OPENAI_API_KEY: required, OPENAI_MODEL: required,
  GITHUB_TOKEN: optionalSetting,
  GITHUB_ALLOWED_REPOS: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).refine(s => s.split(',').every(r => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(r.trim())), 'Use comma-separated owner/repo entries').optional()),
  DATABASE_URL: z.string().url().refine(s => /^postgres(ql)?:/.test(s)),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata').refine(s => IANAZone.isValidZone(s), 'Use an IANA timezone'),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  GITHUB_POLL_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  SPECTRUM_IMESSAGE_PHONE: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (Boolean(result.data.GITHUB_TOKEN) !== Boolean(result.data.GITHUB_ALLOWED_REPOS)) {
    throw new Error('Configure both GITHUB_TOKEN and GITHUB_ALLOWED_REPOS to enable optional GitHub verification, or leave both blank.');
  }
  return result.data;
}
export function normalizeHandle(handle: string): string {
  const value = handle.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value.toLowerCase();
  if (/^\+[1-9]\d{6,14}$/.test(value)) return value;
  throw new Error('Owner handle must be an E.164 phone number or Apple ID email');
}
