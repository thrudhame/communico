// demo/check-browser-peer.ts — the Carol leg of the three-party demo
// (plan §3 step 12). One astral page joins the demo room via the lite
// hat (?transport=ws&sync=msync), bootstraps the alice/bob history via
// delta, sends a nonce, and proves the server applied it (event_index
// receipt). Prints BOB_ID / CAROL_ID / NONCE for run-demo.sh to
// cross-check against matrix-commander's view. Exit 0 iff all pass.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";
import pgpkg from "pg";

const [ROOM_ID, BOB_BODY] = [Deno.args[0], Deno.args[1]];
if (!ROOM_ID || !BOB_BODY) {
  console.error("usage: check-browser-peer.ts <roomId> <bobBody>");
  Deno.exit(2);
}
const BASE = "http://localhost:8787";
const ID_SHAPE = /^\$[A-Za-z0-9_-]{43}$/;

let ok = true;
const fail = (msg: string) => { ok = false; console.error("ASSERT-FAIL:", msg); };

// deno-lint-ignore no-explicit-any
type Page = any;
async function waitFor(page: Page, what: string, pred: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let v = "";
  while (Date.now() < deadline) {
    try {
      v = await page.evaluate((p: string) => String(eval(p)), { args: [pred] });
    } catch { /* page busy */ }
    if (v === "true") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timeout waiting for: ${what}`);
}

async function idOfRowContaining(page: Page, body: string): Promise<string> {
  return await page.evaluate((b: string) => {
    const rows = [...document.querySelectorAll("#timeline .msg")];
    const row = rows.find((r) => r.textContent?.includes(b));
    return (row as HTMLElement | undefined)?.dataset.eventId ?? "missing";
  }, { args: [body] });
}

// the lite page is served from the container (demo/setup.sh publishes :8787)
try {
  const r = await fetch(`${BASE}/index.html`);
  if (!r.ok) throw new Error(String(r.status));
} catch {
  console.error("lite page not served on :8787 — run demo/setup.sh first");
  Deno.exit(1);
}

const browser = await launch(
  Deno.env.get("CHROME_PATH") ? { path: Deno.env.get("CHROME_PATH") } : undefined,
); // CHROME_PATH: system Chromium (>=137 for Ed25519) e.g. on test VMs
try {
  const page = await browser.newPage(
    `${BASE}/?transport=ws&sync=msync&room=${encodeURIComponent(ROOM_ID)}`,
  );
  // the room-name field is prefilled from ?room= (app.js); just name + join
  await page.evaluate(() => {
    (document.getElementById("name") as HTMLInputElement).value = "carol";
    document.getElementById("join-btn")!.click();
  });

  // bootstrap: full history via the delta protocol, genesis first
  await waitFor(page, "Carol bootstraps server history",
    `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 30_000);
  await waitFor(page, "Carol's timeline contains bob's Act-1 message",
    `(document.getElementById("timeline")?.textContent ?? "").includes(${JSON.stringify(BOB_BODY)})`, 15_000);
  console.log("carol: bootstrapped the server room's history via delta ✓");

  const bobId = await idOfRowContaining(page, BOB_BODY);
  if (!ID_SHAPE.test(bobId)) fail(`bob's id in Carol's timeline not a content-hash id: ${bobId}`);
  console.log(`BOB_ID=${bobId}`);

  // Carol sends a nonce into the server room
  const nonce = `carol-${Date.now()}`;
  await page.evaluate((b: string) => {
    (document.getElementById("msg") as HTMLInputElement).value = b;
    document.getElementById("send")!.click();
  }, { args: [nonce] });
  await waitFor(page, "Carol's own nonce renders",
    `(document.getElementById("timeline")?.textContent ?? "").includes(${JSON.stringify(nonce)})`);
  const carolId = await idOfRowContaining(page, nonce);
  if (!ID_SHAPE.test(carolId)) fail(`Carol's id not a content-hash id: ${carolId}`);
  console.log(`CAROL_ID=${carolId}`);
  console.log(`NONCE=${nonce}`);

  // end-of-chain: the server applied Carol's event (lite hat ingestRemote
  // → core ingest → event_index receipt), observed on the server itself
  const c = new pgpkg.Client({
    host: "127.0.0.1", port: 5432, user: "root", password: "secret", database: "postgres",
  });
  await c.connect();
  const deadline = Date.now() + 15_000;
  let landed = false;
  while (Date.now() < deadline) {
    const r = await c.query(
      "SELECT 1 FROM event_index WHERE room_id = $1 AND event_id = $2;",
      [ROOM_ID, carolId],
    );
    if (r.rows.length) { landed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  await c.end();
  if (!landed) fail("server never applied Carol's event (no event_index row)");
  else console.log("carol: server applied her event via the lite hat ✓");

  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
