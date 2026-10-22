/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in a test script */
/**
 * End-to-end smoke over HTTP against a running app (local or deployed).
 *
 *   npm run dev            # in another shell
 *   npm run smoke          # BASE_URL defaults to http://localhost:3000
 *   BASE_URL=https://<preview>.vercel.app npm run smoke
 *
 * Needs dev sign-in links (local default, or AUTH_DEV_LINKS=1 on a preview deploy).
 * Vercel production (VERCEL_ENV=production) never returns an on-screen link.
 * Covers: sign-in → upload → learn → defend → signed receipt → stamp, plus the
 * access-control and privacy checks that must hold on every deploy.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { sha256Hex, verifySignature } from "../src/lib/crypto";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const fixture = readFileSync(join(process.cwd(), "fixtures", "sample-memo.md"));
const run = Math.random().toString(36).slice(2, 8);

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const post = (path: string, body: unknown, cookie?: string) =>
  call(path, {
    method: "POST",
    cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function signIn(email: string): Promise<string> {
  const req = await post("/api/auth/request", { email });
  check(req.status === 200 && req.json.devLink, `sign-in link issued for ${email}`);
  const token = String(req.json.devLink).split("#token=")[1];
  const verify = await post("/api/auth/verify", { token });
  const setCookie = verify.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  check(verify.status === 200 && cookie.startsWith("di_session="), "magic link exchanged for a session cookie");
  check(/httponly/i.test(setCookie), "session cookie is HttpOnly");
  const reuse = await post("/api/auth/verify", { token });
  check(reuse.status === 400, "magic link cannot be reused");
  return cookie;
}

async function main() {
  console.log(`Smoke against ${BASE}`);

  const keys = await call("/api/keys");
  check(keys.status === 200, `public key endpoint (LLM mode: ${keys.json?.llmMode})`);

  const anonIngest = await call("/api/creator/ingest", { method: "POST", body: new FormData() });
  check(anonIngest.status === 401, "upload requires sign-in");
  const anonAdmin = await call("/api/admin/sessions");
  check(anonAdmin.status === 401, "admin requires sign-in");
  const anonDash = await call("/api/dashboard?email=ana@fund.example");
  check(anonDash.status === 401, "dashboard no longer readable by ?email=");
  const crossSite = await call("/api/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "x@evil.example" }),
  });
  check(crossSite.status === 403, "cross-site POST blocked");

  const ana = await signIn(`ana+${run}@fund.example`);
  const me = await call("/api/auth/me", {
    method: "PATCH",
    cookie: ana,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Ana Analyst" }),
  });
  check(me.status === 200, "display name saved");

  const form = new FormData();
  form.set("difficulty", "standard");
  form.set("file", new Blob([fixture], { type: "text/markdown" }), "Project-North-memo.md");
  const ingest = await call("/api/creator/ingest", { method: "POST", body: form, cookie: ana });
  check(ingest.status === 200, `upload parsed (${ingest.json?.claimCount} claims)${ingest.status !== 200 ? ` — ${ingest.text}` : ""}`);
  check(ingest.json.sha256 === sha256Hex(fixture), "server hash matches local SHA-256");
  const token = ingest.json.token as string;
  check(token.length >= 22, "defense link token is long and random");

  if (process.env.SMOKE_PDF) {
    const pdfForm = new FormData();
    pdfForm.set("file", new Blob([readFileSync(process.env.SMOKE_PDF)], { type: "application/pdf" }), "memo.pdf");
    const pdf = await call("/api/creator/ingest", { method: "POST", body: pdfForm, cookie: ana });
    check(pdf.status === 200, `PDF upload parsed (${pdf.json?.claimCount} claims)${pdf.status !== 200 ? ` — ${pdf.text}` : ""}`);
  }

  const mallory = await signIn(`mallory+${run}@evil.example`);
  const steal = await post("/api/sessions/start", { token, mode: "learn" }, mallory);
  check(steal.status === 403, "another account cannot open this defense");
  const peek = await call(`/api/requests/${token}`, { cookie: mallory });
  check(peek.status === 200 && peek.json.deliverable === null, "another account sees no file details");
  const malAdmin = await call("/api/admin/sessions", { cookie: mallory });
  check(malAdmin.status === 403, "non-admin cannot list sessions");

  const learn = await post("/api/sessions/start", { token, mode: "learn" }, ana);
  check(learn.status === 200, "learn session started");
  const turn = await post("/api/sessions/learn", { sessionId: learn.json.sessionId }, ana);
  check(turn.status === 200 && turn.json.coachMessage, "coach replied");

  const defend = await post("/api/sessions/start", { token, mode: "defend" }, ana);
  check(defend.status === 200 && defend.json.probes?.length > 0, `defend started (${defend.json.probes?.length} probes)`);
  check(!JSON.stringify(defend.json).includes("expectedFocus"), "expected answers are not sent to the browser");

  const probes = defend.json.probes as { id: string; type: string; question: string }[];
  const skip = await post("/api/sessions/defend/answer", { sessionId: defend.json.sessionId, probeId: probes[1].id, answer: "skipping ahead" }, ana);
  check(skip.status === 409, "answers must follow the server's question order");
  for (const p of probes) {
    const saved = await post(
      "/api/sessions/defend/answer",
      {
        sessionId: defend.json.sessionId,
        probeId: p.id,
        answer:
          p.type === "planted_error"
            ? "That excerpt was altered — the figure does not match the unit economics section of the memo."
            : "The recommendation rests on churn near 1.2% and LTV/CAC above 3. If churn doubled, IRR falls first and the round size should shrink.",
      },
      ana,
    );
    if (saved.status !== 200) throw new Error(`FAILED: answer not saved — ${saved.text}`);
  }
  console.log(`  ✓ ${probes.length} answers recorded server-side`);
  const forged = await post("/api/sessions/defend/complete", { sessionId: defend.json.sessionId, turns: [{ probeId: "x", answer: "forged", latencyMs: 9000 }] }, mallory);
  check(forged.status === 404, "another account cannot complete this defense");
  let done = await post("/api/sessions/defend/complete", { sessionId: defend.json.sessionId, showName: true }, ana);
  if (done.status === 200 && done.json?.followUp?.probe) {
    const extra = done.json.followUp.probe as { id: string };
    const saved = await post(
      "/api/sessions/defend/answer",
      {
        sessionId: defend.json.sessionId,
        probeId: extra.id,
        answer: "The memo states churn of 1.2% and a $12M round. The assumption that would change my answer is churn doubling to 2.4%.",
      },
      ana,
    );
    check(saved.status === 200, "disagreement follow-up accepted");
    done = await post("/api/sessions/defend/complete", { sessionId: defend.json.sessionId, showName: true }, ana);
  }
  check(done.status === 200 && done.json?.receipt?.payload?.id, `defense graded: ${done.json?.receipt?.payload?.outcome} ${done.json?.score}/100${done.status !== 200 ? ` — ${done.text}` : ""}`);

  const id = done.json.receipt.payload.id as string;
  const pub = await call(`/api/receipts/${id}`);
  check(pub.status === 200 && pub.json.signatureValid, "public receipt signature valid (server)");
  const r = pub.json.receipt;
  check(verifySignature(r.payload, r.signature, r.publicKey), "receipt signature valid (independent check)");
  check(r.payload.deliverable.sha256 === sha256Hex(fixture), "receipt bound to the exact file hash");
  check(
    Array.isArray(r.payload.graders) &&
      r.payload.graders.length > 0 &&
      r.payload.modelVersions.length === r.payload.graders.length &&
      r.payload.graders.every(
        (g: { model?: unknown; temperature?: unknown; seed?: unknown }, i: number) =>
          g.model === r.payload.modelVersions[i] && g.temperature === 0 && typeof g.seed === "number",
      ),
    "receipt signs model, temperature, and seed per grader",
  );
  const receiptText = JSON.stringify(r);
  check(!receiptText.includes("fund.example"), "receipt carries no email");
  check(!receiptText.includes("Project-North"), "receipt carries no file name");
  check(!/churn|Series B/i.test(receiptText), "receipt carries no transcript or document text");
  check(r.payload.creator?.displayName === "Ana Analyst", "creator name shown because they opted in");

  const stamp = await call(`/api/stamp/${id}`);
  check(stamp.status === 200 && stamp.text.includes("<svg"), "stamp renders");
  const bogus = await call(`/api/receipts/rcpt_doesnotexist000000000`);
  check(bogus.status === 404, "unknown receipt is 404");

  const again = await post("/api/sessions/start", { token, mode: "learn" }, ana);
  check(again.status === 410, "document text purged once the defense completed");
  const twice = await post("/api/sessions/defend/complete", { sessionId: defend.json.sessionId }, ana);
  check(twice.status === 200 && twice.json?.receipt?.payload?.id === id, "retrying a finished defense returns the same receipt");

  // Voice: Hard defenses are live voice; typed answers are refused unless the
  // creator takes the accommodation path.
  const hardForm = new FormData();
  hardForm.set("difficulty", "hard");
  hardForm.set("file", new Blob([fixture], { type: "text/markdown" }), "hard.md");
  const hard = await call("/api/creator/ingest", { method: "POST", body: hardForm, cookie: ana });
  const voice = await post("/api/sessions/start", { token: hard.json.token, mode: "defend" }, ana);
  check(voice.status === 200 && voice.json.channel === "voice", "Hard defense starts as a live voice interview");
  const typed = await post("/api/sessions/defend/answer", { sessionId: voice.json.sessionId, probeId: voice.json.probes[0].id, answer: "typed" }, ana);
  check(typed.status === 409, "typed answers are refused in a voice defense");
  const lk = await post("/api/voice/token", { sessionId: voice.json.sessionId }, ana);
  check(lk.status === 200 ? typeof lk.json.token === "string" && lk.json.url.startsWith("wss://") : lk.status === 503, `voice token ${lk.status === 200 ? "issued for the owner" : "not configured here (503)"}`);
  const lkOther = await post("/api/voice/token", { sessionId: voice.json.sessionId }, mallory);
  check(lkOther.status === 404, "another account cannot join the voice room");
  const agentForged = await post("/api/voice/agent/plan", { sessionId: voice.json.sessionId });
  check(agentForged.status === 401 || agentForged.status === 503, "agent API refuses unsigned requests");
  const acc = await post("/api/sessions/start", { token: hard.json.token, mode: "defend", accommodation: true }, ana);
  check(acc.status === 200 && acc.json.channel === "text_accommodation", "accommodation path starts a typed defense");

  const dash = await call("/api/dashboard", { cookie: ana });
  check(dash.status === 200 && dash.json.rows.some((x: { receiptId: string }) => x.receiptId === id), "dashboard lists own receipt");

  const demo = await post("/api/demo/start", { sample: "harbor-readme" });
  check(demo.status === 200 && demo.json?.demo === true, `sample demo opened (${demo.status !== 200 ? demo.text : demo.json.title})`);
  const headerBag = demo.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headerBag.getSetCookie?.() ?? [demo.headers.get("set-cookie") || ""];
  const demoCookie = setCookies.map((value) => value.split(";")[0]).find((value) => value.startsWith("di_demo="));
  check(demoCookie, "sample demo sets an HttpOnly pass, not a sign-in session");
  check(/httponly/i.test(setCookies.join(";")), "sample pass cookie is HttpOnly");
  const demoStart = await post("/api/sessions/start", { token: demo.json.token, mode: "defend" }, demoCookie);
  check(demoStart.status === 200 && demoStart.json.channel === "text" && demoStart.json.probes?.length === 3, "sample defense is 3 text questions");
  check(demoStart.json.demo === true, "sample defense is marked as a demo");
  for (const p of demoStart.json.probes as { id: string; type: string }[]) {
    const saved = await post(
      "/api/sessions/defend/answer",
      {
        sessionId: demoStart.json.sessionId,
        probeId: p.id,
        answer:
          p.type === "planted_error"
            ? "The 2,000-note assumption was altered. Harbor only fits the index in one process if the workspace stays under that."
            : "Harbor indexes Markdown notes on one machine. The load-bearing assumption is that a workspace stays under 2,000 notes.",
      },
      demoCookie,
    );
    if (saved.status !== 200) throw new Error(`FAILED: sample answer not saved — ${saved.text}`);
  }
  const demoDone = await post("/api/sessions/defend/complete", { sessionId: demoStart.json.sessionId, showName: true }, demoCookie);
  check(demoDone.status === 200 && demoDone.json?.receipt?.payload?.demo?.sample === true, "sample receipt is labelled a demo");
  check(demoDone.json.receipt.payload.demo.credential === false, "sample receipt is not a credential");
  check(demoDone.json.receipt.payload.creator == null, "sample receipt has no creator name");
  const demoId = demoDone.json.receipt.payload.id as string;
  const demoPub = await call(`/api/receipts/${demoId}`);
  check(demoPub.status === 200 && demoPub.json.receipt.payload.demo.file === "Harbor README", "public sample receipt names the bundled file");
  check(!JSON.stringify(demoPub.json).includes("separate search service"), "sample receipt carries no document text");
  const demoLearn = await post("/api/sessions/start", { token: demo.json.token, mode: "learn" }, demoCookie);
  check(demoLearn.status === 403, "sample pass cannot open Learn");
  const demoUpload = await call("/api/creator/ingest", { method: "POST", body: new FormData(), cookie: demoCookie });
  check(demoUpload.status === 401, "sample pass cannot upload a file");
  const demoChallenge = await post("/api/requests", { difficulty: "standard", title: "nope" }, demoCookie);
  check(demoChallenge.status === 401, "sample pass cannot create a challenge");
  const demoDash = await call("/api/dashboard", { cookie: demoCookie });
  check(demoDash.status === 401, "sample pass cannot open the dashboard");
  const listed = await call("/api/dashboard", { cookie: ana });
  check(listed.status === 200 && !listed.json.rows.some((x: { receiptId: string }) => x.receiptId === demoId), "sample receipt stays out of the dashboard");

  console.log(`\nreceipt ${BASE}/r/${id}`);
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
