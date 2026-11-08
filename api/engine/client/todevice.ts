import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { validateMessages } from '#engine/tenant/todevice.ts';

export async function sendToDevice(
  user: string,
  deviceId: string | undefined,
  generation: number | undefined,
  type: string,
  txn: string,
  body: unknown,
): Promise<Record<string, never>> {
  if (deviceId === undefined || generation === undefined) {
    throw new MatrixError(
      400,
      'M_MISSING_PARAM',
      'an authenticated device is required',
    );
  }
  const limits = config().e2ee;
  const messages = validateMessages(body, limits);
  const app = theApp();
  const source = crypto.randomUUID(); // Attempt-independent logical id; never generated inside a retrying tx body.
  await app.tenant.tx((tx) =>
    tx.toDevice.send(
      { localpart: localpartOf(user), deviceId, generation },
      app.tenant.serverName,
      type,
      txn,
      source,
      messages,
      limits,
      {
        enabled: config().federation.enabled,
        maxBytes: config().federation.bulkmaxbytes,
      },
    )
  );
  return {};
}
