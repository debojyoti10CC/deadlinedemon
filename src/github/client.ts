import { Octokit } from '@octokit/rest';
import type { ArtifactRef, Evidence, GitHubReader } from '../types.js';
import { normalizeAllowedRepos, parseGitHubUrl } from './parse-url.js';

export type GitHubReadErrorCode = 'invalid_reference' | 'invalid_response' | 'not_found' |
  'authentication' | 'forbidden' | 'rate_limited' | 'unavailable';

/** Intentionally carries no raw API error, request headers, or token-bearing cause. */
export class GitHubReadError extends Error {
  constructor(
    public readonly code: GitHubReadErrorCode,
    message: string,
    public readonly status: number | null = null,
    public readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = 'GitHubReadError';
  }
}

interface ClientOptions { fetch?: typeof globalThis.fetch }
type Pull = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];
type Issue = Awaited<ReturnType<Octokit['rest']['issues']['get']>>['data'];
type Check = Awaited<ReturnType<Octokit['rest']['checks']['listForRef']>>['data']['check_runs'][number];
type Status = Awaited<ReturnType<Octokit['rest']['repos']['getCombinedStatusForRef']>>['data']['statuses'][number];
type Review = Awaited<ReturnType<Octokit['rest']['pulls']['listReviews']>>['data'][number];
type File = Awaited<ReturnType<Octokit['rest']['pulls']['listFiles']>>['data'][number];

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const OBSERVATION_TIMEOUT_MS = 25_000;

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new GitHubReadError('invalid_response', 'GitHub returned an invalid observation timestamp. Verification remains unknown.');
  }
  return new Date(value).toISOString();
}

function safeLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function hasNextPage(headers: { link?: string }): boolean {
  // Never follow server-supplied URLs: the caller increments its own bounded page number.
  return /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(headers.link ?? '');
}

export class GitHubClient implements GitHubReader {
  private readonly octokit: Octokit;
  private readonly allowedRepos: readonly string[];
  private blockedUntil = 0;

  constructor(token: string, allowedRepos: readonly string[], options: ClientOptions = {}) {
    if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_TOKEN is required.');
    this.allowedRepos = normalizeAllowedRepos(allowedRepos);
    this.octokit = new Octokit({
      auth: token.trim(),
      baseUrl: 'https://api.github.com',
      userAgent: 'deadline-demon/1.0',
      request: { ...(options.fetch ? { fetch: options.fetch } : {}), redirect: 'error' },
      // API errors are surfaced through sanitized errors below, without logging request objects.
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    this.octokit.hook.before('request', (request) => {
      if (request.method !== 'GET') throw new GitHubReadError('invalid_reference', 'Only read-only GitHub requests are permitted.');
      request.headers.accept = 'application/vnd.github+json';
      request.headers['x-github-api-version'] = '2026-03-10';
    });
  }

  async inspect(ref: ArtifactRef, detailed = false): Promise<Evidence> {
    const artifact = this.validateReference(ref);
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);
    const evidence: Evidence = {
      artifact, observedAt: new Date().toISOString(), title: '', state: 'unknown',
      mergedAt: null, closedAt: null, headSha: null, mergeable: null, draft: null,
      checks: [], reviews: [], files: [], limitations: [],
    };
    if (artifact.artifact_type === 'issue') {
      const { data } = await this.read(() => this.octokit.rest.issues.get({
        owner: artifact.repo_owner, repo: artifact.repo_name, issue_number: artifact.artifact_number,
        request: this.requestOptions(signal),
      }));
      this.validateObservation(data, artifact);
      if (data.pull_request) {
        throw new GitHubReadError('invalid_reference', 'GitHub identifies this artifact as a pull request. Use its /pull/ URL.');
      }
      evidence.title = data.title;
      evidence.state = data.state;
      evidence.closedAt = timestamp(data.closed_at);
      evidence.limitations.push('Issue closure is an observed GitHub state, not proof that code shipped or a pull request merged.');
    } else {
      const { data } = await this.read(() => this.octokit.rest.pulls.get({
        owner: artifact.repo_owner, repo: artifact.repo_name, pull_number: artifact.artifact_number,
        request: this.requestOptions(signal),
      }));
      this.validateObservation(data, artifact);
      const headSha = data.head?.sha;
      if (typeof headSha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(headSha)) {
        throw new GitHubReadError('invalid_response', 'GitHub did not return a valid pull request head SHA. Verification remains unknown.');
      }
      evidence.title = data.title;
      evidence.state = data.state;
      evidence.mergedAt = timestamp(data.merged_at);
      evidence.closedAt = timestamp(data.closed_at);
      evidence.headSha = headSha;
      evidence.mergeable = typeof data.mergeable === 'boolean' ? data.mergeable : null;
      evidence.draft = typeof data.draft === 'boolean' ? data.draft : null;
      if (evidence.mergeable === null) evidence.limitations.push('GitHub has not supplied a mergeability decision.');
      const tasks = [this.inspectChecks(artifact, headSha, evidence, signal), this.inspectStatuses(artifact, headSha, evidence, signal)];
      if (detailed) tasks.push(this.inspectFiles(artifact, evidence, signal), this.inspectReviews(artifact, evidence, signal));
      await Promise.all(tasks);
      if (evidence.checks.length === 0) {
        evidence.limitations.push('No check runs or commit statuses were reported for the observed head SHA. CI success is unknown.');
      }
      evidence.limitations.push('Observed checks do not establish that every required branch-protection check is present or satisfied.');
    }
    evidence.observedAt = new Date().toISOString();
    return evidence;
  }

  private validateReference(ref: ArtifactRef): ArtifactRef {
    try {
      const canonical = parseGitHubUrl(ref.artifact_url, this.allowedRepos);
      if (typeof ref.repo_owner !== 'string' || typeof ref.repo_name !== 'string' ||
          canonical.repo_owner !== ref.repo_owner.toLowerCase() || canonical.repo_name !== ref.repo_name.toLowerCase() ||
          canonical.artifact_type !== ref.artifact_type || canonical.artifact_number !== ref.artifact_number) {
        throw new Error('Reference fields do not match the GitHub URL.');
      }
      return canonical;
    } catch {
      throw new GitHubReadError('invalid_reference', 'The GitHub reference is invalid, inconsistent, or outside GITHUB_ALLOWED_REPOS.');
    }
  }

  private validateObservation(data: Pull | Issue, artifact: ArtifactRef): void {
    if (!data || data.number !== artifact.artifact_number || typeof data.title !== 'string' ||
        !['open', 'closed'].includes(data.state)) {
      throw new GitHubReadError('invalid_response', 'GitHub returned an unexpected artifact response. Verification remains unknown.');
    }
  }

  private requestOptions(signal: AbortSignal) {
    return { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) };
  }

