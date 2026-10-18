import type { Intensity } from '../types.js';

export const PERSONALITY: Record<Intensity, string> = {
  mild: 'Use a supportive, calm, professional tone. Treat obstacles as solvable and name one manageable next step. Keep the response concise and clearly structured. Do not use emojis, jokes, sarcasm, or roleplay.',
  savage: 'Use a direct, professional tone. State the documented status clearly and identify the next concrete action. Keep the response concise and clearly structured. Do not use emojis, jokes, sarcasm, insults, or roleplay.',
  nuclear: 'Use a firm, urgent, professional tone. Ground urgency in the actual deadline and documented status, then state the immediate next action. Keep the response concise and clearly structured. Do not use emojis, jokes, sarcasm, roleplay, threats, or intimidation.',
};

const PRIVATE_KEY = /(?:token|secret|password|authorization|api[_-]?key|database[_-]?url|imessage[_-]?handle|phone|email)/i;

/** Limit model context and avoid forwarding credential/contact properties. */
export function boundedContext(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[context depth limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => boundedContext(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key)).slice(0, 50)
      .map(([key, item]) => [key, boundedContext(item, depth + 1)]));
  }
  return null;
}
