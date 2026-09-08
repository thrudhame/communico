// LB check (lite-v1 Phase B): drives lb-spikes.html headlessly and asserts
// the dolt-native gate — LB SPIKES: 5/5 PASS with LB4 10/10 GENERATIONS
// CLEAN (the #2568 regression watch on the remote path). Prints the page's
// full transcript verbatim. Exit 0/1.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";

const BASE = "http://localhost:8787";

async function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/index.html`);
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

const browser = await launch(
  Deno.env.get("CHROME_PATH") ? { path: Deno.env.get("CHROME_PATH") } : undefined,
); // CHROME_PATH: system Chromium (>=137 for Ed25519) e.g. on test VMs
try {
  const page = await browser.newPage(`${BASE}/lb-spikes.html`);
  const pageErrors: string[] = [];
  page.addEventListener("pageerror", (e) => pageErrors.push(JSON.stringify(e).slice(0, 300)));

  const deadline = Date.now() + 60_000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await page.evaluate(() =>
        document.querySelector("#results")?.textContent ?? "");
    } catch { /* page busy compiling/executing — keep waiting */ }
    if (text.includes("LB SPIKES:")) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("---- lb-spikes #results ----");
  console.log(text);
  console.log("----------------------------");
  console.log("page exceptions:", pageErrors.length, pageErrors);

  const spikesOk = /LB SPIKES: 5\/5 PASS/.test(text);
  const longevityOk = /LB4: 10\/10 GENERATIONS CLEAN/.test(text);
  const noPageErrors = pageErrors.length === 0;
  console.log(`LB SPIKES 5/5: ${spikesOk}; LB4 10/10: ${longevityOk}; no page exceptions: ${noPageErrors}`);
  const ok = spikesOk && longevityOk && noPageErrors;
  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server?.kill();
}
