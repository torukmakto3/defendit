/**
 * Drive Learn and Defend on three fixtures through the service layer.
 *   npx tsx scripts/interview-soak.ts
 * Uses the mock council unless CALIBRATE_LIVE=1 and a provider key is set.
 */
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.MOCK_LLM = process.env.CALIBRATE_LIVE === "1" ? process.env.MOCK_LLM || "" : "1";
if (!process.env.MOCK_LLM) delete process.env.MOCK_LLM;
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "defendit-soak-")), "soak.db");
process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
delete process.env.DATABASE_URL;

const FILES = ["investment-memo.md", "technical-note.md", "short-essay.md"];
const REPEATS = 2;

async function main() {
  const { creatorIngest, learnCoachTurn, startSession, recordDefendAnswer, completeDefendSession } = await import(
    "../src/lib/services"
  );
  const { requestMagicLink, consumeMagicLink } = await import("../src/lib/auth");
  const flakes: string[] = [];
  let defenses = 0;

  for (const file of FILES) {
    const buffer = readFileSync(join(process.cwd(), "fixtures", "calibration", file));
    for (let run = 0; run < REPEATS; run++) {
      const email = `soak+${file}+${run}@fund.example`;
      try {
        const link = await requestMagicLink({ email });
        const token = link.devLink!.split("#token=")[1];
        const session = await consumeMagicLink(token);
        const user = session!.user;
        const ingest = await creatorIngest({ user, fileName: file, buffer });
        if (!ingest.claimCount || ingest.claimCount < 3) flakes.push(`${file}#${run} only ${ingest.claimCount} claims`);

        const learn = await startSession({ token: ingest.token, user, mode: "learn" });
        const opening = await learnCoachTurn({ sessionId: learn.sessionId, user });
        if (!opening.coachMessage) flakes.push(`${file}#${run} empty coach`);
        const reply = await learnCoachTurn({
          sessionId: learn.sessionId,
          user,
          answer: "The main claim is the recommendation in the opening section, and it depends on the figures holding.",
        });
        if (!reply.coachMessage) flakes.push(`${file}#${run} empty coach reply`);

        const defend = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
        const types = defend.plan.probes.map((p) => p.type);
        if (new Set(types).size < 3) flakes.push(`${file}#${run} thin coverage: ${types.join(",")}`);
        for (const probe of defend.plan.probes) {
          const saved = await recordDefendAnswer({
            sessionId: defend.sessionId,
            user,
            probeId: probe.id,
            answer:
              probe.type === "planted_error"
                ? "That excerpt was altered and does not match the figure I remember from the document."
                : "Because the document's figure is the one I would defend. If the main assumption moved 30%, the recommendation would change and I would check the source.",
          });
          if (!saved.answered) flakes.push(`${file}#${run} answer not stored for ${probe.type}`);
        }
        // Identical retry of the last answer must not 409.
        const last = defend.plan.probes[defend.plan.probes.length - 1];
        const retry = await recordDefendAnswer({
          sessionId: defend.sessionId,
          user,
          probeId: last.id,
          answer:
            last.type === "planted_error"
              ? "That excerpt was altered and does not match the figure I remember from the document."
              : "Because the document's figure is the one I would defend. If the main assumption moved 30%, the recommendation would change and I would check the source.",
        });
        if (!retry.idempotent) flakes.push(`${file}#${run} retry was not idempotent`);

        let done = await completeDefendSession({ sessionId: defend.sessionId, user });
        if (done.followUp) {
          await recordDefendAnswer({
            sessionId: defend.sessionId,
            user,
            probeId: done.followUp.probe.id,
            answer: "The document supports that point with the figure in the section, and the assumption I would re-check is the one the question names.",
          });
          done = await completeDefendSession({ sessionId: defend.sessionId, user });
        }
        if (!done.receipt) flakes.push(`${file}#${run} no receipt`);
        else {
          defenses += 1;
          console.log(`  ${file}#${run} score ${done.score} ${done.receipt.payload.outcome} probes ${defend.plan.probes.length}`);
        }
      } catch (e) {
        flakes.push(`${file}#${run} threw ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`Soak finished: ${defenses} receipts, ${flakes.length} flakes`);
  for (const flake of flakes) console.log(`  flake: ${flake}`);
  if (flakes.length) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
