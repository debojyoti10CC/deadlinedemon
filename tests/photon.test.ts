import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    frames: [] as Array<[Record<string, unknown>, Record<string, unknown>]>,
    end: () => {},
    send: vi.fn(), get: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn(),
    stop: vi.fn(), spectrum: vi.fn(),
  };
  return state;
});
vi.mock('spectrum-ts', () => ({ Spectrum: fake.spectrum }));
vi.mock('spectrum-ts/providers/imessage', () => ({
  imessage: Object.assign((app: { im: unknown }) => app.im, { config: () => ({}) }),
}));

import { createPhotonTransport } from '../src/photon/client.js';
import type { InboundEnvelope } from '../src/types.js';

const config = { projectId: 'test-project', projectSecret: 'test-secret', ownerHandle: '+15551234567' };
const ownerSpace = { id: `any;-;${config.ownerHandle}`, type: 'dm', __platform: 'imessage', phone: 'shared' };
const frame = (id: string, senderId = config.ownerHandle): [Record<string, unknown>, Record<string, unknown>] => [ownerSpace, {
  id, direction: 'inbound', platform: 'imessage', sender: { id: senderId },
  content: { type: 'text', text: `text-${id}` }, timestamp: new Date(), space: ownerSpace,
}];

beforeEach(() => {
  vi.clearAllMocks();
  fake.frames = [];
  const done = new Promise<void>((resolve) => { fake.end = resolve; });
  fake.stop.mockImplementation(async () => { fake.end(); });
  fake.send.mockResolvedValue({ id: 'acknowledged-id' });
  fake.stopTyping.mockResolvedValue(undefined);
  fake.startTyping.mockResolvedValue(undefined);
  fake.get.mockImplementation(async (id: string) => ({
    ...ownerSpace, id, send: fake.send, startTyping: fake.startTyping, stopTyping: fake.stopTyping,
  }));
  const messages = { async *[Symbol.asyncIterator]() {
    for (const entry of fake.frames) yield entry;
    await done;
  } };
  fake.spectrum.mockResolvedValue({ im: { messages, space: { get: fake.get } }, stop: fake.stop });
});

