import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { HttpError } from '@pathfinder/pathfinder';

// Malformed JSON bodies are a client fault, not a 500: pre-parse here and
// map both fault classes to Matrix's 400 M_NOT_JSON before any handler
// runs — invalid UTF-8 (a fatal TextDecoder over body.bytes(); the
// Complement A8 rule that non-fatal text() cannot detect) and invalid
// JSON structure (JSON.parse → SyntaxError). bytes() is memoized
// (pathfinder 0.2.2), so handlers' parseJson() re-reads the body after.
//
// Empty bodies are skipped: a POST with Content-Length: 0 carries an
// empty body — Matrix endpoints like /logout ignore the body entirely,
// so an empty body is not M_NOT_JSON. Miss dispatches honor directory
// middleware body access, so this runs on hits, misses, and
// wrong-methods alike. disableStreaming forfeits the streaming contract
// for this subtree.
export const disableStreaming = true;

export default async function (request: PathfinderRequest, _context: Context) {
  const bytes = await request.body.bytes();
  if (bytes.length === 0) return; // empty body: not M_NOT_JSON (logout etc.)
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, {
      errcode: 'M_NOT_JSON',
      error: 'Content not JSON.',
    });
  }
  if (text.trim() === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, {
        errcode: 'M_NOT_JSON',
        error: 'Content not JSON.',
      });
    }
    throw error;
  }
  // D9: valid JSON but not an object is a client fault too — 400
  // M_BAD_JSON (Complement TestJson's "invalid numbers" cases arrive as a
  // base64 JSON *string* via WithJSONBody([]byte)). Every client-API
  // request body is an object; binary media upload lives outside
  // _matrix/client/.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, {
      errcode: 'M_BAD_JSON',
      error: 'Content must be a JSON object.',
    });
  }
}
