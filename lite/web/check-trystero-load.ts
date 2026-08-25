// MS4 step 5.1 — Trystero LOAD smoke (astral). The trystero code path
// must never ship unexecuted again (F-D1 process rule): network BEHAVIOR
// stays human-gated (NO assertions about peer connectivity or relays —
// dead public relays logging console errors are EXPECTED and ignored),
// but loading + Create must work. Asserts within 20 s: room view
// revealed, #status has no 'failed:', no page EXCEPTIONS (astral's
// 'pageerror' listener — console noise is NOT captured by it, recorded),
// and window.__ms exists with peers() callable. Exit 0/1.
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

const browser = await launch();
let ok = true;
const fail = (msg: string) => { ok = false; console.error("ASSERT-FAIL:", msg); };
const pageErrors: string[] = [];

try {
  const page = await browser.newPage(`${BASE}/?transport=trystero`);
  // astral mechanism for page exceptions: the 'pageerror' event (console.*
  // noise from dead public relays is a different channel and is ignored).
  page.addEventListener("pageerror", (e) => {
    pageErrors.push(JSON.stringify(e).slice(0, 300));
  });

  await page.evaluate(() => {
    (document.getElementById("name") as HTMLInputElement).value = "load-tester";
    (document.getElementById("room-name") as HTMLInputElement).value = "ms4-load";
    document.getElementById("create-btn")!.click();
  });

  const deadline = Date.now() + 20_000;
  let revealed = false;
  while (Date.now() < deadline) {
    try {
      revealed = await page.evaluate(() =>
        !document.getElementById("room")!.classList.contains("hidden"));
    } catch { /* busy */ }
    if (revealed) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("room view revealed:", revealed);
  if (!revealed) fail("room view never revealed after Create (20s)");

  const status = await page.evaluate(() =>
    document.getElementById("status")?.textContent ?? "");
  console.log("status text:", JSON.stringify(status));
  if (status.includes("failed:")) fail(`status shows failure: ${status}`);

  // __ms lands after startMsync resolves (trystero module load + joinRoom),
  // which trails the (MS4-intentional) early reveal — poll within budget.
  let msState = "missing";
  const msDeadline = Date.now() + 20_000;
  while (Date.now() < msDeadline) {
    msState = await page.evaluate(() => {
      const ms = (globalThis as any).__ms;
      if (!ms) return "missing";
      try {
        const p = ms.peers();
        return Array.isArray(p) ? `callable (peers: ${p.length})` : "not-callable-shape";
      } catch (e) {
        return "throws: " + (e as Error).message;
      }
    });
    if (msState.startsWith("callable")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("window.__ms.peers():", msState);
  if (!msState.startsWith("callable")) fail(`__ms.peers() not usable within 20s: ${msState}`);

  console.log("page exceptions captured (pageerror):", pageErrors.length, pageErrors);
  if (pageErrors.length) fail("page exceptions recorded");

  // Scenario 2 (MS5): NO ?transport= param on localhost — the badge must
  // read 'broadcast' (regression-pins the public-URL default logic; CI
  // stays network-free).
  {
    const page2Errors: string[] = [];
    const page2 = await browser.newPage(`${BASE}/`);
    page2.addEventListener("pageerror", (e) => page2Errors.push(JSON.stringify(e).slice(0, 200)));
    await page2.evaluate(() => {
      (document.getElementById("name") as HTMLInputElement).value = "default-tester";
      (document.getElementById("room-name") as HTMLInputElement).value = "ms5-default";
      document.getElementById("create-btn")!.click();
    });
    const d2 = Date.now() + 20_000;
    let badge = "";
    while (Date.now() < d2) {
      try {
        badge = await page2.evaluate(() =>
          document.getElementById("transport")?.textContent ?? "");
      } catch { /* busy */ }
      if (/transport: (broadcast|trystero)/.test(badge)) break; // placeholder is 'transport: —'
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log("no-param localhost transport badge:", JSON.stringify(badge));
    if (!badge.includes("broadcast")) fail(`expected broadcast default on localhost, got: ${badge}`);
    if (page2Errors.length) fail("page2 exceptions: " + page2Errors.join(" | "));
    await page2.close();
    console.log("scenario 2 (no-param default → broadcast):", page2Errors.length === 0 && badge.includes("broadcast") ? "ok" : "FAILED");
  }

  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  try { server?.kill(); } catch { /* already dead */ }
}
