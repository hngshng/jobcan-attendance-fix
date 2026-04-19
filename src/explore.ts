/**
 * Read-only exploration script.
 * Logs in to Jobcan, captures the attendance page and the 打刻修正 page
 * (HTML + screenshot) so we can confirm real selectors.
 * Does NOT submit any forms or modify any state.
 */
import "dotenv/config";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "exploration";

function prevMonth(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function main() {
  const email = process.env.JOBCAN_EMAIL;
  const password = process.env.JOBCAN_PASSWORD;
  if (!email || !password) {
    throw new Error("JOBCAN_EMAIL / JOBCAN_PASSWORD missing in .env");
  }

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("→ Opening sign-in page");
  await page.goto("https://id.jobcan.jp/users/sign_in", { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: join(OUT_DIR, "01-signin.png"), fullPage: true });
  await writeFile(join(OUT_DIR, "01-signin.html"), await page.content());

  console.log("→ Submitting credentials");
  await page.fill('input[type="email"], input[name="user[email]"]', email);
  await page.fill('input[type="password"], input[name="user[password]"]', password);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, "02-after-login.png"), fullPage: true });
  await writeFile(join(OUT_DIR, "02-after-login.html"), await page.content());
  console.log("→ Post-login URL:", page.url());

  // SSO bridge into the employee (ssl.jobcan.jp) session.
  console.log("→ Following SSO bridge to ssl.jobcan.jp");
  await page.goto("https://ssl.jobcan.jp/jbcoauth/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, "02b-after-sso.png"), fullPage: true });
  await writeFile(join(OUT_DIR, "02b-after-sso.html"), await page.content());
  console.log("→ Post-SSO URL:", page.url());

  // Attendance page (previous month).
  const { year, month } = prevMonth();
  const attUrl =
    `https://ssl.jobcan.jp/employee/attendance?list_type=normal&search_type=month` +
    `&year=${year}&month=${month}` +
    `&from%5By%5D=${year}&from%5Bm%5D=${month}&from%5Bd%5D=1` +
    `&to%5By%5D=${year}&to%5Bm%5D=${month}&to%5Bd%5D=31`;
  console.log("→ Opening attendance page:", attUrl);
  await page.goto(attUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, "03-attendance.png"), fullPage: true });
  await writeFile(join(OUT_DIR, "03-attendance.html"), await page.content());

  // Dump each table's outerHTML separately for easier inspection.
  const tables = await page.locator("table").all();
  console.log(`→ Found ${tables.length} <table> elements on attendance page`);
  for (let i = 0; i < tables.length; i++) {
    const html = await tables[i].evaluate((el) => (el as HTMLElement).outerHTML);
    await writeFile(join(OUT_DIR, `03-attendance-table-${i}.html`), html);
  }

  // 打刻修正 page.
  console.log("→ Opening 打刻修正 page");
  await page.goto("https://ssl.jobcan.jp/employee/adit/modify/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, "04-modify.png"), fullPage: true });
  await writeFile(join(OUT_DIR, "04-modify.html"), await page.content());

  console.log("→ Done. Artifacts in ./" + OUT_DIR);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
