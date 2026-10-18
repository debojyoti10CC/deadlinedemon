export type Intensity = 'mild' | 'savage' | 'nuclear';
export type ContractState = 'pending' | 'active' | 'completed' | 'missed' | 'cancelled';
export interface ArtifactRef {
  repo_owner: string; repo_name: string; artifact_type: 'pull_request' | 'issue';
  artifact_number: number; artifact_url: string;
}
export interface Evidence {
  artifact: ArtifactRef; observedAt: string; title: string; state: string;
  mergedAt: string | null; closedAt: string | null; headSha: string | null;
  mergeable: boolean | null; draft: boolean | null;
  checks: Array<{ name: string; status: string; conclusion: string | null; url: string | null }>;
  reviews: Array<{ user: string; state: string }>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  limitations: string[];
}
export interface User {
  id: string; imessage_handle: string; timezone: string; intensity: Intensity;
  paused: boolean; space_id: string | null;
  selected_contract_id: string | null;
  hourly_summary_due_at?: Date | null;
}
export interface TaskRef {
  artifact_type: 'task'; repo_owner: null; repo_name: null;
  artifact_number: null; artifact_url: null;
}
export interface ContractFields {
  id: string; user_id: string; title: string; due_at: Date; state: ContractState;
  display_id: number; progress_percent: number;
  intensity: Intensity; created_at: Date; confirmed_at: Date | null;
  completed_at: Date | null; last_checked_at: Date | null;
  last_observed_state: Evidence | null; version: number; missed_at: Date | null;
}
export type GitHubContract = ContractFields & ArtifactRef;
export type TaskContract = ContractFields & TaskRef;
export type Contract = GitHubContract | TaskContract;
export interface TaskMilestone { title: string; deadline_local: string }
export interface InboundEnvelope {
  providerMessageId: string; spaceId: string; senderHandle: string;
  text: string; receivedAt: Date;
}
export interface Transport {
  send(spaceId: string, text: string): Promise<void>;
  responding<T>(spaceId: string, fn: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}
export interface GitHubReader { inspect(ref: ArtifactRef, detailed?: boolean): Promise<Evidence> }
export interface Intent {
  intent: 'create_contract' | 'confirm_contract' | 'get_status' | 'request_rescue' |
    'verify_completion' | 'list_contracts' | 'change_intensity' | 'pause' | 'resume' |
    'cancel_contract' | 'select_contract' | 'report_progress' | 'reschedule_contract' | 'unknown';
  title: string | null; artifact_url: string | null; deadline_local: string | null;
  timezone: string | null; intensity: Intensity | null; contract_id: string | null;
  needs_clarification: boolean; clarification: string | null;
  milestones?: TaskMilestone[] | null;
  progress_percent?: number | null;
}
export interface IntentContext {
  now: string; timezone: string; intensity: Intensity;
  selected_contract_id?: string | null;
  contracts: Contract[]; history: Array<{ role: 'user' | 'assistant'; content: string; created_at?: Date }>;
}
export interface Agent {
  parse(text: string, context: IntentContext): Promise<Intent>;
  generate(event: string, context: Record<string, unknown>, intensity: Intensity): Promise<string>;
}
