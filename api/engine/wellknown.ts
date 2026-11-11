import { config } from '#engine/config.ts';
import { HttpError } from '@pathfinder/pathfinder';

export function clientDiscovery() {
  const settings = config().wellknown;
  if (settings.client === '') throw new HttpError(404, 'not found');
  return {
    'm.homeserver': { base_url: settings.client },
    ...(settings.identity === ''
      ? {}
      : { 'm.identity_server': { base_url: settings.identity } }),
  };
}

export function supportDiscovery() {
  const settings = config().wellknown.support;
  const contacts: Record<string, string>[] = [];
  for (const role of ['admin', 'security'] as const) {
    for (const matrix_id of settings[role].mxids) {
      contacts.push({ role: `m.role.${role}`, matrix_id });
    }
    for (const email_address of settings[role].emails) {
      contacts.push({ role: `m.role.${role}`, email_address });
    }
  }
  if (contacts.length === 0 && settings.page === '') {
    throw new HttpError(404, 'not found');
  }
  return {
    ...(contacts.length === 0 ? {} : { contacts }),
    ...(settings.page === '' ? {} : { support_page: settings.page }),
  };
}
