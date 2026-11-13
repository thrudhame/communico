// Pure validation shared by origin queries and the stream-anchored cache.
import { keyView } from '#engine/e2ee-key-view.ts';
import {
  type PublicSigning,
  publicSigning,
} from '#engine/e2ee-public-signing.ts';
import {
  bounded,
  deviceKey,
  identity,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from '#engine/e2ee-wire.ts';
import { protocol } from '#engine/net/upstream-error.ts';

/** Causal identifiers compare by normalized equality, never arithmetic order. */
export function deviceStreamId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d{1,128}$/.test(value)) {
    return value.replace(/^0+(?=\d)/, '');
  }
  protocol('e2ee-schema', 'invalid device stream identifier');
}

export function publicDeviceKey(
  raw: unknown,
  user: string,
  id: string,
  limits: KeyLimits,
  requester = '',
): Json {
  const key = deviceKey(raw, limits);
  if (key.user_id !== user || key.device_id !== id) {
    identity('remote device key owner does not match requested device');
  }
  return keyView(key, user, requester);
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
    protocol('e2ee-schema', 'invalid device ID');
  }
  if (
    value.device_display_name !== undefined &&
    typeof value.device_display_name !== 'string'
  ) protocol('e2ee-schema', 'invalid device name');
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
    protocol('e2ee-schema', 'invalid user ID');
  }
  if (value.deleted !== undefined && typeof value.deleted !== 'boolean') {
    protocol('e2ee-schema', 'invalid deletion');
  }
  const prev = value.prev_id === undefined ? [] : value.prev_id;
  if (!Array.isArray(prev)) protocol('e2ee-schema', 'invalid predecessors');
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
  if (value.user_id !== user) identity('invalid snapshot owner');
  if (!Array.isArray(value.devices)) {
    protocol('e2ee-schema', 'invalid snapshot devices');
  }
  limitEntries(value.devices.length, limits.maxkeys);
  const devices = value.devices.map((d) => {
    if (object(d, 'snapshot device').keys === undefined) {
      protocol('e2ee-schema', 'snapshot device keys are required');
    }
    return entry(d, user, limits);
  });
  if (new Set(devices.map((d) => d.id)).size !== devices.length) {
    protocol('e2ee-schema', 'duplicate snapshot device');
  }
  // Deployed Synapse /user/devices replies use null for absent signing keys.
  // This compatibility is endpoint-specific, not an upload/query/EDU default.
  const signing = publicSigning(
    {
      master_key: value.master_key === null ? undefined : value.master_key,
      self_signing_key: value.self_signing_key === null
        ? undefined
        : value.self_signing_key,
    },
    user,
    limits,
  );
  limitEntries(devices.length + Object.keys(signing).length, limits.maxkeys);
  return {
    user,
    stream: deviceStreamId(value.stream_id),
    devices,
    signing,
  };
}
