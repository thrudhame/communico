import type { Context } from '@pathfinder/pathfinder';

// Exercise the consumer-visible auth context, without returning secrets.
// deno-lint-ignore require-await
export default async function (_request: unknown, context: Context) {
  return {
    user: context.state.user,
    device: context.state.device,
    tenant: context.state.tenant?.serverName,
  };
}
