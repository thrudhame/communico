import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { parseJson } from './operation-body.ts';

// Accepted bytes are memoized by Pathfinder. Enforce JSON/UTF-8/root and body
// omission policy before any Matrix handler, including misses and wrong methods.
// Empty is not whitespace: only truly absent bytes gain the empty-object view.
// Shared by client and federation JSON subtrees; raw media stays outside them.
export const disableStreaming = true;

export default async function (request: PathfinderRequest, _context: Context) {
  await parseJson(request);
}
