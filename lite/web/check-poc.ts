// L2 headless check (phase-l2 step 3): sign in, send two messages, assert
// (1) both bodies in the timeline, (2) every timeline row's $<hash> id
// appears in the log pane's commit lines, (3) the log pane gained exactly 2
// new `event … m.room.message` lines. Prints observed values; exit 0/1.
/// <reference lib="dom" />
// (dom lib: the page.evaluate callbacks below type-check as browser code)
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
let ok = true;
const fail = (msg: string) => { ok = false; console.error("ASSERT-FAIL:", msg); };

try {
  const page = await browser.newPage(`${BASE}/`);

  // --- sign in (nominal): MS2 join screen — solo flow = Create room ---
  await page.evaluate(() => {
    (document.getElementById("name") as HTMLInputElement).value = "poc-tester";
    (document.getElementById("room-name") as HTMLInputElement).value = "poc-solo";
    document.getElementById("create-btn")!.click();
  });
  const upDeadline = Date.now() + 30_000;
  let signedIn = false;
  while (Date.now() < upDeadline) {
    signedIn = await page.evaluate(() =>
      !document.getElementById("room")!.classList.contains("hidden"));
    if (signedIn) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!signedIn) {
    console.error("ASSERT-FAIL: room UI never appeared after sign-in");
    Deno.exit(1);
  }
  const who = await page.evaluate(() => (globalThis as any).__room?.self);
  console.log("signed in as:", who);

  const msgLineCount = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#doltlog .commit")]
        .filter((d) => /event \$\S+ type m\.room\.message/.test(d.textContent ?? ""))
        .length);

  const baseline = await msgLineCount();
  console.log("log pane m.room.message commit lines at baseline:", baseline);

  // --- send two messages ---
  for (const body of ["first poc message", "second poc message"]) {
    await page.evaluate((b) => {
      (document.getElementById("msg") as HTMLInputElement).value = b;
      document.getElementById("send")!.click();
    }, { args: [body] });
    // wait until this body renders in the timeline
    const dl = Date.now() + 30_000;
    let seen = false;
    while (Date.now() < dl) {
      seen = await page.evaluate((b2) =>
        (document.getElementById("timeline")?.textContent ?? "").includes(b2), { args: [body] });
      if (seen) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!seen) fail(`timeline never showed '${body}'`);
  }

  // small settle: log pane refreshes in the same task as the timeline
  await new Promise((r) => setTimeout(r, 500));

  // --- assertion 1: both bodies appear in the timeline ---
  const timelineText = await page.evaluate(() =>
    document.getElementById("timeline")?.textContent ?? "");
  console.log("timeline contains 'first poc message':", timelineText.includes("first poc message"));
  console.log("timeline contains 'second poc message':", timelineText.includes("second poc message"));
  if (!timelineText.includes("first poc message")) fail("body 1 missing from timeline");
  if (!timelineText.includes("second poc message")) fail("body 2 missing from timeline");

  // --- assertion 2 (MS1 identity model): every timeline row's $<content-hash>
  // id appears in the log pane's commit lines (commit messages embed the full
  // event id; the commit hash itself is the local receipt) ---
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#timeline .msg")].map((d) =>
      (d as HTMLElement).dataset.eventId ?? ""));
  const logText = await page.evaluate(() =>
    document.getElementById("doltlog")?.textContent ?? "");
  console.log("timeline rows (event ids):", JSON.stringify(rows));
  for (const id of rows) {
    if (!/^\$[A-Za-z0-9_-]{43}$/.test(id)) { fail(`row id not a content-hash wire id: ${id}`); continue; }
    if (!logText.includes(id)) fail(`event id ${id} missing from log pane`);
  }
  console.log("all timeline event ids present in log pane:", rows.every((id) => logText.includes(id)));

  // --- assertion 3: log pane gained exactly 2 new event m.room.message lines ---
  const after = await msgLineCount();
  console.log("log pane m.room.message commit lines after sends:", after, `(delta ${after - baseline})`);
  if (after - baseline !== 2) fail(`expected exactly 2 new message commit lines, got ${after - baseline}`);

  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server?.kill();
}
