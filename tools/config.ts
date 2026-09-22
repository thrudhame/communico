// tools/config.ts — print the merged config as JSON (default) or shell
// exports (`--shell`). The one way non-Deno consumers read config.
import { config, formatShellExports } from '#engine/config.ts';

if (Deno.args.includes('--shell')) {
  Deno.stdout.writeSync(new TextEncoder().encode(formatShellExports(config())));
} else {
  console.log(JSON.stringify(config(), null, 2));
}
