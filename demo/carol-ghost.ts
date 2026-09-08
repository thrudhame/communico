// demo/carol-ghost.ts — the "ghost in the machine" (plan §13.2.1). A
// headless browser peer that joins a server room via the lite hat
// (?transport=ws&sync=msync), then sends paced messages at wall-clock
// offsets — built from check-browser-peer.ts's scaffolding but with NO
// assertions and NO terminal output (all logging to stdout, redirected
// to /tmp/demo-carol.log by the caller). The ghost is never on camera:
// its messages simply appear in the other participants' panes.
//
// usage: carol-ghost.ts <roomId> <name> <t1> <msg1> <t2> <msg2>
//   t1/t2: seconds from launch (join+bootstrap happens first)
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";
import pgpkg from "pg";

const [ROOM_ID, NAME] = [Deno.args[0], Deno.args[1]];
const T1 = Number(Deno.args[2]);
const MSG1 = Deno.args[3];
const T2 = Number(Deno.args[4]);
const MSG2 = Deno.args[5];
if (!ROOM_ID || !NAME || !T1 || !MSG1 || !T2 || !MSG2) {
  console.error("usage: carol-ghost.ts <roomId> <name> <t1> <msg1> <t2> <msg2>");
  Deno.exit(2);
}

const log = (s: string) => console.log(`[carol-ghost +${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`);
const T0 = Date.now();
const sleepUntil = (tSec: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, T0 + tSec * 1000 - Date.now())));

// deno-lint-ignore no-explicit-any
type Page = any;

async function idOfRowContaining(page: Page, body: string): Promise<string> {
  return await page.evaluate((b: string) => {
    const rows = [...document.querySelectorAll("#timeline .msg")];
    const row = rows.find((r) => r.textContent?.includes(b));
    return (row as HTMLElement | undefined)?.dataset.eventId ?? "missing";
  }, { args: [body] });
}

// the same event_index receipt probe check-browser-peer.ts uses: the
// message is provably applied by the server before the browser closes
async function waitReceipt(eventId: string, timeoutMs = 15_000): Promise<boolean> {
  const c = new pgpkg.Client({
    host: "127.0.0.1", port: 5432, user: "root", password: "secret", database: "postgres",
  });
  await c.connect();
  const deadline = Date.now() + timeoutMs;
  let landed = false;
  while (Date.now() < deadline) {
    const r = await c.query(
      "SELECT 1 FROM event_index WHERE room_id = $1 AND event_id = $2;",
      [ROOM_ID, eventId],
    );
    if (r.rows.length) { landed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  await c.end();
  return landed;
}

const browser = await launch(
  Deno.env.get("CHROME_PATH") ? { path: Deno.env.get("CHROME_PATH") } : undefined,
); // CHROME_PATH: system Chromium (>=137 for Ed25519) e.g. on test VMs
try {
  const page = await browser.newPage(
    `http://localhost:8787/?transport=ws&sync=msync&room=${encodeURIComponent(ROOM_ID)}`,
  );
  await page.evaluate((n: string) => {
    (document.getElementById("name") as HTMLInputElement).value = n;
    document.getElementById("join-btn")!.click();
  }, { args: [NAME] });

  // bootstrap: ≥1 event in the timeline means the msync session is live
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() =>
      document.querySelectorAll("#timeline .msg").length);
    if (Number(n) > 0) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    console.error("bootstrap timeout — no events within 30s");
    Deno.exit(1);
  }
  log(`joined as ${NAME}; bootstrapped the room history`);

  for (const [t, msg] of [[T1, MSG1], [T2, MSG2]] as const) {
    await sleepUntil(t);
    await page.evaluate((b: string) => {
      (document.getElementById("msg") as HTMLInputElement).value = b;
      document.getElementById("send")!.click();
    }, { args: [msg] });
    const id = await idOfRowContaining(page, msg);
    const ok = await waitReceipt(id);
    log(`sent t=${t}s '${msg.slice(0, 40)}' → ${id}${ok ? " (server receipt ✓)" : " (NO RECEIPT)"}`);
    if (!ok) Deno.exit(1);
  }
  log("ghost run complete");
} finally {
  await browser.close();
}
