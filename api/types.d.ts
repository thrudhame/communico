// Shared module augmentation for pathfinder's open interfaces — endpoint
// handlers read per-request auth state through State, and route-level
// named exports are typed through Meta.
declare module '@pathfinder/pathfinder' {
  interface State {
    user?: string;
    token?: string;
  }
  interface Meta {
    /** Route opt-out for the 20-auth middleware (`export const auth = false`). */
    auth?: boolean;
  }
}

export {};
