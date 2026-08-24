// L1 headless check: load spikes.html in astral's headless Chrome, wait for
// the results pre to reach its final line, assert 4/4 PASS, print the full
// text, exit 0/1. Requires the server: deno run --allow-net --allow-read
// lite/web/serve.ts  (this script starts it for you if :8787 is closed).
import { launch } from "jsr:@astral/astral";

const BASE = "http://localhost:8787";

async function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/spikes.html`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Start the server unless something already listens on 8787.
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
  const page = await browser.newPage(`${BASE}/spikes.html`);
  const deadline = Date.now() + 30_000;
  let text = "";
  while (Date.now() < deadline) {
    text = await page.evaluate(() =>
      document.querySelector("#results")?.textContent ?? ""
    );
    if (text.includes("WASM SPIKES:")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("---- #results ----");
  console.log(text);
  console.log("------------------");
  const ok = /WASM SPIKES: 4\/4 PASS/.test(text);
  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL (expected 'WASM SPIKES: 4/4 PASS')");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server?.kill();
}
