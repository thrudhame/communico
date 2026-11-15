// The composition supplies ingress authority; domain owners enforce it using
// their current connection, before any consuming read or session mutation.
import type { Conn } from '#engine/store/db.ts';

export type AuthIntent =
  | { kind: 'session'; hash: string; refresh: boolean }
  | { kind: 'password'; localpart: string }
  | { kind: 'device'; localpart: string; deviceId: string };

export type IngressAuthority = {
  check(conn: Conn, intent: AuthIntent): Promise<void>;
};
