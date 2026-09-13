import project from '#root/deno.json' with { type: 'json' };

// GET / on the Matrix listener — the tagline (was a special case in main.ts).
// deno-lint-ignore require-await
export default async function () {
  return `${project.name}: ${project.description}.`;
}
