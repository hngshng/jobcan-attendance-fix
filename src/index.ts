/**
 * Jobcan attendance fix — CLI entrypoint.
 *
 * Usage:
 *   npx tsx src/index.ts            # scan, show corrections, prompt y/n, apply
 *   npx tsx src/index.ts --dry-run  # scan and print only, never submit
 */
import "dotenv/config";
import { chromium } from "playwright";
import readline from "node:readline/promises";
import {
  type AttendanceRow,
  type Correction,
  applyCorrection,
  fetchMonthRows,
  getExistingStamps,
  login,
  planCorrections,
} from "./jobcan.js";

function parseOnly(argv: string[]): { year: number; month: number; day: number } | null {
  const arg = argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  const value = arg.slice("--only=".length);
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`--only expects YYYY-MM-DD, got "${value}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function prevMonth(today: Date) {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function monthIsFullyInput(rows: AttendanceRow[]): boolean {
  return rows.every((r) => !r.statusText.includes("欠"));
}

function reasonLabel(reason: Correction["reason"]): string {
  switch (reason) {
    case "full": return "full day";
    case "am-off": return "AM off";
    case "pm-off": return "PM off";
    case "rw-partial": return "RW partial";
  }
}

function printCorrectionTable(corrections: Correction[]) {
  if (corrections.length === 0) {
    console.log("\nNo corrections needed.\n");
    return;
  }
  console.log("\nProposed corrections:\n");
  const header =
    "  Date        | To submit               | Reason       | Status / Note";
  const bar = "  " + "-".repeat(header.length - 2);
  console.log(header);
  console.log(bar);
  for (const c of corrections) {
    const d = `${String(c.row.year).padStart(4, "0")}-${String(c.row.month).padStart(2, "0")}-${String(c.row.day).padStart(2, "0")}`;
    const toSubmit = c.submissions.map((s) => `${s.kind}=${s.time}`).join(", ");
    const note = c.row.statusTooltip || c.row.statusText;
    console.log(
      `  ${d}  | ${toSubmit.padEnd(23)} | ${reasonLabel(c.reason).padEnd(12)} | ${note}`,
    );
  }
  console.log();
}

async function promptYesNo(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(q)).trim().toLowerCase();
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = parseOnly(process.argv);
  const email = process.env.JOBCAN_EMAIL;
  const password = process.env.JOBCAN_PASSWORD;
  if (!email || !password) {
    throw new Error("JOBCAN_EMAIL / JOBCAN_PASSWORD missing in .env");
  }

  const today = new Date();
  const prev = prevMonth(today);

  console.log(
    `→ Mode: ${dryRun ? "dry-run (no writes)" : "live"}  |  Today: ${today.toISOString().slice(0, 10)}${only ? `  |  Target: only ${only.year}-${String(only.month).padStart(2, "0")}-${String(only.day).padStart(2, "0")}` : ""}`,
  );

  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();

  try {
    console.log("→ Logging in…");
    const page = await login(context, email, password);

    // --- Previous month ---
    console.log(`→ Scanning previous month: ${prev.year}-${String(prev.month).padStart(2, "0")}`);
    const prevRows = await fetchMonthRows(page, prev.year, prev.month);
    const prevCorrections = planCorrections(prevRows);

    let corrections: Correction[] = prevCorrections;

    // --- Current month (only if previous is fully input) ---
    if (monthIsFullyInput(prevRows)) {
      const cur = { year: today.getFullYear(), month: today.getMonth() + 1 };
      const upToDay = today.getDate() - 1; // up to yesterday
      if (upToDay >= 1) {
        console.log(
          `→ Previous month fully input. Scanning current month up to day ${upToDay}: ${cur.year}-${String(cur.month).padStart(2, "0")}`,
        );
        const curRows = await fetchMonthRows(page, cur.year, cur.month);
        corrections = planCorrections(curRows, upToDay);
      } else {
        console.log("→ Previous month fully input, and today is the 1st — nothing more to check.");
        corrections = [];
      }
    } else {
      console.log("→ Previous month has missing entries — skipping current month until fixed.");
    }

    // Narrow to --only target if specified (before the pending-stamp check,
    // so we only probe one modify page when targeting a single date).
    if (only) {
      const before = corrections.length;
      corrections = corrections.filter(
        (c) => c.row.year === only.year && c.row.month === only.month && c.row.day === only.day,
      );
      if (corrections.length === 0) {
        console.log(
          `→ --only=${only.year}-${String(only.month).padStart(2, "0")}-${String(only.day).padStart(2, "0")} did not match any 欠 row (out of ${before} candidates). Nothing to do.`,
        );
        return;
      }
    }

    // For each candidate, read the 打刻一覧 on the 打刻修正 page and drop
    // submissions whose (kind, time) is already present — approved or pending.
    // This dedupes across:
    //   (a) a 欠 day we already submitted on a previous run (still 欠 on 出勤簿
    //       until the manager approves it), and
    //   (b) an RW day whose existing side is shown on 出勤簿 and therefore
    //       also appears in 打刻一覧.
    if (corrections.length > 0) {
      console.log(
        `→ Checking 打刻修正 for existing stamps on ${corrections.length} date(s)…`,
      );
      const kept: Correction[] = [];
      const fullySkipped: Correction[] = [];
      const partiallyDeduped: { c: Correction; removed: { kind: string; time: string }[] }[] = [];
      for (const c of corrections) {
        const existing = await getExistingStamps(page, c.row.year, c.row.month, c.row.day);
        const remaining = c.submissions.filter(
          (s) => !existing.some((e) => e.kind === s.kind && e.time === s.time),
        );
        const removed = c.submissions.filter(
          (s) => existing.some((e) => e.kind === s.kind && e.time === s.time),
        );
        if (remaining.length === 0) {
          fullySkipped.push(c);
        } else {
          if (removed.length > 0) partiallyDeduped.push({ c, removed });
          kept.push({ ...c, submissions: remaining });
        }
      }
      if (fullySkipped.length > 0) {
        console.log(
          `→ Skipping ${fullySkipped.length} date(s) — all needed stamps already on 打刻一覧:`,
        );
        for (const s of fullySkipped) {
          console.log(
            `   - ${s.row.year}-${String(s.row.month).padStart(2, "0")}-${String(s.row.day).padStart(2, "0")}`,
          );
        }
      }
      if (partiallyDeduped.length > 0) {
        console.log(
          `→ ${partiallyDeduped.length} date(s) already have one side stamped — keeping only the missing side:`,
        );
        for (const { c, removed } of partiallyDeduped) {
          const d = `${c.row.year}-${String(c.row.month).padStart(2, "0")}-${String(c.row.day).padStart(2, "0")}`;
          const removedLabel = removed.map((r) => `${r.kind}=${r.time}`).join(", ");
          console.log(`   - ${d} (already present: ${removedLabel})`);
        }
      }
      corrections = kept;
    }

    printCorrectionTable(corrections);

    if (corrections.length === 0) {
      console.log("Nothing to do. Exiting.");
      return;
    }

    if (dryRun) {
      console.log("[dry-run] Stopping before any writes.");
      return;
    }

    const ok = await promptYesNo("Apply these corrections? (y/N) ");
    if (!ok) {
      console.log("Aborted. No changes made.");
      return;
    }

    for (const c of corrections) {
      const d = `${c.row.year}-${String(c.row.month).padStart(2, "0")}-${String(c.row.day).padStart(2, "0")}`;
      const subs = c.submissions.map((s) => `${s.kind}=${s.time}`).join(", ");
      console.log(`→ Applying ${d}: ${subs}`);
      try {
        await applyCorrection(page, c);
        console.log(`   ✓ done`);
      } catch (err) {
        console.error(`   ✗ failed:`, err instanceof Error ? err.message : err);
      }
    }

    console.log("\nAll corrections attempted. Re-run with --dry-run to verify the state.");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
