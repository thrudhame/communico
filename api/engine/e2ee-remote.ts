// Pure validation shared by origin queries and the stream-anchored cache.
import { keyView } from '#engine/e2ee-key-view.ts';
import {
  type PublicSigning,
  publicSigning,
} from '#engine/e2ee-public-signing.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
  validateUpload,
} from '#engine/tenant/e2ee.ts';

/** Causal identifiers compare by normalized equality, never arithmetic order. */
export function deviceStreamId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d{1,128}$/.test(value)) {
    return value.replace(/^0+(?=\d)/, '');
  }
  throw new Error('invalid device stream identifier');
}

export function publicDeviceKey(
  raw: unknown,
  user: string,
  id: string,
  limits: KeyLimits,
  requester = '',
): Json {
  const key = object(raw, 'device key');
  const input = validateUpload(
    {
      device_keys: {
        ...key,
        signatures: key.signatures === undefined ? {} : key.signatures,
      },
    },
    user,
    id,
    limits,
  );
  return keyView(JSON.parse(input.device!), user, requester);
}

export type DeviceDelta = {
  user: string;
  id: string;
  stream: string;
  prev: string[];
  key: Json | null;
  deleted: boolean;
};
function entry(raw: unknown, user: string, limits: KeyLimits, reset = false) {
  const value = object(raw, 'device');
  if (
    typeof value.device_id !== 'string' || (!value.device_id.length && !reset)
  ) {
    throw new Error('invalid device ID');
  }
  if (
    value.device_display_name !== undefined &&
    typeof value.device_display_name !== 'string'
  ) throw new Error('invalid device name');
  const key = value.keys === undefined
    ? null
    : publicDeviceKey(value.keys, user, value.device_id, limits);
  if (key !== null) {
    const unsigned = {
      ...object(key.unsigned === undefined ? {} : key.unsigned, 'unsigned'),
    };
    delete unsigned.device_display_name;
    if (value.device_display_name !== undefined) {
      unsigned.device_display_name = value.device_display_name;
    }
    key.unsigned = unsigned;
    bounded(key, limits.maxkeybytes);
  }
  return { id: value.device_id, key };
}
export function deviceDelta(raw: unknown, limits: KeyLimits): DeviceDelta {
  bounded(raw, limits.maxrequestbytes);
  const value = object(raw, 'device update');
  if (typeof value.user_id !== 'string' || !/^@[^:]+:.+$/.test(value.user_id)) {
    throw new Error('invalid user ID');
  }
  if (value.deleted !== undefined && typeof value.deleted !== 'boolean') {
    throw new Error('invalid deletion');
  }
  const prev = value.prev_id === undefined ? [] : value.prev_id;
  if (!Array.isArray(prev)) throw new Error('invalid predecessors');
  limitEntries(prev.length, limits.maxkeys);
  return {
    user: value.user_id,
    ...entry(
      value,
      value.user_id,
      limits,
      value.deleted === true && prev.length === 0 && value.keys === undefined,
    ),
    stream: deviceStreamId(value.stream_id),
    prev: [...new Set(prev.map(deviceStreamId))],
    deleted: value.deleted === true,
  };
}
export type DeviceSnapshot = {
  user: string;
  stream: string;
  devices: { id: string; key: Json | null }[];
  signing: PublicSigning;
};
export function remoteDeviceSnapshot(
  raw: unknown,
  user: string,
  limits: KeyLimits,
): DeviceSnapshot {
  bounded(raw, limits.maxrequestbytes);
  const value = object(raw, 'device snapshot');
  if (value.user_id !== user || !Array.isArray(value.devices)) {
    throw new Error('invalid snapshot owner/devices');
  }
  limitEntries(value.devices.length, limits.maxkeys);
  const devices = value.devices.map((d) => entry(d, user, limits));
  if (new Set(devices.map((d) => d.id)).size !== devices.length) {
    throw new Error('duplicate snapshot device');
  }
  const signing = publicSigning(value, user, limits);
  limitEntries(devices.length + Object.keys(signing).length, limits.maxkeys);
  return {
    user,
    stream: deviceStreamId(value.stream_id),
    devices,
    signing,
  };
}
