import { describe, expect, it } from 'vitest';
import type { Contract, ContractState, Evidence } from '../src/types.js';
import { assertTransition } from '../src/contracts/state-machine.js';
import { completion } from '../src/contracts/verifier.js';
import { selectContract } from '../src/agent/orchestrator.js';

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    artifact: { repo_owner: 'acme', repo_name: 'app', artifact_type: 'pull_request', artifact_number: 7, artifact_url: 'https://github.com/acme/app/pull/7' },
    observedAt: '2026-10-18T12:00:00Z', title: 'Ship it', state: 'open', mergedAt: null,
    closedAt: null, headSha: 'a'.repeat(40), mergeable: null, draft: false,
    checks: [], reviews: [], files: [], limitations: [], ...overrides,
  };
}

function contract(id: string, due: string, state: ContractState = 'active'): Contract {
  return {
    ...evidence().artifact, id, user_id: 'owner', title: id, due_at: new Date(due), state,
    display_id: 1, progress_percent: 0,
    intensity: 'savage', created_at: new Date('2026-10-18T00:00:00Z'), confirmed_at: null,
    completed_at: null, last_checked_at: null, last_observed_state: null, version: 1, missed_at: null,
  };
}

describe('contract proof', () => {
  it('requires a merge timestamp for PR completion, independent of closed state or CI success', () => {
    const result = completion(evidence({
      state: 'closed', closedAt: '2026-10-18T10:00:00Z',
      checks: [{ name: 'tests', status: 'completed', conclusion: 'success', url: null }],
    }));
    expect(result.complete).toBe(false);
    expect(result.at).toBeNull();
    expect(result.description).toContain('no merge verified');
  });

  it('takes merge timing from GitHub mergedAt', () => {
    const result = completion(evidence({ state: 'closed', mergedAt: '2026-10-18T10:00:00Z', closedAt: '2026-10-18T11:00:00Z' }));
    expect(result.complete).toBe(true);
    expect(result.at?.toISOString()).toBe('2026-10-18T10:00:00.000Z');
  });

  it('accepts an observed issue closure while qualifying delivery claims', () => {
    const issue = evidence({ state: 'closed', closedAt: '2026-10-18T09:00:00Z' });
    issue.artifact = { ...issue.artifact, artifact_type: 'issue', artifact_url: 'https://github.com/acme/app/issues/7' };
    const result = completion(issue);
    expect(result.complete).toBe(true);
    expect(result.at?.toISOString()).toBe('2026-10-18T09:00:00.000Z');
    expect(result.description).toContain('not independently verified');
  });

  it('does not complete a reopened issue from an earlier closedAt', () => {
    const issue = evidence({ state: 'open', closedAt: '2026-10-18T09:00:00Z' });
    issue.artifact = { ...issue.artifact, artifact_type: 'issue' };
    expect(completion(issue).complete).toBe(false);
  });

  it.each(['not-a-date', ''])('rejects invalid merge timestamps (%s)', (mergedAt) => {
    expect(completion(evidence({ mergedAt })).complete).toBe(false);
  });

  it('does not treat unknown checks or draft changes as completion proof', () => {
    expect(completion(evidence({ draft: false, mergeable: true, limitations: ['Checks unavailable.'] })).complete).toBe(false);
  });
});

describe('contract state transitions', () => {
  it.each<[ContractState, ContractState]>([
    ['pending', 'active'], ['pending', 'cancelled'], ['active', 'completed'],
    ['active', 'missed'], ['active', 'cancelled'], ['missed', 'completed'], ['missed', 'cancelled'],
  ])('allows %s to %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each<[ContractState, ContractState]>([
    ['pending', 'completed'], ['pending', 'missed'], ['active', 'pending'], ['active', 'active'],
    ['missed', 'active'], ['completed', 'active'], ['completed', 'cancelled'],
    ['cancelled', 'active'], ['cancelled', 'completed'], ['cancelled', 'cancelled'],
  ])('rejects %s to %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow('Invalid contract transition');
  });
});

describe('contract selection', () => {
  const earlier = contract('11111111-1111-4111-8111-111111111111', '2026-10-18T13:00:00Z');
  const later = contract('22222222-2222-4222-8222-222222222222', '2026-10-18T14:00:00Z');

  it('requires an explicit full contract ID for ambiguous commands', () => {
    expect(selectContract([later, earlier], { intent: 'verify_completion', contract_id: null })).toBeUndefined();
    expect(selectContract([later, earlier], { intent: 'confirm_contract', contract_id: null })).toBeUndefined();
    expect(selectContract([later, earlier], { intent: 'cancel_contract', contract_id: null })).toBeUndefined();
  });

  it('uses the single eligible contract without an ID', () => {
    expect(selectContract([earlier], { intent: 'get_status', contract_id: null })).toBe(earlier);
  });

  it('selects exactly the requested full ID and rejects unknown or partial IDs', () => {
    expect(selectContract([earlier, later], { intent: 'get_status', contract_id: later.id })).toBe(later);
    expect(selectContract([earlier], { intent: 'get_status', contract_id: '11111111' })).toBeUndefined();
    expect(selectContract([earlier], { intent: 'get_status', contract_id: later.id })).toBeUndefined();
  });

  it('rescues the nearest eligible deadline without mutating input ordering', () => {
    const input = [later, earlier];
    expect(selectContract(input, { intent: 'request_rescue', contract_id: null })).toBe(earlier);
    expect(input).toEqual([later, earlier]);
    expect(selectContract(input, { intent: 'request_rescue', contract_id: later.id })).toBe(later);
  });

  it('handles an empty eligible set', () => {
    expect(selectContract([], { intent: 'get_status', contract_id: null })).toBeUndefined();
    expect(selectContract([], { intent: 'request_rescue', contract_id: null })).toBeUndefined();
  });
});
