import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createPhotonTransport } from '../src/photon/client.js';

// Deliberately independent of the full application's DB/OpenAI/GitHub config.
const projectId = process.env.SPECTRUM_PROJECT_ID ?? '';
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET ?? '';
const ownerHandle = process.env.ADMIN_IMESSAGE_HANDLE ?? '';
const servingPhone = process.env.SPECTRUM_IMESSAGE_PHONE || undefined;
const required = [
  ['SPECTRUM_PROJECT_ID', projectId], ['SPECTRUM_PROJECT_SECRET', projectSecret],
  ['ADMIN_IMESSAGE_HANDLE', ownerHandle],
] as const;
const missing = required.filter(([, value]) => !value.trim()).map(([name]) => name);
if (missing.length) {
  console.error(`Missing Photon setup variables: ${missing.join(', ')}. Add them to .env; do not paste secrets into chat.`);
  process.exitCode = 1;
} else {
  const challenge = `deadline-demon-check-${randomBytes(4).toString('hex')}`;
  let confirmed = false;
  let finishing = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  try {
    const transport = await createPhotonTransport({ projectId, projectSecret, ownerHandle, servingPhone }, async (message) => {
      if (message.text.trim() !== challenge || finishing) return;
      finishing = true;
      await transport.responding(message.spaceId, async () => {
        await transport.send(message.spaceId, `Deadline Demon diagnostic: received ${challenge} and sent this real iMessage response. No contract was created.`);
      });
      confirmed = true;
      console.log('PASS: the configured owner text was received and Photon acknowledged the diagnostic response. Verify that response appears on your phone.');
      finish();
    });
    const shutdown = () => { finish(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    const timeout = setTimeout(() => {
      console.error('FAIL: no successful owner round trip within 3 minutes. Check the registered project user, project line, exact owner handle, and connectivity.');
      finish();
    }, 180_000);
    const consumer = transport.run().catch(() => {
      console.error('FAIL: Photon message consumer stopped before the diagnostic completed.');
      finish();
    });
    console.log('Photon authenticated. This is a real messaging diagnostic.');
    console.log(`From your configured owner iMessage account, text this exact challenge to your Photon project line: ${challenge}`);
    console.log('Waiting up to 3 minutes. No OpenAI key, GitHub token, or PostgreSQL database is needed for this check.');
    try { await finished; }
    finally {
      clearTimeout(timeout);
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await transport.stop();
      await consumer;
    }
    if (!confirmed) process.exitCode = 1;
  } catch (error) {
    // Only adapter-authored fixed messages contain an approved scalar code.
    const diagnostic = error instanceof Error ? error.message.match(/Photon initialization failed \((timeout|unknown|grpc_\d{1,2}|http_\d{3}|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UNAUTHENTICATED|PERMISSION_DENIED|UNAVAILABLE)\)/)?.[1] : undefined;
    console.error(`FAIL: Photon diagnostic could not initialize or finish${diagnostic ? ` (${diagnostic})` : ''}. Check credentials, the enabled iMessage service, and network access. No secret values were logged.`);
    process.exitCode = 1;
  }
}
