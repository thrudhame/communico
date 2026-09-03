// v1b demo-level check for the DOLLT-NATIVE sync mode (default; ?sync=dolt
// pinned explicitly so this check never silently follows a future default
// change). Same choreography as check-msync — late-peer bootstrap, create/
// join, cross-send both ways, paused concurrent sends, convergence — but the
// heal is store-level (fetch + driver merge), so there is NO fork indicator
// and NO 2-prev heal event: convergence is certified by EQUAL TABLE HASHES
// and identical timelines. Also asserts the sync badge reads 'dolt'.
// Exit 0 iff all steps pass.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";

const BASE = "http://localhost:8787";
const ROOM = "dsync-check";
const URL_Q = `${BASE}/?sync=dolt`;

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

type Page = any;
let ok = true;
const fail = (msg: string) => { ok = false; console.error("ASSERT-FAIL:", msg); };

async function waitFor(page: Page, what: string, pred: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let v = "";
  while (Date.now() < deadline) {
    try {
      v = await page.evaluate((p) => String(eval(p)), { args: [pred] });
    } catch { /* page busy */ }
    if (v === "true") return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timeout waiting for: ${what}`);
  return v;
}

const browser = await launch();
try {
  // 0. LATE-PEER: C creates and stays SILENT; D joins ~8 s later and must
  //    bootstrap (want → store → dolt_reset --hard; LB3b form) ≤15 s.
  {
    const LATE = "dsync-late";
    const pageC = await browser.newPage(URL_Q);
    await pageC.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "carol";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("create-btn")!.click();
    }, { args: [LATE] });
    await waitFor(pageC, "C room ready", `!document.getElementById("room").classList.contains("hidden")`, 30_000);
    console.log("late-peer: C created room, staying silent");
    await new Promise((r) => setTimeout(r, 8_000));
    const pageD = await browser.newPage(URL_Q);
    const joinAt = Date.now();
    await pageD.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "dave";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("join-btn")!.click();
    }, { args: [LATE] });
    await waitFor(pageD, "D bootstraps via want→store", `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 15_000);
    console.log(`late-peer: D bootstrapped in ${Date.now() - joinAt} ms (C silent throughout)`);
    await pageC.close();
    await pageD.close();
  }

  // 1. A creates, B joins
  const pageA = await browser.newPage(URL_Q);
  await pageA.evaluate((room) => {
    (document.getElementById("name") as HTMLInputElement).value = "alice";
    (document.getElementById("room-name") as HTMLInputElement).value = room;
    document.getElementById("create-btn")!.click();
  }, { args: [ROOM] });
  await waitFor(pageA, "A room ready", `!document.getElementById("room").classList.contains("hidden")`, 30_000);
  const badgeA = await pageA.evaluate(() => document.getElementById("syncmode")?.textContent ?? "");
  if (badgeA !== "sync: dolt") fail(`sync badge on A: ${JSON.stringify(badgeA)}`);
  else console.log("step 1: A created room; sync badge 'dolt'");

  const pageB = await browser.newPage(URL_Q);
  await pageB.evaluate((room) => {
    (document.getElementById("name") as HTMLInputElement).value = "bob";
    (document.getElementById("room-name") as HTMLInputElement).value = room;
    document.getElementById("join-btn")!.click();
  }, { args: [ROOM] });
  await waitFor(pageB, "B timeline shows genesis (bootstrap via store)",
    `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 30_000);
  await waitFor(pageB, "B badge green", `document.getElementById("convergence")?.classList.contains("ok")`, 15_000);
  console.log("step 1: B joined, genesis visible, badge green");

  const send = (page: Page, body: string) =>
    page.evaluate((b) => {
      (document.getElementById("msg") as HTMLInputElement).value = b;
      document.getElementById("send")!.click();
    }, { args: [body] });
  const timelineHas = (page: Page, body: string) =>
    waitFor(page, `timeline contains '${body}'`,
      `(document.getElementById("timeline")?.textContent ?? "").includes(${JSON.stringify(body)})`, 15_000);

  // 2. cross-send both ways (each delivery = heads → want → store → heal)
  await send(pageA, "hello from alice");
  await timelineHas(pageB, "hello from alice");
  console.log("step 2: alice→bob delivered via dolt pull");
  await send(pageB, "hello from bob");
  await timelineHas(pageA, "hello from bob");
  console.log("step 2: bob→alice delivered via dolt pull");

  // 3. concurrent sends while paused → resume → BOTH converge (store-level
  //    heal; no fork indicator by design)
  await pageA.evaluate(() => (globalThis as any).__syncPause(true));
  await pageB.evaluate(() => (globalThis as any).__syncPause(true));
  await send(pageA, "concurrent-a");
  await send(pageB, "concurrent-b");
  await new Promise((r) => setTimeout(r, 800));
  await pageA.evaluate(() => (globalThis as any).__syncPause(false));
  await pageB.evaluate(() => (globalThis as any).__syncPause(false));
  for (const [p, name] of [[pageA, "A"], [pageB, "B"]] as const) {
    await waitFor(p, `${name} sees concurrent-a`, `(document.getElementById("timeline")?.textContent ?? "").includes("concurrent-a")`, 20_000);
    await waitFor(p, `${name} sees concurrent-b`, `(document.getElementById("timeline")?.textContent ?? "").includes("concurrent-b")`, 20_000);
  }
  console.log("step 3: both timelines show BOTH concurrent messages (healed via store merge)");

  // 4. settle → identical timelines + EQUAL table hashes
  await new Promise((r) => setTimeout(r, 1_500)); // let the gossip settle
  const idsOf = () =>
    [...document.querySelectorAll("#timeline .msg")].map((d) => (d as HTMLElement).dataset.eventId);
  const idsA = await pageA.evaluate(idsOf);
  const idsB = await pageB.evaluate(idsOf);
  const sameTimeline = JSON.stringify(idsA) === JSON.stringify(idsB);
  console.log("step 4: timelines identical:", sameTimeline, `(${idsA.length} rows)`);
  if (!sameTimeline) fail("timelines differ after store heal");
  const readTh = (page: Page) =>
    page.evaluate(async () => {
      const room = (globalThis as any).__room;
      const ev = await room.db.selectValue("SELECT dolt_hashof_table('events')");
      const st = await room.db.selectValue("SELECT dolt_hashof_table('state')");
      return `${ev}/${st}`;
    });
  const thAStr = await readTh(pageA);
  const thBStr = await readTh(pageB);
  console.log("step 4: table hashes — A:", thAStr, "B:", thBStr);
  if (thAStr !== thBStr) fail(`table hashes differ: A=${thAStr} B=${thBStr}`);
  else console.log("step 4: TABLE HASHES EQUAL ✓ (Merkle-certified convergence, dolt-native)");

  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  try { server?.kill(); } catch { /* already dead */ }
}