describe('Spectrum Cloud transport', () => {
  it('records safe receipt diagnostics and forwards inline reply text without its quoted target', async () => {
    const reply = frame('inline');
    reply[1].content = {
      type: 'reply', content: { type: 'text', text: 'LIST' },
      target: { content: { type: 'text', text: 'private quoted material' } },
    };
    fake.frames = [frame('ignored-private-id', '+15557654321'), reply];
    const receive = vi.fn(async (_message: InboundEnvelope) => {});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = await createPhotonTransport(config, receive, logger);
    expect(transport.diagnostics()).toMatchObject({ consumerRunning: false, lastFrameAt: null, lastAcceptedAt: null, acceptedFrames: 0, rejectedFrames: 0 });
    const run = transport.run();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ providerMessageId: 'inline', text: 'LIST' });
    expect(transport.diagnostics()).toMatchObject({ consumerRunning: true, inboundHealthy: true, acceptedFrames: 1, rejectedFrames: 1, lastRejection: 'sender' });
    expect(Number.isFinite(Date.parse(transport.diagnostics().lastFrameAt!))).toBe(true);
    expect(transport.diagnostics().lastAcceptedAt).toBe(transport.diagnostics().lastFrameAt);
    const logs = JSON.stringify(logger.info.mock.calls);
    for (const privateText of ['ignored-private-id', '+15557654321', config.ownerHandle, 'private quoted material', 'LIST']) expect(logs).not.toContain(privateText);
    await transport.stop();
    await run;
  });

  it('keeps an observed inbound failure unhealthy after a successful outgoing send', async () => {
    fake.frames = [frame('broken-callback')];
    const transport = await createPhotonTransport(config, async () => { throw new Error('private database error'); });
    await expect(transport.run()).rejects.toThrow('Photon inbound consumer failed.');
    expect(transport.diagnostics()).toMatchObject({ consumerRunning: false, inboundHealthy: false });
    await transport.send(ownerSpace.id, 'approved response');
    expect(transport.diagnostics()).toMatchObject({ inboundHealthy: false, outboundHealthy: true });
    expect(transport.isReady()).toBe(false);
    await transport.stop();
  });

  it('does not let an accepted incoming frame hide an outgoing failure', async () => {
    fake.send.mockRejectedValue(new Error('unavailable'));
    fake.frames = [frame('one')];
    const receive = vi.fn(async () => {});
    const transport = await createPhotonTransport(config, receive);
    await expect(transport.send(ownerSpace.id, 'approved')).rejects.toThrow('delivery is uncertain');
    const run = transport.run();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(transport.diagnostics()).toMatchObject({ inboundHealthy: true, outboundHealthy: false });
    expect(transport.isReady()).toBe(false);
    await transport.stop();
    await run;
  });

  it('processes only authorized inbound messages sequentially and drains before stopping', async () => {
    fake.frames = [frame('ignored', '+15557654321'), frame('first'), frame('second')];
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const transport = await createPhotonTransport(config, async (message) => {
      seen.push(message.providerMessageId);
      if (message.providerMessageId === 'first') await held;
    });
    const run = transport.run();
    await vi.waitFor(() => expect(seen).toEqual(['first']));
    expect(transport.isReady()).toBe(true);
    release();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']));
    await transport.stop();
    await run;
    expect(transport.isReady()).toBe(false);
    await transport.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('resolves persisted owner space IDs and refuses forged/group IDs before API access', async () => {
    const transport = await createPhotonTransport(config, async () => {});
    await transport.send(ownerSpace.id, 'approved');
    expect(fake.get).toHaveBeenCalledWith(ownerSpace.id, undefined);
    expect(fake.send).toHaveBeenCalledWith('approved');
    fake.get.mockClear();
    await expect(transport.send('any;-;+15557654321', 'refused')).rejects.toThrow('configured owner');
    await expect(transport.send('iMessage;+;group', 'refused')).rejects.toThrow('configured owner');
    expect(fake.get).not.toHaveBeenCalled();
    await transport.stop();
  });

  it('routes an accepted inbound DM through its serving phone', async () => {
    fake.frames = [frame('one')];
    const transport = await createPhotonTransport(config, async (message) => {
      await transport.send(message.spaceId, 'response');
    });
    const run = transport.run();
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    expect(fake.get).toHaveBeenCalledWith(ownerSpace.id, { phone: 'shared' });
    await transport.stop();
    await run;
  });

  it('uses a configured dedicated line when no inbound routing cache exists', async () => {
    const transport = await createPhotonTransport({ ...config, servingPhone: '+15559876543' }, async () => {});
    await transport.send(ownerSpace.id, 'response');
    expect(fake.get).toHaveBeenCalledWith(ownerSpace.id, { phone: '+15559876543' });
    await transport.stop();
  });

  it('surfaces unacknowledged sends without retrying the logical send', async () => {
    fake.send.mockResolvedValue(undefined);
    const transport = await createPhotonTransport(config, async () => {});
    await expect(transport.send(ownerSpace.id, 'one')).rejects.toThrow('delivery is uncertain');
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(transport.isReady()).toBe(false);
    await transport.stop();
  });

  it('runs the callback once when typing fails, then attempts cleanup', async () => {
    fake.startTyping.mockRejectedValue(new Error('typing unavailable'));
    const work = vi.fn(async () => 'done');
    const transport = await createPhotonTransport(config, async () => {});
    expect(await transport.responding(ownerSpace.id, work)).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
    expect(fake.stopTyping).toHaveBeenCalledTimes(1);
    await transport.stop();
  });

  it('does not replay failed application work as a typing fallback', async () => {
    const work = vi.fn(async () => { throw new Error('application error'); });
    const transport = await createPhotonTransport(config, async () => {});
    await expect(transport.responding(ownerSpace.id, work)).rejects.toThrow('application error');
    expect(work).toHaveBeenCalledTimes(1);
    await transport.stop();
  });

  it('fails closed if a provider resolves the requested owner ID as another space', async () => {
    fake.get.mockResolvedValue({ ...ownerSpace, id: 'any;-;+15557654321', send: fake.send });
    const transport = await createPhotonTransport(config, async () => {});
    await expect(transport.send(ownerSpace.id, 'no')).rejects.toThrow('Cannot resolve');
    expect(fake.send).not.toHaveBeenCalled();
    await transport.stop();
  });

  it('bounds an unresponsive text send and reports uncertain delivery', async () => {
    vi.useFakeTimers();
    try {
      fake.send.mockReturnValue(new Promise(() => {}));
      const transport = await createPhotonTransport(config, async () => {});
      const sending = transport.send(ownerSpace.id, 'one');
      const rejected = expect(sending).rejects.toThrow('delivery is uncertain');
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(fake.send).toHaveBeenCalledTimes(1);
      await transport.stop();
    } finally { vi.useRealTimers(); }
  });

  it('reports only an allowlisted initialization status without provider secrets', async () => {
    fake.spectrum.mockRejectedValue({ status: 401, message: 'token=secret-provider-value' });
    await expect(createPhotonTransport(config, async () => {})).rejects.toThrow('Photon initialization failed (http_401)');
    try { await createPhotonTransport(config, async () => {}); }
    catch (error) { expect(String(error)).not.toContain('secret-provider-value'); }
  });
});
