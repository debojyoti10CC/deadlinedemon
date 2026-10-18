import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { createGitHubReader } from '../src/github/index.js';
import type { ArtifactRef } from '../src/types.js';

const base: NodeJS.ProcessEnv = {
  SPECTRUM_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
  SPECTRUM_PROJECT_SECRET: 'local-test-secret',
  ADMIN_IMESSAGE_HANDLE: '+15551234567',
  OPENAI_API_KEY: 'local-test-key',
  OPENAI_MODEL: 'test-model',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/deadline_demon',
};

describe('optional GitHub setup', () => {
  it('starts ordinary task mode without GitHub credentials', () => {
    expect(readConfig({ ...base, GITHUB_TOKEN: '', GITHUB_ALLOWED_REPOS: '' })).toMatchObject({
      GITHUB_TOKEN: undefined, GITHUB_ALLOWED_REPOS: undefined,
    });
    expect(readConfig(base).GITHUB_TOKEN).toBeUndefined();
  });

  it('requires token and repository allowlist together', () => {
    expect(() => readConfig({ ...base, GITHUB_TOKEN: 'token' })).toThrow('Configure both GITHUB_TOKEN and GITHUB_ALLOWED_REPOS');
    expect(() => readConfig({ ...base, GITHUB_ALLOWED_REPOS: 'owner/repo' })).toThrow('Configure both GITHUB_TOKEN and GITHUB_ALLOWED_REPOS');
    expect(readConfig({ ...base, GITHUB_TOKEN: 'token', GITHUB_ALLOWED_REPOS: 'owner/repo' }).GITHUB_ALLOWED_REPOS).toBe('owner/repo');
  });

  it('fails explicitly if a GitHub-only action is requested without setup', async () => {
    const reader = createGitHubReader();
    const ref: ArtifactRef = {
      repo_owner: 'owner', repo_name: 'repo', artifact_type: 'pull_request', artifact_number: 1,
      artifact_url: 'https://github.com/owner/repo/pull/1',
    };
    await expect(reader.inspect(ref)).rejects.toThrow('Ordinary task tracking is available without it');
  });
});
