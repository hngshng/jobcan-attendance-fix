/**
 * One-off probe: dump 休暇申請一覧 for inspection.
 * Usage: pnpm exec tsx src/probe-holidays.ts
 */
import "dotenv/config";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { login } from "./jobcan.js";

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  try {
    const page = await login(context, process.env.JOBCAN_EMAIL!, process.env.JOBCAN_PASSWORD!);
    await page.goto("https://ssl.jobcan.jp/employee/holiday", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const out = "exploration";
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: join(out, "probe-holiday.png"), fullPage: true });
    await writeFile(join(out, "probe-holiday.html"), await page.content());

    const tables = await page.locator("table").all();
    for (let i = 0; i < tables.length; i++) {
      const html = await tables[i].evaluate((el) => (el as HTMLElement).outerHTML);
      await writeFile(join(out, `probe-holiday-table-${i}.html`), html);
    }
    console.log(`→ Found ${tables.length} <table>s — dumped to exploration/`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
