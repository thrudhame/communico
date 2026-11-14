// Durable runtime identity is checked before recovery, tenant genesis or any
// worker. Changing a config role/name never repurposes an existing store.
import type { Store } from '#engine/store/index.ts';
import { LinkError } from './protocol.ts';
import { nodeId } from './identity.ts';

export type RoleIdentity = {
  role: 'home' | 'facade';
  server: string;
  node: string;
};

export async function bindRole(
  store: Store,
  identity: RoleIdentity,
): Promise<RoleIdentity & { initialized: boolean }> {
  const node = identity.role === 'facade' ? nodeId(identity.node) : '';
  const tenants = await store.tenants();
  const db = await store.server();
  return await db.tx(async (conn) => {
    const [held] = await conn.query(
      'SELECT * FROM runtime_identity WHERE singleton=1',
    );
    if (held) {
      if (
        held.role !== identity.role || held.server_name !== identity.server ||
        held.node_id !== node
      ) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'runtime role/name/node does not match store',
          403,
        );
      }
      return { ...identity, node, initialized: held.initialized === 1 };
    }
    const [existingNode] = await conn.query(
      'SELECT server_name,node_id FROM facade_node WHERE singleton=1',
    );
    if (
      existingNode &&
      (identity.role !== 'facade' ||
        existingNode.server_name !== identity.server ||
        existingNode.node_id !== node)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'existing facade identity cannot change role/name/node',
        403,
      );
    }
    if (
      tenants.some((name) => name !== identity.server) ||
      (identity.role === 'facade' && tenants.length !== 0 && !existingNode)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'existing tenant is not an independent facade store',
        403,
      );
    }
    await conn.execute(
      'INSERT INTO runtime_identity(singleton,role,server_name,node_id,initialized) VALUES(1,?,?,?,?)',
      [identity.role, identity.server, node, existingNode ? 1 : 0],
    );
    return { ...identity, node, initialized: !!existingNode };
  });
}
