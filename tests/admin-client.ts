import { assert } from '@std/assert';

/** Real HTTP over Unix sockets, independently of the production client. */
export async function adminCall(
  path: string,
  operation: string,
  body: unknown = {},
) {
  const output = await new Deno.Command('curl', {
    args: [
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '--unix-socket',
      path,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify(body),
      '-w',
      '\n%{http_code}',
      `http://localhost/v1/${operation}`,
    ],
  }).output();
  assert(output.success, new TextDecoder().decode(output.stderr));
  const raw = new TextDecoder().decode(output.stdout);
  const end = raw.lastIndexOf('\n');
  return {
    status: Number(raw.slice(end + 1)),
    body: JSON.parse(raw.slice(0, end)),
  };
}
