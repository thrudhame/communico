// MS2 headless check (phase-ms1-3 step 4): two astral pages over
// BroadcastChannel. create/join → cross-send both ways → paused concurrent
// sends → union + fork indicator → lazy heal (2 prevs) → identical
// timelines + EQUAL table hashes (printed). Exit 0 iff all steps pass.
/// <reference lib="dom" />
import { launch } from "jsr:@astral/astral";

const BASE = "http://localhost:8787";
const ROOM = "msync-check";

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
      v = await page.evaluate((p: string) => String(eval(p)), { args: [pred] });
    } catch { /* page busy */ }
    if (v === "true") return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timeout waiting for: ${what}`);
  return v;
}

const browser = await launch(
  Deno.env.get("CHROME_PATH") ? { path: Deno.env.get("CHROME_PATH") } : undefined,
); // CHROME_PATH: system Chromium (>=137 for Ed25519) e.g. on test VMs
try {
  // 0. LATE-PEER scenario (MS4 step 5.2): B's join starts ~8 s AFTER A
  //    creates, and A stays SILENT (no sends). B must still bootstrap
  //    ≤15 s (proves the joiner-rescue: uncapped retry + onPeer trigger).
  {
    const LATE = "msync-late";
    const pageC = await browser.newPage(`${BASE}/?sync=msync`);
    await pageC.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "carol";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("create-btn")!.click();
    }, { args: [LATE] });
    await waitFor(pageC, "C room ready", `!document.getElementById("room").classList.contains("hidden")`, 30_000);
    console.log("late-peer: C created room, staying silent");
    await new Promise((r) => setTimeout(r, 8_000)); // B's join starts ~8 s later
    const pageD = await browser.newPage(`${BASE}/?sync=msync`);
    const joinAt = Date.now();
    await pageD.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "dave";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("join-btn")!.click();
    }, { args: [LATE] });
    await waitFor(pageD, "D bootstraps via rescue", `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 15_000);
    console.log(`late-peer: D bootstrapped in ${Date.now() - joinAt} ms (A silent throughout)`);
    await pageC.close();
    await pageD.close();
  }

  // 1. A creates, B joins
  const pageA = await browser.newPage(`${BASE}/?sync=msync`);
  await pageA.evaluate((room) => {
    (document.getElementById("name") as HTMLInputElement).value = "alice";
    (document.getElementById("room-name") as HTMLInputElement).value = room;
    document.getElementById("create-btn")!.click();
  }, { args: [ROOM] });
  await waitFor(pageA, "A room ready", `!document.getElementById("room").classList.contains("hidden")`, 30_000);
  console.log("step 1: A created room");

  const pageB = await browser.newPage(`${BASE}/?sync=msync`);
  await pageB.evaluate((room) => {
    (document.getElementById("name") as HTMLInputElement).value = "bob";
    (document.getElementById("room-name") as HTMLInputElement).value = room;
    document.getElementById("join-btn")!.click();
  }, { args: [ROOM] });
  await waitFor(pageB, "B timeline shows genesis (bootstrap-clone via delta)",
    `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 30_000);
  await waitFor(pageB, "B badge green", `document.getElementById("convergence")?.classList.contains("ok")`, 15_000);
  console.log("step 1: B joined, genesis visible, badge green");

  // helper: send a message in a page
  const send = (page: Page, body: string) =>
    page.evaluate((b: string) => {
      (document.getElementById("msg") as HTMLInputElement).value = b;
      document.getElementById("send")!.click();
    }, { args: [body] });
  const timelineHas = (page: Page, body: string) =>
    waitFor(page, `timeline contains '${body}'`,
      `(document.getElementById("timeline")?.textContent ?? "").includes(${JSON.stringify(body)})`, 10_000);

  // 2. A sends → in B (with $id); B sends → in A
  await send(pageA, "hello from alice");
  await timelineHas(pageB, "hello from alice");
  const idShape = await pageB.evaluate(() => {
    const rows = [...document.querySelectorAll("#timeline .msg")];
    const last = rows.find((r) => r.textContent?.includes("hello from alice"));
    return (last as HTMLElement | undefined)?.dataset.eventId ?? "missing";
  });
  if (!/^\$[A-Za-z0-9_-]{43}$/.test(idShape)) fail(`cross-delivered id not a content-hash wire id: ${idShape}`);
  else console.log("step 2: alice→bob delivered; id shape ok:", idShape.slice(0, 12) + "…");
  await send(pageB, "hello from bob");
  await timelineHas(pageA, "hello from bob");
  console.log("step 2: bob→alice delivered");

  // 3. fork: pause both, concurrent sends, resume
  await pageA.evaluate(() => (globalThis as any).__syncPause(true));
  await pageB.evaluate(() => (globalThis as any).__syncPause(true));
  await send(pageA, "concurrent-a");
  await send(pageB, "concurrent-b");
  await new Promise((r) => setTimeout(r, 800)); // let local ingests settle before flush
  await pageA.evaluate(() => (globalThis as any).__syncPause(false));
  await pageB.evaluate(() => (globalThis as any).__syncPause(false));
  for (const [p, name] of [[pageA, "A"], [pageB, "B"]] as const) {
    await waitFor(p, `${name} sees concurrent-a`, `(document.getElementById("timeline")?.textContent ?? "").includes("concurrent-a")`, 20_000);
    await waitFor(p, `${name} sees concurrent-b`, `(document.getElementById("timeline")?.textContent ?? "").includes("concurrent-b")`, 20_000);
    await waitFor(p, `${name} fork indicator`, `!document.getElementById("fork-ind")?.classList.contains("hidden")`, 10_000);
  }
  console.log("step 3: both timelines show BOTH concurrent messages (union, pre-heal); fork indicator on both");

  // 4. B heals with an ordinary message
  await send(pageB, "after the storm");
  await waitFor(pageB, "B heal event has 2 prevs",
    `[...document.querySelectorAll("#timeline .msg")].find(r => r.textContent?.includes("after the storm"))?.dataset.prevCount === "2"`, 15_000);
  await waitFor(pageA, "A received heal", `(document.getElementById("timeline")?.textContent ?? "").includes("after the storm")`, 15_000);
  for (const [p, name] of [[pageA, "A"], [pageB, "B"]] as const) {
    await waitFor(p, `${name} fork cleared`, `document.getElementById("fork-ind")?.classList.contains("hidden")`, 10_000);
  }
  const idsOf = () =>
    [...document.querySelectorAll("#timeline .msg")].map((d) => (d as HTMLElement).dataset.eventId);
  const idsA = await pageA.evaluate(idsOf);
  const idsB = await pageB.evaluate(idsOf);
  const sameTimeline = JSON.stringify(idsA) === JSON.stringify(idsB);
  console.log("step 4: timelines identical:", sameTimeline, `(${idsA.length} rows)`);
  if (!sameTimeline) fail("timelines differ after heal");
  // direct table-hash read via the room handle
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
  else console.log("step 4: TABLE HASHES EQUAL ✓ (Merkle-certified convergence)");

  // 5. F1 SIGNED PROFILES: two personas, one browser key. Same browser
  // (shared localStorage) => same homeserver key; alice creates R2, bob
  // joins, alice invites, bob joins (member), both send SIGNED as members.
  {
    const R2 = "msync-profiles";
    const pageC = await browser.newPage(`${BASE}/?sync=msync`);
    await pageC.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "alice";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("create-btn")!.click();
    }, { args: [R2] });
    await waitFor(pageC, "C room ready", `!document.getElementById("room").classList.contains("hidden")`, 30_000);
    const keyC = await pageC.evaluate(() => (globalThis as any).__identity?.serverName ?? "missing");
    const pageD = await browser.newPage(`${BASE}/?sync=msync`);
    await pageD.evaluate((room) => {
      (document.getElementById("name") as HTMLInputElement).value = "bob";
      (document.getElementById("room-name") as HTMLInputElement).value = room;
      document.getElementById("join-btn")!.click();
    }, { args: [R2] });
    await waitFor(pageD, "D bootstraps", `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.create")`, 30_000);
    const keyD = await pageD.evaluate(() => (globalThis as any).__identity?.serverName ?? "missing");
    if (!keyC || keyC === "missing" || keyC !== keyD) {
      fail(`profiles are not under one browser key: ${keyC} vs ${keyD}`);
    } else {
      console.log(`step 5: one browser key for both personas (${keyC.slice(0, 12)}…)`);
    }
    // alice invites bob; bob accepts via join-room; both directions flow
    await pageC.evaluate(() => {
      (document.getElementById("invite-name") as HTMLInputElement).value = "bob";
      document.getElementById("invite-btn")!.click();
    });
    await waitFor(pageD, "D sees invite", `(document.getElementById("timeline")?.textContent ?? "").includes("m.room.member")`, 15_000);
    await pageD.evaluate(() => { document.getElementById("join-room-btn")!.click(); });
    await waitFor(pageC, "C sees bob's join", `(document.getElementById("timeline")?.textContent ?? "").includes("@bob:")`, 15_000);
    console.log("step 5: invite + member join through the stub");
    const sendCD = (page: Page, body: string) =>
      page.evaluate((b: string) => {
        (document.getElementById("msg") as HTMLInputElement).value = b;
        document.getElementById("send")!.click();
      }, { args: [body] });
    await sendCD(pageC, "signed-hello-alice");
    await waitFor(pageD, "D sees alice's message", `(document.getElementById("timeline")?.textContent ?? "").includes("signed-hello-alice")`, 15_000);
    await sendCD(pageD, "signed-hello-bob");
    await waitFor(pageC, "C sees bob's message", `(document.getElementById("timeline")?.textContent ?? "").includes("signed-hello-bob")`, 15_000);
    // every message PDU on both replicas: signed by the one browser key,
    // two distinct senders, content-hash ids.
    const sigAudit = (page: Page) =>
      page.evaluate((key: string) => {
        const room = (globalThis as any).__room;
        const rows = room.db.selectObjects("SELECT canonical_json FROM events");
        const out = [];
        for (const r of rows) {
          const pdu = JSON.parse(r.canonical_json);
          if (pdu.type !== "m.room.message") continue;
          const sigs = pdu.signatures?.[key] ?? {};
          out.push({
            id: pdu.event_id,
            sender: pdu.sender,
            signed: Object.keys(sigs).length > 0,
            idShape: /^\$[A-Za-z0-9_-]{43}$/.test(pdu.event_id),
          });
        }
        return out;
      }, { args: [keyC] });
    const auditC = await sigAudit(pageC) as { id: string; sender: string; signed: boolean; idShape: boolean }[];
    const auditD = await sigAudit(pageD) as { id: string; sender: string; signed: boolean; idShape: boolean }[];
    const senders = new Set(auditC.map((e) => e.sender));
    if (auditC.length < 2 || !auditC.every((e) => e.signed && e.idShape)) {
      fail(`C message PDUs not all signed+shaped: ${JSON.stringify(auditC)}`);
    } else if (senders.size !== 2 || ![...senders].every((s) => s.endsWith(":" + keyC))) {
      fail(`C senders are not two personas under one key: ${JSON.stringify([...senders])}`);
    } else if (JSON.stringify(auditC) !== JSON.stringify(auditD)) {
      fail("C/D message sets differ after signed convergence");
    } else {
      console.log(`step 5: ${auditC.length} message PDUs signed by one key, two personas, converging ✓`);
    }
    await pageC.close();
    await pageD.close();
  }

  console.log(ok ? "CHECK: PASS" : "CHECK: FAIL");
  Deno.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  try { server?.kill(); } catch { /* already dead */ }
}
