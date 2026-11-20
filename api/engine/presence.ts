// doltgres presence entry points over the app's server-file stream.
import { theApp } from '#engine/app.ts';
import * as rows from '#engine/server/ephemeral.ts';
export type { PresenceRow } from '#engine/server/ephemeral.ts';
export const setPresence = (
  userId: string,
  presence: string,
  statusMsg?: string,
) => rows.setPresence(theApp().server, userId, presence, statusMsg);
