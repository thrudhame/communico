import { config } from '#engine/config.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { bounded, object } from '#engine/tenant/e2ee.ts';
import { validateMessages } from '#engine/tenant/todevice.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { EduState } from '#engine/federation/edus.ts';

export function registerToDevice(edus: EduState, tenant: Tenant): void {
  edus.register('m.direct_to_device', async (origin, raw) => {
    const limits = config().e2ee;
    let input;
    try {
      const value = object(raw, 'direct-to-device');
      bounded(value, limits.maxrequestbytes);
      if (
        typeof value.sender !== 'string' || !/^@[^:]+:.+$/.test(value.sender) ||
        domainOf(value.sender) !== origin || origin === tenant.serverName ||
        typeof value.type !== 'string' || !value.type.length ||
        typeof value.message_id !== 'string' || !value.message_id.length
      ) return;
      input = {
        sender: value.sender,
        type: value.type,
        id: value.message_id,
        messages: validateMessages({ messages: value.messages }, limits),
      };
    } catch (error) {
      if (error instanceof MatrixError) return; // Invalid wire input is ignored, not accepted work.
      throw error;
    }
    // Persistence/admission errors escape the reliable dispatch boundary. Neither
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
