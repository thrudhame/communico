// lite/web/serve.ts — tiny static server for the DoltLite WASM spikes/POC.
// Adds COOP/COEP (cross-origin isolation) so the wasm package's OPFS VFS is
// available; without these headers the page still runs but OPFS is absent.
// Usage: deno run --allow-net --allow-read lite/web/serve.ts  (port 8787)
const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(Deno.args[0] ?? 8787);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
};

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = ROOT + path.replace(/^\/+/, "");
  if (!file.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
  try {
    const data = await Deno.readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store", // dev/test server: never serve stale modules
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
console.log(`serving ${ROOT} on http://localhost:${PORT}/ (COOP/COEP on)`);
