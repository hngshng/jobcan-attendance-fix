/**
 * Jobcan vacation request (休暇申請) — CLI entrypoint.
 *
 * Usage:
 *   pnpm leave --type=rw   --from=2026-11-20 --to=2026-11-21 --reason="…"
 *   pnpm leave --type=pto  --from=2026-12-24 --to=2026-12-28
 *   pnpm leave --type=sick --from=2026-11-12 --half=pm --reason="…"
 *
 * Flags:
 *   --type=rw|pto|sick   在宅勤務/Remote Work, PTO, 病気休暇/Sick Leave (required)
 *   --from=YYYY-MM-DD    first day (required)
 *   --to=YYYY-MM-DD      last day, full-day types only (default: --from)
 *   --half=am|pm         half day off — am = morning off, pm = afternoon off (pto / sick)
 *   --reason=TEXT        Reason for Vacation (required for rw and sick)
 *   --reason-file=PATH   read the reason from a file; /dev/stdin takes a heredoc
 *   --dry-run            fill the form and open Jobcan's review page, never press Request
 *   --yes                press Request without the y/N prompt (non-interactive callers)
 *   --allow-overlap      file even if an active request already covers one of the days
 *
 * Exit codes: 0 done (or dry-run / declined), 1 error, 2 overlapping request found.
 */
import "dotenv/config";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import {
  type LeaveApplication,
  type LeaveKind,
  type LeaveRequest,
  type LeaveReview,
  type YMD,
  LeaveOverlapError,
  createLeaveRequest,
  login,
} from "./jobcan.js";

const KIND_LABEL: Record<LeaveKind, string> = {
  rw: "在宅勤務/Remote Work",
  pto: "PTO",
  sick: "病気休暇/Sick Leave",
};

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function parseDate(name: string, value: string): YMD {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`--${name} expects YYYY-MM-DD, got "${value}"`);
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (check.getUTCMonth() !== d.month - 1 || check.getUTCDate() !== d.day) {
    throw new Error(`--${name}=${value} is not a calendar date`);
  }
  return d;
}

function ymd(d: YMD): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function parseArgs(): LeaveRequest {
  const type = flag("type");
  if (type !== "rw" && type !== "pto" && type !== "sick") {
    throw new Error(`--type must be rw, pto or sick (got ${type === undefined ? "nothing" : `"${type}"`})`);
  }
  const halfRaw = flag("half");
  if (halfRaw !== undefined && halfRaw !== "am" && halfRaw !== "pm") {
    throw new Error(`--half must be am or pm, got "${halfRaw}"`);
  }
  const fromRaw = flag("from");
  if (!fromRaw) throw new Error("--from=YYYY-MM-DD is required");
  const from = parseDate("from", fromRaw);
  const toRaw = flag("to");
  const to = toRaw ? parseDate("to", toRaw) : from;
  if (Date.UTC(to.year, to.month - 1, to.day) < Date.UTC(from.year, from.month - 1, from.day)) {
    throw new Error(`--to=${toRaw} is before --from=${fromRaw}`);
  }
  if (halfRaw && type === "rw") throw new Error("Remote Work has no half-day variant; drop --half");
  if (halfRaw && ymd(to) !== ymd(from)) {
    throw new Error("A half day covers one date per request; drop --to and run once per date");
  }

  const reasonFile = flag("reason-file");
  const reason = (reasonFile ? readFileSync(reasonFile, "utf8") : flag("reason") ?? "").trim();
  if ((type === "rw" || type === "sick") && reason === "") {
    throw new Error(`--reason (or --reason-file) is required for ${KIND_LABEL[type]}`);
  }
  return { kind: type, half: halfRaw ?? null, from, to, reason };
}

function printReview(review: LeaveReview) {
  console.log("\nJobcan review page:\n");
  const width = Math.max(...review.rows.map(([k]) => k.length));
  for (const [k, v] of review.rows) console.log(`  ${k.padEnd(width)} | ${v}`);
  console.log();
}

function printLeaves(leaves: LeaveApplication[]) {
  for (const l of leaves) {
    const span = l.spanLabel ? ` [${l.spanLabel}]` : "";
    console.log(`   - ${ymd(l)}  #${l.appliedId}  ${l.status}  ${l.content}${span}`);
  }
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
  const yes = process.argv.includes("--yes");
  const allowOverlap = process.argv.includes("--allow-overlap");
  const req = parseArgs();

  // The y/N prompt needs a terminal. Refuse up front rather than hang or
  // silently decline when run from a script (or with a heredoc on stdin).
  if (!dryRun && !yes && !process.stdin.isTTY) {
    throw new Error("stdin is not a terminal — pass --yes to submit without the y/N prompt");
  }

  const email = process.env.JOBCAN_EMAIL;
  const password = process.env.JOBCAN_PASSWORD;
  if (!email || !password) throw new Error("JOBCAN_EMAIL / JOBCAN_PASSWORD missing in .env");

  const part = req.half ? ` (${req.half === "am" ? "AM" : "PM"} off)` : "";
  const dates = ymd(req.to) === ymd(req.from) ? ymd(req.from) : `${ymd(req.from)} .. ${ymd(req.to)}`;
  console.log(`→ Mode: ${dryRun ? "dry-run (stops at the review page)" : "live"}`);
  console.log(`→ ${KIND_LABEL[req.kind]}${part}  |  ${dates}${req.reason ? `  |  Reason: ${req.reason}` : ""}`);

  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  try {
    console.log("→ Logging in…");
    const page = await login(context, email, password);
    console.log("→ Checking 休暇申請一覧 for overlapping requests, then filling the form…");

    let result;
    try {
      result = await createLeaveRequest(page, req, {
        allowOverlap,
        onReview: async (review) => {
          console.log(`→ Vacation name on Jobcan: ${review.vacationName}`);
          printReview(review);
          if (dryRun) return false;
          if (yes) return true;
          return promptYesNo("Submit this request? (y/N) ");
        },
      });
    } catch (err) {
      if (err instanceof LeaveOverlapError) {
        console.error(`✗ ${err.message}:`);
        printLeaves(err.overlapping);
        console.error("  Nothing was submitted. Re-run with --allow-overlap to file it anyway.");
        process.exitCode = 2;
        return;
      }
      throw err;
    }

    if (!result.submitted) {
      console.log(dryRun ? "[dry-run] Stopped at the review page. Nothing was submitted." : "Aborted. Nothing was submitted.");
      return;
    }
    const ids = [...new Set(result.created.map((l) => l.appliedId))];
    console.log(`✓ Requested — 申請No ${ids.map((id) => `#${id}`).join(", ")} now on 休暇申請一覧:`);
    printLeaves(result.created);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
