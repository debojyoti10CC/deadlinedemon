import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import type { InboundEnvelope, Transport } from '../types.js';
import { inboundPlainText, inboundRejectionReason, isOwnerDirectSpace, validOwnerHandle, type InboundRejection } from './authorization.js';

export interface PhotonConfig {
  projectId: string;
  projectSecret: string;
  ownerHandle: string;
  /** Optional dedicated line for resolving persisted spaces after a restart. */
  servingPhone?: string;
}

/** A Pino logger is compatible; never pass provider error objects to it. */
export interface PhotonLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PhotonDiagnostics {
  consumerRunning: boolean;
  inboundHealthy: boolean;
  outboundHealthy: boolean;
  lastFrameAt: string | null;
  lastAcceptedAt: string | null;
  acceptedFrames: number;
  rejectedFrames: number;
  lastRejection: InboundRejection | null;
}

export type PhotonTransport = Transport & { run(): Promise<void>; isReady(): boolean; diagnostics(): PhotonDiagnostics };

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PHOTON_OPERATION_TIMEOUT')), milliseconds);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => {
      clearTimeout(timer); reject(error);
    });
  });
}

/** Provider error bodies/URLs can contain secrets: expose only known codes. */
function failureCode(error: unknown): string {
  if (error instanceof Error && error.message === 'PHOTON_OPERATION_TIMEOUT') return 'timeout';
  if (!error || typeof error !== 'object') return 'unknown';
  const record = error as Record<string, unknown>;
  const codes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'UNAVAILABLE']);
  if (typeof record.code === 'string' && codes.has(record.code)) return record.code;
  if (typeof record.code === 'number' && Number.isInteger(record.code) && record.code >= 0 && record.code <= 16) return `grpc_${record.code}`;
  const status = record.status ?? record.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
  return 'unknown';
}

