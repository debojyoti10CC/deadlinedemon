import type { Evidence } from '../types.js';
export function completion(evidence: Evidence): { complete: boolean; at: Date | null; description: string } {
 if (evidence.artifact.artifact_type === 'pull_request') {
   const at = evidence.mergedAt ? new Date(evidence.mergedAt) : null;
   return { complete: !!at && Number.isFinite(at.getTime()), at, description: at ? 'GitHub reports a merged pull request' : `GitHub reports PR ${evidence.state}; no merge verified` };
 }
 const at = evidence.state === 'closed' && evidence.closedAt ? new Date(evidence.closedAt) : null;
 return { complete: !!at && Number.isFinite(at.getTime()), at, description: at ? 'GitHub issue closure observed; code delivery is not independently verified' : `GitHub reports issue ${evidence.state}` };
}
