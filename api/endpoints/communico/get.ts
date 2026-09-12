import project from '../../../deno.json' with { type: 'json' };

// GET / on the :8000 listener — the tagline (was a special case in main.ts).
// deno-lint-ignore require-await
export default async function () {
  return `${project.name}: ${project.description}.`;
}
