import { config } from '#engine/config.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { bounded, object } from '#engine/tenant/e2ee.ts';
import { validateMessages } from '#engine/tenant/todevice.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { type EduState, PermanentEduRefusal } from '#engine/federation/edus.ts';

/** Shared F1 retention/home delivery admission. Target expansion belongs only
 * to the receiving home tenant, not to the facade's public replica. */
export function decodeToDevice(origin: string, self: string, raw: unknown) {
  const limits = config().e2ee;
  try {
    const value = object(raw, 'direct-to-device');
    bounded(value, limits.maxrequestbytes);
    if (
      typeof value.sender !== 'string' || !/^@[^:]+:.+$/.test(value.sender) ||
      domainOf(value.sender) !== origin || origin === self ||
      typeof value.type !== 'string' || !value.type.length ||
      typeof value.message_id !== 'string' || !value.message_id.length
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'invalid to-device envelope or sender origin',
      );
    }
    const messages = validateMessages({ messages: value.messages }, limits);
    for (const message of messages) {
      bounded([{
        sender: value.sender,
        type: value.type,
        content: message.content,
      }], limits.maxrequestbytes);
    }
    return {
      sender: value.sender,
      type: value.type,
      id: value.message_id,
      messages,
    };
  } catch (error) {
    if (error instanceof MatrixError) {
      throw new PermanentEduRefusal(error.errcode, error.message);
    }
    throw error;
  }
}

export function registerToDevice(edus: EduState, tenant: Tenant): void {
  edus.register('m.direct_to_device', async (origin, raw) => {
    const limits = config().e2ee;
    const input = decodeToDevice(origin, tenant.serverName, raw);
    // Persistence/queue errors escape the reliable dispatch boundary. Neither
    // logical receipt nor transport success may be published after a failed tx.
    await tenant.tx((tx) =>
      tx.toDevice.receive(
        origin,
        input.id,
        input.sender,
        input.type,
        tenant.serverName,
        input.messages,
        limits,
      )
    );
  }, true);
}
