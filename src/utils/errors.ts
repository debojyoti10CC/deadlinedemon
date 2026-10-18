export function safeError(error: unknown): { name: string; code?: string; status?: number } {
  // Do not serialize SDK error objects: they can contain headers, URLs, prompts or secrets.
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const e = error as Error & {code?: unknown; status?: unknown};
  return { name: e.name, ...(typeof e.code === 'string' ? {code:e.code} : {}), ...(typeof e.status === 'number' ? {status:e.status} : {}) };
}