export async function createPhotonTransport(
  config: PhotonConfig,
  onMessage: (message: InboundEnvelope) => Promise<void>,
  logger?: PhotonLogger,
): Promise<PhotonTransport> {
  if (!config.projectId.trim() || !config.projectSecret.trim()) {
    throw new Error('Photon project ID and project secret are required.');
  }
  if (!validOwnerHandle(config.ownerHandle)) {
    throw new Error('ADMIN_IMESSAGE_HANDLE must be an exact E.164 phone number or iMessage email address.');
  }
  if (config.servingPhone && !/^\+[1-9]\d{7,14}$/.test(config.servingPhone)) {
    throw new Error('Photon serving phone must be an E.164 phone number.');
  }

  // One SDK/provider contract: spectrum-ts 12.11.x, Spectrum Cloud iMessage.
  // SDK errors can contain recipient identifiers. Our diagnostics are metadata-only.
  const initializing = Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [imessage.config()],
    options: { logLevel: 'silent', flattenGroups: false },
    telemetry: false,
  });
  const app = await deadline(initializing, 30_000).catch((error: unknown) => {
    // The SDK has no AbortSignal: dispose a late initialization result as well.
    void initializing.then((lateApp) => deadline(lateApp.stop(), 20_000)).catch(() => undefined);
    throw new Error(`Photon initialization failed (${failureCode(error)}). Check project credentials, enabled iMessage service, and network access.`);
  });
  const im = imessage(app);
  let stopped = false;
  let running = false;
  let inboundHealthy = true;
  let outboundHealthy = true;
  let lastFrameAt: string | null = null;
  let lastAcceptedAt: string | null = null;
  let acceptedFrames = 0;
  let rejectedFrames = 0;
  let lastRejection: InboundRejection | null = null;
  let runPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const servingPhones = new Map<string, string>();

  const assertOpen = () => {
    if (stopped) throw new Error('Photon transport is stopped.');
  };
  const resolveOwnerSpace = async (spaceId: string) => {
    assertOpen();
    if (!isOwnerDirectSpace(spaceId, config.ownerHandle)) {
      throw new Error('Refusing Photon operation outside the configured owner direct message.');
    }
    try {
      // Resolve persisted IDs through the documented namespace. Do not create a
      // different conversation, infer a recipient, or trust stored IDs blindly.
      const phone = config.servingPhone ?? servingPhones.get(spaceId);
      const space = await deadline(im.space.get(spaceId, phone ? { phone } : undefined), 15_000);
      if (space.__platform !== 'imessage' || space.type !== 'dm' ||
        space.id !== spaceId || !isOwnerDirectSpace(space.id, config.ownerHandle)) {
        throw new Error('Unsafe resolved Photon space.');
      }
      return space;
    } catch {
      outboundHealthy = false;
      logger?.error('Photon owner conversation resolution failed.');
      throw new Error('Cannot resolve the approved Photon owner conversation. With multiple dedicated lines, first send a new owner DM after restart.');
    }
  };

  const transport: PhotonTransport = {
    isReady: () => running && !stopped && inboundHealthy && outboundHealthy,
    diagnostics: () => ({
      consumerRunning: running && !stopped, inboundHealthy, outboundHealthy,
      lastFrameAt, lastAcceptedAt, acceptedFrames, rejectedFrames, lastRejection,
    }),
    async send(spaceId, text) {
      if (!text.trim()) throw new Error('Cannot send an empty Photon message.');
      const space = await resolveOwnerSpace(spaceId);
      try {
        const sent = await deadline(space.send(text), 30_000);
        if (!sent?.id) throw new Error('Photon did not acknowledge the text message.');
        outboundHealthy = true;
      } catch {
        outboundHealthy = false;
        logger?.error('Photon text send failed or was not acknowledged.');
        throw new Error('Photon text send failed or was not acknowledged; delivery is uncertain.');
      }
    },
    async responding<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
      const space = await resolveOwnerSpace(spaceId);
      // Bound provider typing calls independently; never time out/replay the
      // application's callback, whose own dependencies enforce their deadlines.
      const startingTyping = space.startTyping();
      try {
        await deadline(startingTyping, 5_000);
      } catch {
        outboundHealthy = false;
        // A non-abortable typing-start call may settle after our main cleanup.
        // Clear that late signal too, without invoking application work again.
        void startingTyping.then(() => deadline(space.stopTyping(), 5_000)).catch(() => undefined);
        logger?.warn('Photon typing indicator unavailable; processing the owner request.');
      }
      try { return await fn(); }
      finally { await deadline(space.stopTyping(), 5_000).catch(() => undefined); }
    },
    run() {
      assertOpen();
      if (runPromise) return runPromise;
      running = true;
      logger?.info('Photon owner-only message consumer started.');
      runPromise = (async () => {
        try {
          // Await every callback: owner actions retain delivery order. Durable
          // deduplication/transactions belong to the callback's database layer.
          for await (const [space, message] of im.messages) {
            if (stopped) break;
            lastFrameAt = new Date().toISOString();
            const rejection = inboundRejectionReason(config.ownerHandle, space, message);
            if (rejection) {
              rejectedFrames++;
              lastRejection = rejection;
              logger?.info(`Photon inbound frame rejected (${rejection}).`);
              continue;
            }
            acceptedFrames++;
            lastAcceptedAt = lastFrameAt;
            logger?.info('Photon owner inbound frame accepted.');
            if (space.phone) servingPhones.set(space.id, space.phone);
            inboundHealthy = true;
            await onMessage({
              providerMessageId: message.id,
              spaceId: space.id,
              senderHandle: message.sender!.id,
              text: inboundPlainText(message.content)!,
              receivedAt: message.timestamp,
            });
          }
          if (!stopped) throw new Error('Photon message stream ended unexpectedly.');
        } catch {
          inboundHealthy = false;
          if (!stopped) {
            logger?.error('Photon inbound consumer failed; restart after checking application and provider health.');
            throw new Error('Photon inbound consumer failed.');
          }
        } finally {
          running = false;
        }
      })();
      return runPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      inboundHealthy = false;
      outboundHealthy = false;
      stopPromise = deadline(app.stop(), 20_000).then(async () => {
        // Let the current owner transaction finish before the caller closes DB.
        if (runPromise) await deadline(runPromise, 20_000).catch(() => undefined);
        logger?.info('Photon transport stopped.');
      }).catch(() => {
        throw new Error('Photon transport shutdown failed.');
      });
      return stopPromise;
    },
  };
  return transport;
}
