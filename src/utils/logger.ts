import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['*.token','*.secret','*.apiKey','*.password','*.authorization','*.text','*.content','*.connectionString','*.handle','*.senderHandle'], censor: '[REDACTED]' },
});
