import 'dotenv/config';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { GitHubClient, GitHubReadError } from '../src/github/client.js';
import { normalizeAllowedRepos, parseGitHubUrl } from '../src/github/parse-url.js';
import { OpenAIAgent } from '../src/agent/intents.js';

const help = `Select only the live checks you intend to run:
  npm run smoke -- --database
  npm run smoke -- --github-url https://github.com/OWNER/REPO/pull/NUMBER
  npm run smoke -- --openai
Flags can be combined. No flags means no network calls. --openai makes one paid model call with SDK retries disabled. This script never sends iMessages.`;

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`MISSING_${name}`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    database: { type: 'boolean' }, openai: { type: 'boolean' },
    'github-url': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || (!values.database && !values.openai && !values['github-url'])) {
    console.log(help); return;
  }
  if (values.database) {
    const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 1,
      connectionTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 12_000, idleTimeoutMillis: 1_000 });
    try {
      await pool.query('SELECT 1 AS connected');
      console.log('PASS database: real PostgreSQL connection and read-only SELECT. Schema/lifecycle verification remains separate.');
    } finally { await pool.end(); }
  }
  if (values['github-url']) {
    const token = required('GITHUB_TOKEN');
    const allowed = normalizeAllowedRepos(required('GITHUB_ALLOWED_REPOS').split(',').map(value => value.trim()));
    const ref = parseGitHubUrl(values['github-url'], allowed);
    const evidence = await new GitHubClient(token, allowed).inspect(ref);
    console.log(JSON.stringify({
      check: 'github', result: 'PASS', artifact: ref.artifact_url,
      state: evidence.state, mergedAt: evidence.mergedAt, closedAt: evidence.closedAt,
      checksObserved: evidence.checks.length, limitations: evidence.limitations,
    }));
  }
  if (values.openai) {
    const agent = new OpenAIAgent(required('OPENAI_API_KEY'), required('OPENAI_MODEL'));
    // Exactly one generate call; there is no implicit parse or follow-up call.
    const result = await agent.generate('connectivity_diagnostic', {
      diagnostic: true,
      facts: 'A real OpenAI API diagnostic was requested. No GitHub completion or iMessage delivery was tested by this model call. Return one brief acknowledgement.',
    }, 'mild');
    if (!result.trim()) throw new Error('EMPTY_MODEL_RESPONSE');
    console.log('PASS openai: one real model call returned a nonempty schema-validated message. No iMessage was sent.');
  }
}

// Last-resort bound for this standalone diagnostic, including socket teardown.
const watchdog = setTimeout(() => {
  console.error('FAIL selected live checks exceeded the 120-second diagnostic deadline.');
  process.exit(1);
}, 120_000);
watchdog.unref();
main().catch((error: unknown) => {
  if (error instanceof GitHubReadError) {
    console.error(`FAIL github: ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}.`);
  } else {
    const message = error instanceof Error ? error.message : '';
    const missing = /^MISSING_([A-Z_]+)$/.exec(message)?.[1];
    const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
    const safeStatus = typeof status === 'number' && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    const safeCode = typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? ` [${code}]` : '';
    console.error(missing ? `MISSING ${missing}` : `FAIL selected live check${safeStatus}${safeCode}. Verify the selected URL, configuration, access, and network. Provider error bodies are withheld.`);
  }
  process.exitCode = 1;
}).finally(() => { clearTimeout(watchdog); });
