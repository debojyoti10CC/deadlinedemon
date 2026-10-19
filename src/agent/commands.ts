import { z } from 'zod';
import type { Contract, Intent, Intensity } from '../types.js';
import { GENERAL_HELP_REPLY, WELCOME_REPLY } from './help.js';

const UUID = z.string().uuid();
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const MODE_HELP = 'MILD: Supportive guidance.\nSAVAGE: Direct accountability.\nNUCLEAR: Firm deadline focus.\nReply MILD, SAVAGE, or NUCLEAR.';

function intent(name: Intent['intent'], values: Partial<Intent> = {}): Intent {
  return {
    intent: name, title: null, artifact_url: null, deadline_local: null, timezone: null,
    intensity: null, contract_id: null, needs_clarification: false, clarification: null,
    ...values,
  };
}

function clarify(message: string): Intent {
  return intent('unknown', { needs_clarification: true, clarification: message });
}

function referenceId(reference: string, contracts: readonly Contract[]): string | null {
  if (UUID.safeParse(reference).success) return reference.toLowerCase();
  if (!/^#?[1-9]\d*$/.test(reference)) return null;
  const number = Number(reference.replace(/^#/, ''));
  if (!Number.isSafeInteger(number)) return null;
  const matches = contracts.filter(contract => contract.display_id === number);
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Extract only syntactically explicit references for owner-scoped history lookup. */
export function commandTaskReference(text:string):string|null {
 const input=text.trim();
 const match=/^(?:CONFIRM|CANCEL|DELETE|STATUS|DONE|RECHECK|RESCUE|SELECT|MOVE)\s+(\S+)(?:\s|$)/i.exec(input)
  ?? /^PROGRESS\s+(\S+)\s+\d+(?:\.\d+)?\s*%?$/i.exec(input)
  ?? /^(?:TASK\s+)(#?[1-9]\d*)$/i.exec(input)
  ?? /^(#[1-9]\d*)$/.exec(input);
 const reference=match?.[1];
 if(!reference||(!UUID.safeParse(reference).success&&!/^#?[1-9]\d*$/.test(reference)))return null;
 return reference.replace(/^#/,'').toLowerCase();
}

/** Owner commands are resolved locally; model output cannot authorize these controls. */
export function parseCommand(text: string, contracts: readonly Contract[] = [], selectedId: string | null = null): Intent | null {
  const input = text.trim();
  if (/^(?:hi|hello|hey)[!.?]*$/i.test(input)) return clarify(WELCOME_REPLY);
  if (/^(?:help|what can you do)[!.?]*$/i.test(input)) return clarify(GENERAL_HELP_REPLY);
  if (/^PAUSE$/i.test(input)) return intent('pause');
  if (/^RESUME$/i.test(input)) return intent('resume');
  if (/^LIST$/i.test(input)) return intent('list_contracts');
  if (/^MODE$/i.test(input)) return clarify(MODE_HELP);
  const mode = /^(?:MODE\s+)?(mild|savage|nuclear)$/i.exec(input);
  if (mode) return intent('change_intensity', { intensity: mode[1]!.toLowerCase() as Intensity });

  // Removal always names one task explicitly; never borrow a saved selection.
  const deletion = /^DELETE\s+(\S+)$/i.exec(input);
  if (deletion) {
    const contractId = referenceId(deletion[1]!, contracts);
    return contractId ? intent('delete_contract', { contract_id: contractId })
      : clarify('No matching task. Send LIST, then DELETE followed by that task’s number.');
  }
  if (/^DELETE\b/i.test(input)) return clarify('Delete one task with DELETE 4, using its number from LIST. Other tasks stay unchanged.');

  const move = /^MOVE\s+(\S+)\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/i.exec(input);
  if (move) {
    const contractId=referenceId(move[1]!,contracts);
    if(!contractId)return clarify('No matching task. Send LIST, then use MOVE with its task number.');
    return intent('reschedule_contract',{contract_id:contractId,deadline_local:`${move[2]}T${move[3]}`});
  }

  const progress = /^PROGRESS\s+(?:(\S+)\s+)?(\d+(?:\.\d+)?)\s*(%)?$/i.exec(input);
  if (progress) {
    const percent = Number(progress[2]);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      return clarify('Progress must be a whole percentage from 0% to 100%. Try PROGRESS 1 40%.');
    }
    const reference = progress[1];
    if (!reference && !progress[3]) return clarify('Use PROGRESS 40% for your selected task, or PROGRESS 1 40%.');
    const contractId = reference ? referenceId(reference, contracts) : null;
    if (reference && !contractId) return clarify('No matching task. Send LIST, then PROGRESS 1 40% using its task number.');
    return intent('report_progress', { contract_id: contractId, progress_percent: percent });
  }

  const command = /^(CONFIRM|CANCEL|STATUS|DONE|RECHECK|RESCUE)(?:\s+(\S+))?$/i.exec(input);
  if (command) {
    const name = command[1]!.toUpperCase();
    const reference = command[2];
    const contractId = reference ? referenceId(reference, contracts) : null;
    if (reference && !contractId) return clarify(`No matching task. Send LIST, then ${name} 1 using its task number or full UUID.`);
    const names = {
      CONFIRM: 'confirm_contract', CANCEL: 'cancel_contract', STATUS: 'get_status',
      DONE: 'verify_completion', RECHECK: 'verify_completion', RESCUE: 'request_rescue',
    } as const;
    return intent(names[name as keyof typeof names], { contract_id: contractId });
  }

  const select = /^(?:SELECT\s+(\S+)|(?:TASK\s+)?(#?[1-9]\d*))$/i.exec(input);
  // A bare number is not a selection command; #1 and task 1 are explicit selections.
  if (select && (/^SELECT\s|^TASK\s|^#/i.test(input))) {
    const contractId = referenceId(select[1] ?? select[2]!, contracts);
    if (!contractId || !contracts.some(contract => contract.id === contractId)) return clarify('No matching task. Send LIST, then SELECT 1 using its task number.');
    return intent('select_contract', { contract_id: contractId });
  }
  const ordinal = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+task[.!?]*$/i.exec(input);
  if (ordinal) {
    const visible=contracts.filter(contract=>!contract.deleted_at);
    const current=visible.filter(contract=>['pending','active','missed'].includes(contract.state));
    const ordered = (current.length?current:visible).filter(contract => Number.isSafeInteger(contract.display_id) && contract.display_id > 0)
      .slice().sort((left, right) => left.display_id - right.display_id);
    const selected = ordered[ORDINALS.indexOf(ordinal[1]!.toLowerCase())];
    return selected ? intent('select_contract', { contract_id: selected.id }) : clarify('That task is not in your list. Send LIST to see your task numbers.');
  }
  if (/^SELECT$/i.test(input)) {
    const selected = contracts.find(contract => contract.id === selectedId);
    return clarify(`${selected ? `Task #${selected.display_id} is selected. ` : ''}Choose a task with SELECT 1 or #1. Send LIST for task numbers.`);
  }
  // Malformed local controls must never fall through to model interpretation.
  if (/^(CONFIRM|CANCEL|STATUS|DONE|RECHECK|RESCUE|SELECT)\b/i.test(input) || /^TASK\s+#?\d+$/i.test(input) || /^#\d+$/.test(input)) {
    return clarify('Use a task number from LIST, for example SELECT 1, STATUS 1, or CONFIRM 1. A full UUID also works.');
  }
  if (/^PROGRESS\b/i.test(input)) return clarify('Use PROGRESS 1 40% or PROGRESS 40% for your selected task. Progress must be from 0% to 100%.');
  if (/^MOVE\b/i.test(input)) return clarify('Move a pending task with MOVE 1 YYYY-MM-DD HH:mm using a future 24-hour time in your saved timezone.');
  if (/^MODE\b/i.test(input)) return clarify(MODE_HELP);
  return null;
}
