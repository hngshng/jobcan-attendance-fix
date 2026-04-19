/**
 * One-off probe: capture the populated 打刻一覧 on the 打刻修正 page
 * for a given date so we can build a parser for it.
 * Usage: pnpm exec tsx src/probe-logs.ts 2026-04-13
 */
import "dotenv/config";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { login } from "./jobcan.js";

async function main() {
  const target = process.argv[2];
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    throw new Error("Pass a YYYY-MM-DD date, e.g. 2026-04-13");
  }
  const [y, m, d] = target.split("-").map(Number);

  const email = process.env.JOBCAN_EMAIL!;
  const password = process.env.JOBCAN_PASSWORD!;
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  try {
    const page = await login(context, email, password);
    const url = `https://ssl.jobcan.jp/employee/adit/modify?year=${y}&month=${m}&day=${d}`;
    console.log("→ Opening", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#logs-table", { timeout: 15_000 });
    await page.waitForTimeout(1500);

    const out = "exploration";
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: join(out, `probe-${target}.png`), fullPage: true });
    const logsHtml = await page.$eval("#logs-table", (el) => (el as HTMLElement).outerHTML);
    await writeFile(join(out, `probe-${target}-logs.html`), logsHtml);
    console.log(`→ Saved probe-${target}.png and probe-${target}-logs.html`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
