// Shared module augmentation for pathfinder's open interfaces — endpoint
// handlers read per-request auth state through State.
import type { Tenant } from '#engine/tenant/index.ts';

declare module '@pathfinder/pathfinder' {
  interface State {
    tenant?: Tenant;
    user?: string;
    token?: string;
    device?: string;
    // X-Matrix federation: the verified origin server name
    origin?: string;
  }
}

export {};
