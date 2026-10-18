import 'dotenv/config';
import { ConfigSchema, normalizeHandle } from '../src/config.js';
import { normalizeAllowedRepos } from '../src/github/parse-url.js';

// Configuration inspection only: no API, database, or messaging connections.
const missing = new Set<string>();
const invalid = new Set<string>();
for (const [name, schema] of Object.entries(ConfigSchema.shape)) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    if (schema.safeParse(undefined).success) console.log(`${['GITHUB_TOKEN','GITHUB_ALLOWED_REPOS'].includes(name) ? 'OPTIONAL' : 'DEFAULT'} ${name}`);
    else { missing.add(name); console.log(`MISSING ${name}`); }
  } else if (schema.safeParse(value).success) console.log(`CONFIGURED ${name}`);
  else { invalid.add(name); console.log(`INVALID ${name}`); }
}
const hasGithubToken = Boolean(process.env.GITHUB_TOKEN?.trim());
const hasGithubRepos = Boolean(process.env.GITHUB_ALLOWED_REPOS?.trim());
if (hasGithubToken !== hasGithubRepos) {
  const incomplete = hasGithubToken ? 'GITHUB_ALLOWED_REPOS' : 'GITHUB_TOKEN';
  invalid.add(incomplete);
  console.error(`INVALID ${incomplete}: configure both GitHub settings or leave both blank`);
}
if (process.env.ADMIN_IMESSAGE_HANDLE) {
  try { normalizeHandle(process.env.ADMIN_IMESSAGE_HANDLE); }
  catch { invalid.add('ADMIN_IMESSAGE_HANDLE'); }
}
if (process.env.GITHUB_ALLOWED_REPOS) {
  try { normalizeAllowedRepos(process.env.GITHUB_ALLOWED_REPOS.split(',').map(value => value.trim())); }
  catch { invalid.add('GITHUB_ALLOWED_REPOS'); }
}
for (const name of invalid) console.error(`INVALID ${name}`);
if (missing.size || invalid.size) process.exitCode = 1;
