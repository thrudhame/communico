// MS0 headless check (phase-ms0): one page, wait ≤45 s for the final
// `MS0: n/3 PASS` line; assert 3/3 AND the vectors line PASS; print the
// full transcript; exit 0/1.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";

const BASE = "http://localhost:8787";

async function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/ms-spikes.html`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let server: Deno.ChildProcess | undefined;
if (!(await waitForServer(1_000))) {
  server = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", new URL("./serve.ts", import.meta.url).pathname],
    stdout: "null",
    stderr: "null",
  }).spawn();
  if (!(await waitForServer())) {
    console.error("server did not come up on :8787");
    Deno.exit(1);
  }
}

const browser = await launch();
try {
  const page = await browser.newPage(`${BASE}/ms-spikes.html`);
  const deadline = Date.now() + 45_000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await page.evaluate(() =>
        document.querySelector("#results")?.textContent ?? "");
    } catch { /* page busy in a sync wasm block — keep polling */ }
    if (text.includes("MS0:")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("---- ms-spikes #results ----");
  console.log(text);
  console.log("----------------------------");
  const ok = /MS0: 3\/3 PASS/.test(text) && /MS0-VECTORS: PASS/.test(text);
  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL (expected 'MS0: 3/3 PASS' + vectors)");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  try { server?.kill(); } catch { /* already dead */ }
}
