import { MatrixError } from '#engine/matrix-error.ts';
import {
  booleanParameter,
  enumParameter,
  objectParameter,
  requiredParameter,
  stringParameter,
} from '#engine/operation.ts';
import { checkLocalpart } from './users.ts';

function deviceOptions(body: Record<string, unknown>) {
  return {
    deviceId: stringParameter(body.device_id, 'device_id'),
    displayName: stringParameter(
      body.initial_device_display_name,
      'initial_device_display_name',
    ),
    refresh: booleanParameter(body.refresh_token, 'refresh_token') ?? false,
  };
}

export function decodeRegistrationRequest(
  raw: unknown,
  query: URLSearchParams,
) {
  const kind =
    enumParameter(query.get('kind') ?? undefined, 'kind', ['user', 'guest']) ??
      'user';
  if (kind === 'guest') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Guest registration is disabled');
  }
  const body = objectParameter(raw, 'body');
  return {
    body,
    localpart: body.username === undefined
      ? undefined
      : checkLocalpart(body.username),
    password: stringParameter(body.password, 'password'),
    inhibit: booleanParameter(body.inhibit_login, 'inhibit_login') ?? false,
    ...deviceOptions(body),
  };
}

export function decodeLoginRequest(raw: unknown) {
  const body = objectParameter(raw, 'body');
  if (body.type !== 'm.login.password') {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'expected m.login.password');
  }
  let user = body.user;
  if (body.identifier !== undefined) {
    const identifier = objectParameter(body.identifier, 'identifier');
    if (identifier.type !== 'm.id.user') {
      throw new MatrixError(
        400,
        'M_BAD_REQUEST',
        'unsupported identifier type',
      );
    }
    user = identifier.user;
  }
  if (typeof user !== 'string' || typeof body.password !== 'string') {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'user + password required');
  }
  return { user, password: body.password, ...deviceOptions(body) };
}

export function decodePasswordRequest(raw: unknown) {
  const body = objectParameter(raw, 'body');
  const password = requiredParameter(
    stringParameter(body.new_password, 'new_password'),
    'new_password',
  );
  if (password.length === 0) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'new_password required');
  }
  return {
    body,
    password,
    logoutDevices: booleanParameter(body.logout_devices, 'logout_devices') ??
      true,
  };
}
