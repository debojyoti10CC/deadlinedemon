import { z } from 'zod';

// Activation, cancellation and deletion are deliberately absent: only application commands
// may authorize those state transitions, even if a model returns hostile output.
export const IntentSchema = z.object({
  intent: z.enum([
    'create_contract', 'get_status', 'request_rescue', 'verify_completion',
    'list_contracts', 'change_intensity', 'pause', 'resume', 'unknown',
  ]),
  title: z.string().max(240).nullable(),
  artifact_url: z.string().max(2048).nullable(),
  deadline_local: z.string().max(64).nullable(),
  deadline_sources: z.array(z.string().min(1).max(500)).min(1).max(3).nullable(),
  milestones: z.array(z.object({
    title: z.string().min(1).max(240),
    deadline_local: z.string().min(1).max(64),
    deadline_sources: z.array(z.string().min(1).max(500)).min(1).max(3),
  }).strict()).min(2).max(5).nullable(),
  timezone: z.string().max(100).nullable(),
  intensity: z.enum(['mild', 'savage', 'nuclear']).nullable(),
  contract_id: z.string().uuid().nullable(),
  needs_clarification: z.boolean(),
  clarification: z.string().max(500).nullable(),
}).strict();

export const MessageSchema = z.object({ message: z.string().min(1).max(1200) }).strict();

export type ExtractedIntent = z.infer<typeof IntentSchema>;
