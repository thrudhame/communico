import { config } from '#engine/config.ts';
import { createHmac } from 'node:crypto';

/** Synapse-compatible coturn REST credentials; no credentials are persisted. */
export function turnServer(user: string) {
  const settings = config().turn;
  if (settings.uris.length === 0 || settings.ttl === 0) return {};
  let username: string;
  let password: string;
  if (settings.secret !== '') {
    username = `${Math.floor(Date.now() / 1000) + settings.ttl}:${user}`;
    password = createHmac('sha1', settings.secret).update(username).digest(
      'base64',
    );
  } else if (settings.username !== '' && settings.password !== '') {
    username = settings.username;
    password = settings.password;
  } else {
    return {};
  }
  return { username, password, ttl: settings.ttl, uris: settings.uris };
}