  private async read<T>(request: () => Promise<T>): Promise<T> {
    if (Date.now() < this.blockedUntil) {
      throw new GitHubReadError('rate_limited', 'GitHub reads are waiting for the rate limit to reset.', 429, new Date(this.blockedUntil).toISOString());
    }
    try { return await request(); }
    catch (error) {
      if (error instanceof GitHubReadError) throw error;
      const candidate = error as { status?: unknown; response?: { headers?: Record<string, unknown> }; message?: unknown };
      const status = typeof candidate?.status === 'number' ? candidate.status : null;
      const headers = candidate?.response?.headers ?? {};
      const message = typeof candidate?.message === 'string' ? candidate.message : '';
      if (status === 429 || (status === 403 && (String(headers['x-ratelimit-remaining']) === '0' ||
          headers['retry-after'] !== undefined || /rate limit|abuse detection|secondary rate/i.test(message)))) {
        const retrySeconds = Number(headers['retry-after']);
        const resetSeconds = Number(headers['x-ratelimit-reset']);
        const retryCandidate = Date.now() + retrySeconds * 1000;
        const resetCandidate = resetSeconds * 1000;
        const retryTime = retrySeconds > 0 && Number.isFinite(new Date(retryCandidate).getTime()) ? retryCandidate : 0;
        const resetTime = resetSeconds > 0 && Number.isFinite(new Date(resetCandidate).getTime()) ? resetCandidate : 0;
        // GitHub asks for at least a minute when no usable reset header is available.
        this.blockedUntil = Math.max(Date.now() + 60_000, retryTime, resetTime);
        throw new GitHubReadError('rate_limited', 'GitHub rate limited this observation. Completion remains unverified until a successful read.', status, new Date(this.blockedUntil).toISOString());
      }
      if (status === 404) throw new GitHubReadError('not_found', 'GitHub could not find this artifact or the token cannot access it. Completion remains unverified.', status);
      if (status === 401) throw new GitHubReadError('authentication', 'GitHub rejected the configured token. Check its validity and expiry.', status);
      if (status === 403) throw new GitHubReadError('forbidden', 'The GitHub token lacks access to this observation. Completion remains unverified.', status);
      throw new GitHubReadError('unavailable', 'GitHub could not be read before the request deadline or returned a service error. Completion remains unverified.', status);
    }
  }

