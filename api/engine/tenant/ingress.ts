// The composition supplies ingress authority; domain owners enforce it using
// their current connection, before any consuming read or session mutation.
import type { Conn } from '#engine/store/db.ts';

export type AuthIntent =
  | { kind: 'session'; hash: string; refresh: boolean }
  | { kind: 'password'; localpart: string }
  | { kind: 'account'; localpart: string }
  | {
    kind: 'domain' | 'domain-read';
    localpart: string;
    feature?:
      | 'filters'
      | 'openid'
      | 'backups'
      | 'pushers'
      | 'notifications'
      | 'schedules';
  }
  | { kind: 'openid'; hash: string }
  | { kind: 'device'; localpart: string; deviceId: string };

export type PreparedIngressAuthority = {
  check(conn: Conn, intent: AuthIntent): Promise<void>;
};

// Cross-file admission is captured before opening the tenant transaction. The
// prepared check uses only that transaction's connection and local activation.
export type IngressAuthority = PreparedIngressAuthority | {
  prepare(): Promise<PreparedIngressAuthority>;
};
