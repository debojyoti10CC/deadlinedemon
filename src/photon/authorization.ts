/** Do not guess country codes or change case: this is an exact allowlist. */
export function validOwnerHandle(handle: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(handle) ||
    (handle.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(handle));
}

/** Spectrum's space.get does not validate recipients, so validate before it. */
export function isOwnerDirectSpace(spaceId: string, ownerHandle: string): boolean {
  if (!validOwnerHandle(ownerHandle)) return false;
  return spaceId === `any;-;${ownerHandle}` || spaceId === `iMessage;-;${ownerHandle}`;
}

interface InboundCandidate {
  platform: string;
  direction: string;
  id: string;
  sender?: { id: string; kind?: string; service?: string };
  content: { type: string; text?: string; content?: unknown };
  timestamp: Date;
  space: { id: string; __platform: string; type?: string };
}

export type InboundRejection = 'platform' | 'direction' | 'sender' | 'service' | 'space' | 'identifier' | 'timestamp' | 'content';

/** Only the new text of an inline reply is actionable; quoted targets are never read. */
export function inboundPlainText(content: unknown): string | null {
  let current = content;
  for (let depth = 0; depth <= 4; depth++) {
    if (!current || typeof current !== 'object') return null;
    const candidate = current as { type?: unknown; text?: unknown; content?: unknown };
    if (candidate.type === 'text') {
      return typeof candidate.text === 'string' && candidate.text.trim().length > 0 ? candidate.text : null;
    }
    if (candidate.type !== 'reply') return null;
    current = candidate.content;
  }
  return null;
}

/** Fixed reason codes are safe to log; never return provider data or identities. */
export function inboundRejectionReason(
  ownerHandle: string,
  space: { id: string; __platform: string; type?: string },
  message: InboundCandidate,
): InboundRejection | null {
  if (message.platform !== 'imessage') return 'platform';
  if (message.direction !== 'inbound') return 'direction';
  if (message.sender?.kind === 'agent' || message.sender?.id !== ownerHandle) return 'sender';
  if (message.sender.service !== undefined && message.sender.service !== 'iMessage') return 'service';
  if (space.__platform !== 'imessage' || space.type !== 'dm' ||
    message.space.__platform !== 'imessage' || message.space.type !== 'dm' ||
    message.space.id !== space.id || !isOwnerDirectSpace(space.id, ownerHandle)) return 'space';
  if (typeof message.id !== 'string' || !message.id.length) return 'identifier';
  if (!(message.timestamp instanceof Date) || !Number.isFinite(message.timestamp.getTime())) return 'timestamp';
  if (inboundPlainText(message.content) === null) return 'content';
  return null;
}

export function authorizedInbound(
  ownerHandle: string,
  space: { id: string; __platform: string; type?: string },
  message: InboundCandidate,
): boolean {
  return inboundRejectionReason(ownerHandle, space, message) === null;
}