  private async optional(label: string, evidence: Evidence, work: () => Promise<void>): Promise<void> {
    try { await work(); }
    catch (error) {
      const safeError = error instanceof GitHubReadError ? error : new GitHubReadError('invalid_response', 'GitHub returned an unexpected response.');
      evidence.limitations.push(`${label} unavailable (${safeError.code}${safeError.status ? `, HTTP ${safeError.status}` : ''}).${safeError.retryAt ? ` Retry after ${safeError.retryAt}.` : ''} This is unknown, not a passing result.`);
    }
  }

  private async inspectChecks(ref: ArtifactRef, sha: string, evidence: Evidence, signal: AbortSignal): Promise<void> {
    await this.optional('Check runs', evidence, async () => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await this.read(() => this.octokit.rest.checks.listForRef({
          owner: ref.repo_owner, repo: ref.repo_name, ref: sha, filter: 'latest',
          per_page: PAGE_SIZE, page, request: this.requestOptions(signal),
        }));
        if (!Array.isArray(result.data.check_runs)) throw new Error('Invalid checks response.');
        const runs: Check[] = result.data.check_runs;
        for (const run of runs) {
          if (run.head_sha !== sha) {
            if (!evidence.limitations.includes('Check runs for another head SHA were excluded.')) evidence.limitations.push('Check runs for another head SHA were excluded.');
            continue;
          }
          evidence.checks.push({ name: run.name, status: run.status, conclusion: run.conclusion, url: safeLink(run.html_url) });
        }
        if (!hasNextPage(result.headers) && result.data.total_count <= page * PAGE_SIZE) break;
        if (page === MAX_PAGES) evidence.limitations.push(`Check runs truncated after ${MAX_PAGES * PAGE_SIZE} entries; remaining checks are unknown.`);
      }
    });
  }

  private async inspectStatuses(ref: ArtifactRef, sha: string, evidence: Evidence, signal: AbortSignal): Promise<void> {
    await this.optional('Commit statuses', evidence, async () => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await this.read(() => this.octokit.rest.repos.getCombinedStatusForRef({
          owner: ref.repo_owner, repo: ref.repo_name, ref: sha, per_page: PAGE_SIZE, page,
          request: this.requestOptions(signal),
        }));
        if (!Array.isArray(result.data.statuses) || result.data.sha !== sha) throw new Error('Invalid statuses response.');
        const statuses: Status[] = result.data.statuses;
        for (const status of statuses) {
          evidence.checks.push({
            name: `Commit status: ${status.context}`,
            status: status.state === 'pending' ? 'in_progress' : 'completed',
            conclusion: status.state === 'pending' ? null : status.state === 'success' ? 'success' : 'failure',
            url: safeLink(status.target_url),
          });
        }
        if (!hasNextPage(result.headers) && result.data.total_count <= page * PAGE_SIZE) break;
        if (page === MAX_PAGES) evidence.limitations.push(`Commit statuses truncated after ${MAX_PAGES * PAGE_SIZE} entries; remaining statuses are unknown.`);
      }
    });
  }

  private async inspectFiles(ref: ArtifactRef, evidence: Evidence, signal: AbortSignal): Promise<void> {
    await this.optional('Changed files', evidence, async () => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await this.read(() => this.octokit.rest.pulls.listFiles({
          owner: ref.repo_owner, repo: ref.repo_name, pull_number: ref.artifact_number,
          per_page: PAGE_SIZE, page, request: this.requestOptions(signal),
        }));
        if (!Array.isArray(result.data)) throw new Error('Invalid files response.');
        evidence.files.push(...result.data.map((file: File) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })));
        if (!hasNextPage(result.headers)) break;
        if (page === MAX_PAGES) evidence.limitations.push(`Changed files limited to ${MAX_PAGES * PAGE_SIZE} entries; the file list may be incomplete.`);
      }
    });
  }

  private async inspectReviews(ref: ArtifactRef, evidence: Evidence, signal: AbortSignal): Promise<void> {
    await this.optional('Reviews', evidence, async () => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await this.read(() => this.octokit.rest.pulls.listReviews({
          owner: ref.repo_owner, repo: ref.repo_name, pull_number: ref.artifact_number,
          per_page: PAGE_SIZE, page, request: this.requestOptions(signal),
        }));
        if (!Array.isArray(result.data)) throw new Error('Invalid reviews response.');
        evidence.reviews.push(...result.data.map((review: Review) => ({ user: review.user?.login ?? '[deleted user]', state: review.state })));
        if (!hasNextPage(result.headers)) break;
        if (page === MAX_PAGES) evidence.limitations.push(`Reviews limited to ${MAX_PAGES * PAGE_SIZE} entries; later reviews may be missing.`);
      }
      evidence.limitations.push('Review entries are review history; approvals may be stale and do not establish permission to merge.');
    });
  }
}
