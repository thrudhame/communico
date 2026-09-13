import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { HttpError } from '@pathfinder/pathfinder';

// Malformed JSON bodies are a client fault, not a 500: pre-parse here and
// map SyntaxError to Matrix's 400 M_NOT_JSON before any handler runs.
// Reading the body memoizes it, so handlers' parseJson() re-parses from
// cache. disableStreaming forfeits the streaming contract for this subtree.
// Miss dispatches honor directory middleware body access, so this runs on
// hits, misses, and wrong-methods alike.
//
// Empty bodies are skipped: a POST with Content-Length: 0 carries a
// non-null empty stream — Matrix endpoints like /logout ignore the body
// entirely, so an empty body is not M_NOT_JSON.
export const disableStreaming = true;

export default async function (request: PathfinderRequest, context: Context) {
  void context;
  if (request._raw.body === null) return;
  const text = await request.body.text();
  if (text.trim() === '') return;
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, {
        errcode: 'M_NOT_JSON',
        error: 'Content not JSON.',
      });
    }
    throw error;
  }
}


