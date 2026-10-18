import type { ArtifactRef } from '../types.js';

const OWNER = '[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?';
const REPO = '[a-z0-9._-]{1,100}';
const REPOSITORY = new RegExp(`^(${OWNER})/(${REPO})$`, 'i');
const ARTIFACT = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})/(pull|issues)/([1-9][0-9]*)/?$`, 'i');

/** Exact repositories only: no URL prefixes, wildcards, or organisation-wide grants. */
export function normalizeAllowedRepos(allowedRepos: readonly string[]): readonly string[] {
  if (!Array.isArray(allowedRepos) || allowedRepos.length === 0) {
    throw new Error('GITHUB_ALLOWED_REPOS must contain at least one owner/repository.');
  }
  return Object.freeze([...new Set(allowedRepos.map((entry) => {
    if (typeof entry !== 'string' || /\s/.test(entry) || !REPOSITORY.test(entry) || ['.', '..'].includes(entry.split('/')[1]!)) {
      throw new Error('Each GITHUB_ALLOWED_REPOS entry must be an exact owner/repository name.');
    }
    return entry.toLowerCase();
  }))]);
}

/** Parse the raw spelling before URL normalization can erase credentials or dot segments. */
export function parseGitHubUrl(url: string, allowedRepos: readonly string[]): ArtifactRef {
  const allowed = normalizeAllowedRepos(allowedRepos);
  const match = typeof url === 'string' && !/\s/.test(url) ? ARTIFACT.exec(url) : null;
  if (!match) {
    throw new Error('Use a direct HTTPS github.com owner/repository/pull/NUMBER or issues/NUMBER URL without a query or fragment.');
  }
  const owner = match[1]!.toLowerCase();
  const repo = match[2]!.toLowerCase();
  const number = Number(match[4]);
  if (['.', '..'].includes(repo) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('The GitHub artifact URL has an invalid repository or artifact number.');
  }
  if (!allowed.includes(`${owner}/${repo}`)) {
    throw new Error(`Repository ${owner}/${repo} is not in GITHUB_ALLOWED_REPOS.`);
  }
  const type = match[3]!.toLowerCase() === 'pull' ? 'pull_request' : 'issue';
  return {
    repo_owner: owner,
    repo_name: repo,
    artifact_type: type,
    artifact_number: number,
    artifact_url: `https://github.com/${owner}/${repo}/${type === 'pull_request' ? 'pull' : 'issues'}/${number}`,
  };
}
