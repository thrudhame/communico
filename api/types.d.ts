// Shared module augmentation for pathfinder's open interfaces — endpoint
// handlers read per-request auth state through State.
declare module '@pathfinder/pathfinder' {
  interface State {
    user?: string;
    token?: string;
    device?: string;
  }
}

export {};
