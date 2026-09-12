export const auth = false;

// GET /_matrix/client/v3/register — UIA flows (no auth). F1 advertises
// the dummy flow (password arrives in the POST body and is argon2id-hashed
// at completion).
// deno-lint-ignore require-await
export default async function () {
  return { flows: [{ stages: ['m.login.dummy'] }] };
}
