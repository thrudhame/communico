import {
  booleanParameter,
  enumParameter,
  integerParameter,
  objectParameter,
  requiredParameter,
  stringParameter,
} from '#engine/operation.ts';

export function decodeTypingRequest(raw: unknown) {
  const body = objectParameter(raw, 'body');
  return {
    typing: requiredParameter(
      booleanParameter(body.typing, 'typing'),
      'typing',
    ),
    timeout: integerParameter(body.timeout, 'timeout', 0),
  };
}

export function decodePresenceRequest(raw: unknown) {
  const body = objectParameter(raw, 'body');
  return {
    presence: requiredParameter(
      enumParameter(body.presence, 'presence', [
        'online',
        'offline',
        'unavailable',
      ]),
      'presence',
    ),
    status: stringParameter(body.status_msg, 'status_msg'),
  };
}
