/**
 * Print parsed attendance rows for a given month. Useful for spot-checking
 * status detection (欠, RW, holidays, etc.).
 * Usage: pnpm exec tsx src/probe-row.ts 2026 4
 */
import "dotenv/config";
import { chromium } from "playwright";
import { fetchMonthRows, login } from "./jobcan.js";

async function main() {
  const [y, m] = [Number(process.argv[2]), Number(process.argv[3])];
  if (!y || !m) throw new Error("Usage: probe-row.ts YEAR MONTH");
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  try {
    const page = await login(context, process.env.JOBCAN_EMAIL!, process.env.JOBCAN_PASSWORD!);
    const rows = await fetchMonthRows(page, y, m);
    for (const r of rows) {
      console.log(
        `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}  ` +
          `休: '${r.holidayKind}'  ` +
          `in: '${r.clockIn}'  ` +
          `out: '${r.clockOut}'  ` +
          `status: '${r.statusText}'  ` +
          `tip: '${r.statusTooltip}'`,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
