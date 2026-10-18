# Photon Spectrum Cloud integration

This application uses **Stable Spectrum**, `spectrum-ts` 12.11.0 and its `spectrum-ts/providers/imessage` cloud provider. It does not use Photon 2.0 Beta, the local macOS provider, or legacy SDK calls. A normal Node.js host on Windows/Linux is supported; no Mac is needed.

## Setup

1. Open [Photon dashboard](https://app.photon.codes), select your Spectrum project, and enable iMessage. Project Settings contains the project ID and secret. Save them locally in `.env` as `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`.
2. In that project, open **Users** and add yourself using the phone number or email your iMessage actually sends from. Shared Free/Pro lines require this allowlist entry. Save the same exact handle as `ADMIN_IMESSAGE_HANDLE`; phone numbers must include `+` and country code, without spaces.
3. If the sending handle is unclear, [Photon's debug bot](https://debug.photon.codes) can report it. Its returned handle must match both the project user and the owner configuration.
4. Find the project line in the dashboard. With the diagnostic running, send the printed challenge from your owner account to that line.

Only the two Photon credentials and owner handle are needed for `npm run connectivity`. The diagnostic accepts one unique challenge, sends **one** real diagnostic reply, and stops. It ignores unrelated texts, does not call OpenAI or GitHub, and does not need PostgreSQL. It waits three minutes, then fails explicitly. A provider acknowledgement proves API acceptance; check the reply on your phone to confirm device delivery. It never reports a mocked exchange as success.

## Authorization and routing

Inbound messages must be cloud iMessage, inbound, nonempty plain text, an exact owner sender, and a DM. Plain text inside a native inline reply is supported, with at most four reply wrappers; only the new reply text is processed, never its quoted target. The original outer sender and DM still require authorization. Outbound echoes, groups, attachments, reactions, explicitly non-iMessage services, missing senders, and arbitrary senders are discarded. The callback is awaited for every accepted message, preserving owner action order. The application must still enforce durable sender authorization and provider-message deduplication before state changes.

The SDK's `imessage(app).space.get(spaceId)` constructs a space; it does not independently verify its recipient. Before every send or typing operation, this adapter checks that the stored ID is an exact `any;-;<owner>` or `iMessage;-;<owner>` DM and checks the resolved platform, type, and ID again. It never derives a group, substitutes a recipient, or creates a new chat to work around a failed lookup. Old spaces for a different owner fail closed.

Shared mode and one dedicated line resolve persisted IDs without extra configuration. The serving line from a verified owner inbound event is cached for subsequent operations. With multiple dedicated lines after a restart, provide optional `servingPhone` to the transport (`SPECTRUM_IMESSAGE_PHONE` in the diagnostic), or send a fresh owner DM to populate that cache. Without routing metadata the SDK throws and the adapter fails closed.

## Reliability limits

`run()` consumes the real SDK async stream. `stop()` calls documented `app.stop()` and drains the current owner callback within a bounded shutdown deadline. The transport's `responding()` uses documented `startTyping()` and `stopTyping()` with five-second deadlines and cleanup in `finally`. A typing-start failure still processes the request once. Application work is never raced against a typing timeout or replayed as a fallback. Initialization, space resolution, sends, and shutdown have bounded deadlines. Text send errors and missing acknowledgements reject; there is no success-shaped fallback.

`isReady()` means initialized, consumer started, not stopped, and without an observed inbound or outbound failure. These failure states are separate: an outgoing success cannot erase an inbound failure, and an incoming frame cannot erase an outgoing failure. Spectrum 12.11.0 retries stream errors internally and exposes no public network-connected or heartbeat event; this flag cannot prove current end-to-end delivery or detect a silent network failure. A successful real round trip is the connectivity proof.

`diagnostics()` reports consumer state, separate failure flags, local receipt timestamps for the last SDK frame and last authorized frame, accepted/rejected counts, and the most recent fixed rejection code. A receipt timestamp is not the provider's message timestamp or proof of database persistence. Counts reset after a process restart. A zero frame count after a controlled owner test distinguishes no observed SDK delivery from an application authorization rejection; neither counter can establish why the provider did not deliver. Silence alone is not treated as a disconnection, and no automatic timer restart is used.

Spectrum's cloud provider enables gRPC retry and automatic idempotency internally. Its public `space.send(text)` signature exposes **no caller-controlled stable idempotency key**. One call can use the provider's internal retry protection, but a separate application retry after acknowledgement/crash is a new logical API call and may deliver a duplicate. SDK operations have no public AbortSignal: a send that exceeds its local deadline might still complete. The durable application outbox retries with a limited attempt count, so delivery is **at least once**, and an uncertain timed-out send can duplicate. Database outbox deduplication reduces repeats; it cannot guarantee exactly-once iMessage delivery across that failure window.

The SDK manages reconnection and in-process cursors. Public `app.messages` does not expose a durable application acknowledgement/cursor API. Persist accepted inbound events before business processing; events not yet delivered to the application at process death cannot be guaranteed recoverable through this adapter alone. Use a separately implemented signed webhook inbox if durable provider-to-database recovery is an acceptance requirement.

Diagnostics log fixed operation labels and allowlisted rejection codes only. Provider objects, message content, quoted targets, message/space IDs, contact handles, and secrets are not logged; SDK logging and optional telemetry are disabled by this adapter.

## Verified contract references

- [Official Photon iMessage skill](https://github.com/photon-hq/skills/blob/main/skills/imessage/SKILL.md) and its [Spectrum branch](https://github.com/photon-hq/skills/blob/main/skills/imessage/references/spectrum.md) (skill pins 12.2.0; implementation checked against installed 12.11.0 declarations).
- [Stable/Beta version boundaries](https://photon.codes/docs/llms.txt).
- [Spectrum getting started](https://photon.codes/docs/spectrum-ts/getting-started).
- [iMessage connection and routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).
- [Project user allowlist and exact iMessage handle](https://photon.codes/docs/spectrum-ts/troubleshooting/imessage).
- [Graceful shutdown](https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle).

API/source contract inspected locally: `spectrum-ts@12.11.0`, `@spectrum-ts/core@12.11.0`, and `@spectrum-ts/imessage@12.11.0` declarations and shipped runtime. Mocked tests are exclusively in `tests/`; production and diagnostic paths never use a fake transport.
