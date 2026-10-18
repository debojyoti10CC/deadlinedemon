import { describe, expect, it } from 'vitest';
import { authorizedInbound, inboundPlainText, inboundRejectionReason, isOwnerDirectSpace, validOwnerHandle } from '../src/photon/authorization.js';

const owner = '+15551234567';
const space = { id: `any;-;${owner}`, __platform: 'imessage', type: 'dm' };
const message = () => ({
  id: 'message-1', platform: 'imessage', direction: 'inbound',
  sender: { id: owner }, content: { type: 'text', text: 'status' },
  timestamp: new Date('2026-10-18T14:00:00Z'), space,
});

describe('owner iMessage authorization', () => {
  it('accepts only canonical owner handle configuration', () => {
    expect(validOwnerHandle(owner)).toBe(true);
    expect(validOwnerHandle('owner@example.com')).toBe(true);
    for (const handle of ['5551234567', '+1 (555) 123-4567', ' owner@example.com', '']) {
      expect(validOwnerHandle(handle)).toBe(false);
    }
  });

  it('accepts an inbound plain text owner DM', () => {
    expect(authorizedInbound(owner, space, message())).toBe(true);
  });

  it('accepts only the new plain text in an authorized inline reply', () => {
    const content = { type: 'reply', content: { type: 'text', text: 'LIST' }, target: { content: { type: 'text', text: 'DONE 1' } } };
    expect(authorizedInbound(owner, space, { ...message(), content })).toBe(true);
    expect(inboundPlainText(content)).toBe('LIST');
    expect(inboundRejectionReason(owner, space, { ...message(), sender: { id: '+15557654321' }, content })).toBe('sender');
    const group = { ...space, type: 'group' };
    expect(inboundRejectionReason(owner, group, { ...message(), space: group, content })).toBe('space');
  });

  it('bounds nested replies and rejects attachments, groups, empty text, and cyclic content', () => {
    let content: unknown = { type: 'text', text: 'STATUS' };
    for (let i = 0; i < 4; i++) content = { type: 'reply', content };
    expect(inboundPlainText(content)).toBe('STATUS');
    expect(inboundPlainText({ type: 'reply', content })).toBeNull();
    for (const inner of [{ type: 'attachment' }, { type: 'group', items: [{ type: 'text', text: 'LIST' }] }, { type: 'text', text: ' ' }]) {
      expect(inboundPlainText({ type: 'reply', content: inner })).toBeNull();
    }
    const cycle: { type: string; content?: unknown } = { type: 'reply' };
    cycle.content = cycle;
    expect(inboundPlainText(cycle)).toBeNull();
  });

  it.each([
    { direction: 'outbound' }, { platform: 'local_imessage' },
    { sender: { id: '+15557654321' } }, { sender: undefined },
    { sender: { id: owner, kind: 'agent' } }, { sender: { id: owner, service: 'SMS' } },
    { content: { type: 'attachment' } }, { content: { type: 'group' } },
    { content: { type: 'text', text: '  ' } }, { id: '' },
    { timestamp: new Date('invalid') },
  ])('rejects unsafe inbound shape %j', (change) => {
    expect(authorizedInbound(owner, space, { ...message(), ...change })).toBe(false);
  });

  it('rejects groups, mismatched envelope spaces, and forged owner suffixes', () => {
    const group = { ...space, id: 'iMessage;+;group-id', type: 'group' };
    expect(authorizedInbound(owner, group, { ...message(), space: group })).toBe(false);
    expect(authorizedInbound(owner, space, { ...message(), space: { ...space, id: 'any;-;+15557654321' } })).toBe(false);
    for (const id of [`any;-;${owner};evil`, `any;-;${owner}0`, `SMS;-;${owner}`, `any;+;${owner}`, owner]) {
      expect(isOwnerDirectSpace(id, owner)).toBe(false);
    }
  });

  it('matches email handles exactly', () => {
    expect(isOwnerDirectSpace('any;-;Owner@example.com', 'Owner@example.com')).toBe(true);
    expect(isOwnerDirectSpace('any;-;owner@example.com', 'Owner@example.com')).toBe(false);
  });
});
