import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubReadError } from '../src/github/client.js';
import { parseGitHubUrl } from '../src/github/parse-url.js';

const ALLOWED = ['Acme/Deadline-Demon'];
const SHA = 'a'.repeat(40);
const PR = 'https://github.com/acme/deadline-demon/pull/12';
const ref = () => parseGitHubUrl(PR, ALLOWED);

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 12, title: 'Ship the feature', state: 'open', merged_at: null, closed_at: null,
    head: { sha: SHA }, mergeable: null, draft: false, ...overrides,
  };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
function mockedFetch(handler: Handler) {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    return handler(url, init);
  });
}

function defaultHandler(url: URL): Response {
  if (url.pathname.endsWith('/pulls/12')) return json(pull());
  if (url.pathname.endsWith('/check-runs')) return json({ total_count: 0, check_runs: [] });
  if (url.pathname.endsWith('/status')) return json({ state: 'pending', sha: SHA, total_count: 0, statuses: [] });
  if (url.pathname.endsWith('/files') || url.pathname.endsWith('/reviews')) return json([]);
  throw new Error(`Unexpected mocked route ${url.pathname}`);
}

describe('parseGitHubUrl', () => {
  it('canonicalizes exact allowlisted pull requests and issues', () => {
    expect(parseGitHubUrl('https://GITHUB.COM/Acme/Deadline-Demon/pull/12/', ALLOWED)).toEqual(ref());
    expect(parseGitHubUrl('https://github.com/ACME/DEADLINE-DEMON/issues/1', ALLOWED)).toMatchObject({
      repo_owner: 'acme', repo_name: 'deadline-demon', artifact_type: 'issue', artifact_number: 1,
    });
  });

  it.each([
    'http://github.com/acme/deadline-demon/pull/12',
    'https://github.com.evil.example/acme/deadline-demon/pull/12',
    'https://github.com@evil.example/acme/deadline-demon/pull/12',
    'https://user:password@github.com/acme/deadline-demon/pull/12',
    'https://github.com:443/acme/deadline-demon/pull/12',
    'https://github.com/acme/deadline-demon/pull/12?url=https://evil.example',
    'https://github.com/acme/deadline-demon/pull/12#issuecomment-1',
    'https://github.com/acme/other/../deadline-demon/pull/12',
    'https://github.com/acme/%64eadline-demon/pull/12',
    'https://github.com/acme/deadline-demon/pull/0',
    'https://github.com/acme/deadline-demon/pull/-1',
    'https://github.com/acme/deadline-demon/pull/1.5',
    'https://github.com/acme/deadline-demon/pull/01',
    'https://github.com/acme/deadline-demon/pull/9007199254740992',
    'https://github.com/acme/deadline-demon/pull/12/files',
    ' https://github.com/acme/deadline-demon/pull/12',
    'https://github.com/acme/deadline-demon/pull/12\n',
    'https://github.com/acme/deadline-demon/pulls/12',
    'https://github.com/acme/deadline-demon\\pull\\12',
    'https://github.com/unlisted/repository/pull/12',
  ])('rejects ambiguous or unauthorized URL %s', (url) => {
    expect(() => parseGitHubUrl(url, ALLOWED)).toThrow();
  });

  it('rejects empty and wildcard allowlists', () => {
    expect(() => parseGitHubUrl(PR, [])).toThrow('at least one');
    expect(() => parseGitHubUrl(PR, ['acme/*'])).toThrow('exact owner/repository');
  });
});

