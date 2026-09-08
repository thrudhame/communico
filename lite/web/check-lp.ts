// LP headless check (phase-lp): three astral pages in ONE browser —
// page 1 = lp-spikes.html (LP1+LP2a lines), pages 2+3 = ?role=a / ?role=b
// (LP3 two-tab spike). Asserts `LP SPIKES: 3/3 PASS` on page 1 (≤45 s) and
// LP3 hash equality across the two role pages; prints everything; exit 0/1.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral@0.5.6";

const BASE = "http://localhost:8787";

async function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/lp-spikes.html`);
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
// LP2C (P-D2 longevity probe) is part of the DEFAULT gate since the
// 0.50.3 upgrade: the upstream stack-overflow fix (dolthub/doltlite#2573)
// means the probe that deterministically hung 0.11.53 (PB4) must now print
// 10/10 GENERATIONS CLEAN. --skip-lp2c keeps the old escape hatch.
const WITH_LP2C = !Deno.args.includes("--skip-lp2c");
try {
  // LP3 pair first so the handshake is up before page 1 observes.
  // Stagger page creation: simultaneous wasm-module compiles contend.
  const pageA = await browser.newPage(`${BASE}/lp-spikes.html?role=a`);
  await new Promise((r) => setTimeout(r, 500));
  const pageB = await browser.newPage(`${BASE}/lp-spikes.html?role=b`);
  await new Promise((r) => setTimeout(r, 500));
  const page1 = await browser.newPage(
    `${BASE}/lp-spikes.html${WITH_LP2C ? "?lp2c=1" : ""}`,
  );

  const deadline = Date.now() + 45_000;
  let mainText = "";
  while (Date.now() < deadline) {
    try {
      mainText = await page1.evaluate(() =>
        document.querySelector("#results")?.textContent ?? "");
    } catch { /* page busy compiling/executing — keep waiting */ }
    if (mainText.includes("LP SPIKES:")) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("---- page1 #results ----");
  console.log(mainText);
  console.log("------------------------");

  const hashOf = async (p: typeof pageA, marker: string) => {
    try {
      const t = await p.evaluate(() => document.querySelector("#results")?.textContent ?? "");
      return t.split("\n").find((l) => l.startsWith(marker)) ?? "(missing)";
    } catch (e) {
      return `(page dead: ${(e as Error).message.slice(0, 60)})`;
    }
  };
  const hashA = await hashOf(pageA, "LP3-HASH-A:");
  const hashB = await hashOf(pageB, "LP3-HASH-B:");
  console.log("---- LP3 role pages ----");
  console.log(hashA);
  console.log(hashB);
  console.log("------------------------");

  const spikesOk = /LP SPIKES: 3\/3 PASS/.test(mainText);
  // LP2C is REQUIRED in the default gate since 0.50.3 (upstream fix landed);
  // --skip-lp2c accepts the page's SKIPPED marker instead.
  const lp2cOk = WITH_LP2C
    ? /LP2C: 10\/10 GENERATIONS CLEAN/.test(mainText)
    : /LP2C: SKIPPED/.test(mainText);
  console.log(
    `LP SPIKES 3/3: ${spikesOk}; LP2C ${WITH_LP2C ? "10/10" : "skip-ack"}: ${lp2cOk}`,
  );
  let ok = spikesOk && lp2cOk;
  const hashEq = hashA.startsWith("LP3-HASH-A: ") && hashA.slice(12) === hashB.slice(12) && hashB.startsWith("LP3-HASH-B: ");
  console.log(`LP3 cross-page hash equality: ${hashEq}`);
  ok = ok && hashEq;
  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  try { server?.kill(); } catch { /* already dead */ }
}
