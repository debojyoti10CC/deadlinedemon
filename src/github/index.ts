export { GitHubClient, GitHubReadError } from './client.js';
export type { GitHubReadErrorCode } from './client.js';
export { parseGitHubUrl } from './parse-url.js';
import { GitHubClient, GitHubReadError } from './client.js';
import type { ArtifactRef, Evidence, GitHubReader } from '../types.js';

/** Ordinary task tracking can run without GitHub credentials. */
export function createGitHubReader(token?: string, allowedRepos?: readonly string[]): GitHubReader {
  if (!token && !allowedRepos?.length) {
    return {
      async inspect(_ref: ArtifactRef): Promise<Evidence> {
        throw new GitHubReadError('authentication', 'GitHub verification is not configured. Ordinary task tracking is available without it.');
      },
    };
  }
  if (!token || !allowedRepos?.length) throw new Error('Configure both GITHUB_TOKEN and GITHUB_ALLOWED_REPOS, or leave both blank.');
  return new GitHubClient(token, allowedRepos);
}