describe('GitHubClient observations', () => {
  it('authenticates live REST requests, pins the API version, and reports unknown absent CI', async () => {
    const fetch = mockedFetch((url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('token test-token');
      expect(headers.get('x-github-api-version')).toBe('2026-03-10');
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      return defaultHandler(url);
    });
    const evidence = await new GitHubClient('test-token', ALLOWED, { fetch }).inspect(ref());
    expect(evidence).toMatchObject({ state: 'open', mergedAt: null, headSha: SHA, checks: [], mergeable: null });
    expect(evidence.limitations.join(' ')).toContain('CI success is unknown');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(Number.isFinite(Date.parse(evidence.observedAt))).toBe(true);
  });

  it('does not equate a closed unmerged PR with a merge', async () => {
    const fetch = mockedFetch((url) => url.pathname.endsWith('/pulls/12')
      ? json(pull({ state: 'closed', closed_at: '2026-10-17T00:00:00Z', merged: true })) : defaultHandler(url));
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref());
    expect(evidence.state).toBe('closed');
    expect(evidence.mergedAt).toBeNull();
    expect(evidence.closedAt).toBe('2026-10-17T00:00:00.000Z');
  });

  it('does not infer CI success from an aggregate status with no actual checks', async () => {
    const fetch = mockedFetch((url) => url.pathname.endsWith('/status')
      ? json({ sha: SHA, state: 'success', total_count: 0, statuses: [] }) : defaultHandler(url));
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref());
    expect(evidence.checks).toEqual([]);
    expect(evidence.limitations.join(' ')).toContain('CI success is unknown');
  });

  it('uses merged_at as merge proof and scopes all CI reads to the observed head SHA', async () => {
    const fetch = mockedFetch((url) => {
      if (url.pathname.endsWith('/pulls/12')) return json(pull({ state: 'closed', merged_at: '2026-10-17T02:00:00Z', closed_at: '2026-10-17T02:00:00Z' }));
      expect(url.pathname).toContain(`/commits/${SHA}/`);
      if (url.pathname.endsWith('/check-runs')) return json({ total_count: 2, check_runs: [
        { name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/deadline-demon/actions/runs/2' },
        { name: 'old-build', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success', html_url: null },
      ] });
      return json({ sha: SHA, total_count: 2, statuses: [
        { context: 'deploy', state: 'pending', target_url: 'javascript:alert(1)' },
        { context: 'lint', state: 'failure', target_url: 'https://ci.example/run/1' },
      ] });
    });
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref());
    expect(evidence.mergedAt).toBe('2026-10-17T02:00:00.000Z');
    expect(evidence.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'test', conclusion: 'success' }),
      { name: 'Commit status: deploy', status: 'in_progress', conclusion: null, url: null },
      expect.objectContaining({ name: 'Commit status: lint', conclusion: 'failure' }),
    ]));
    expect(evidence.checks.some((check) => check.name === 'old-build')).toBe(false);
    expect(evidence.limitations.join(' ')).toContain('another head SHA');
  });

  it('reports issue closure as an observation without merge or CI claims', async () => {
    const fetch = mockedFetch(() => json({ number: 3, title: 'Finish documentation', state: 'closed', closed_at: '2026-10-16T12:00:00Z' }));
    const issue = parseGitHubUrl('https://github.com/acme/deadline-demon/issues/3', ALLOWED);
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(issue, true);
    expect(evidence).toMatchObject({ state: 'closed', mergedAt: null, headSha: null, checks: [], closedAt: '2026-10-16T12:00:00.000Z' });
    expect(evidence.limitations.join(' ')).toContain('not proof that code shipped');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an issue URL that actually identifies a pull request', async () => {
    const fetch = mockedFetch(() => json({ number: 12, title: 'A PR', state: 'closed', closed_at: null, pull_request: { url: 'https://api.github.com/repos/acme/deadline-demon/pulls/12' } }));
    const issue = parseGitHubUrl('https://github.com/acme/deadline-demon/issues/12', ALLOWED);
    await expect(new GitHubClient('token', ALLOWED, { fetch }).inspect(issue)).rejects.toMatchObject({ code: 'invalid_reference' });
  });

  it('revalidates stored references and rejects mismatched metadata before any request', async () => {
    const fetch = mockedFetch(defaultHandler);
    const client = new GitHubClient('token', ALLOWED, { fetch });
    await expect(client.inspect({ ...ref(), repo_name: 'private-repo' })).rejects.toMatchObject({ code: 'invalid_reference' });
    await expect(client.inspect({ ...ref(), artifact_url: 'https://github.com/unlisted/repo/pull/12' })).rejects.toMatchObject({ code: 'invalid_reference' });
    await expect(client.inspect({ ...ref(), artifact_type: 'issue' })).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns explicit limitations for optional permission errors', async () => {
    const fetch = mockedFetch((url) => {
      if (url.pathname.endsWith('/check-runs')) return json({ message: 'Resource not accessible by personal access token' }, 403);
      if (url.pathname.endsWith('/reviews')) return json({ message: 'Not Found' }, 404);
      if (url.pathname.endsWith('/files')) return json([{ filename: 'src/index.ts', status: 'modified', additions: 4, deletions: 2 }]);
      return defaultHandler(url);
    });
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref(), true);
    expect(evidence.files).toEqual([{ filename: 'src/index.ts', status: 'modified', additions: 4, deletions: 2 }]);
    expect(evidence.reviews).toEqual([]);
    expect(evidence.limitations.join(' ')).toContain('Check runs unavailable (forbidden, HTTP 403)');
    expect(evidence.limitations.join(' ')).toContain('Reviews unavailable (not_found, HTTP 404)');
    expect(evidence.limitations.join(' ')).toContain('unknown, not a passing result');
  });

  it('includes actual changed files and review history only in detailed reads', async () => {
    const fetch = mockedFetch((url) => {
      if (url.pathname.endsWith('/files')) return json([{ filename: 'README.md', status: 'added', additions: 20, deletions: 0 }]);
      if (url.pathname.endsWith('/reviews')) return json([{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }, { user: null, state: 'COMMENTED' }]);
      return defaultHandler(url);
    });
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref(), true);
    expect(evidence.reviews).toEqual([{ user: 'reviewer', state: 'CHANGES_REQUESTED' }, { user: '[deleted user]', state: 'COMMENTED' }]);
    expect(evidence.files[0]?.filename).toBe('README.md');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('bounds pagination and never follows a supplied next-page host', async () => {
    const fetch = mockedFetch((url) => {
      if (url.pathname.endsWith('/check-runs')) {
        expect(url.searchParams.get('page')).toMatch(/^[123]$/);
        expect(url.searchParams.get('per_page')).toBe('100');
        return json({ total_count: 400, check_runs: [{ name: `page-${url.searchParams.get('page')}`, head_sha: SHA, status: 'completed', conclusion: 'success', html_url: null }] }, 200,
          { link: '<https://evil.example/steal-token>; rel="next"' });
      }
      return defaultHandler(url);
    });
    const evidence = await new GitHubClient('token', ALLOWED, { fetch }).inspect(ref());
    expect(evidence.checks).toHaveLength(3);
    expect(evidence.limitations.join(' ')).toContain('truncated after 300');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([[404, 'not_found'], [401, 'authentication'], [403, 'forbidden'], [503, 'unavailable']])('sanitizes core HTTP %s errors', async (status, code) => {
    const fetch = mockedFetch(() => json({ message: 'sensitive-token-do-not-log' }, Number(status)));
    let caught: unknown;
    try { await new GitHubClient('sensitive-token-do-not-log', ALLOWED, { fetch }).inspect(ref()); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GitHubReadError);
    expect(caught).toMatchObject({ code, status });
    expect(JSON.stringify(caught)).not.toContain('sensitive-token-do-not-log');
    expect(String(caught)).not.toContain('sensitive-token-do-not-log');
  });

  it('honors rate limit reset and blocks immediate subsequent calls', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const fetch = mockedFetch(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    const client = new GitHubClient('token', ALLOWED, { fetch });
    await expect(client.inspect(ref())).rejects.toMatchObject({ code: 'rate_limited', retryAt: new Date(reset * 1000).toISOString() });
    await expect(client.inspect(ref())).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid core response data', async () => {
    const fetch = mockedFetch(() => json(pull({ merged_at: 'not-a-date' })));
    await expect(new GitHubClient('token', ALLOWED, { fetch }).inspect(ref())).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
