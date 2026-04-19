import type { BrowserContext, Page } from "playwright";

const SIGN_IN_URL = "https://id.jobcan.jp/users/sign_in";
const SSO_URL = "https://ssl.jobcan.jp/jbcoauth/login";

function attendanceUrl(year: number, month: number) {
  // Month & day ranges in the URL are cosmetic; Jobcan renders the whole month.
  const params = new URLSearchParams({
    list_type: "normal",
    search_type: "month",
    year: String(year),
    month: String(month),
    "from[y]": String(year),
    "from[m]": String(month),
    "from[d]": "1",
    "to[y]": String(year),
    "to[m]": String(month),
    "to[d]": "31",
  });
  return `https://ssl.jobcan.jp/employee/attendance?${params.toString()}`;
}

function modifyUrl(year: number, month: number, day: number) {
  return `https://ssl.jobcan.jp/employee/adit/modify?year=${year}&month=${month}&day=${day}`;
}

export type AttendanceRow = {
  year: number;
  month: number;
  day: number;
  dateLabel: string;          // e.g. "03/01(日)"
  holidayKind: string;        // 休日区分 — "法休" / "公休" / "祝日\n公休" / ""
  shiftTime: string;          // e.g. "10:00～16:00"
  clockIn: string;            // 出勤時刻
  clockOut: string;           // 退勤時刻
  statusText: string;         // 勤怠状況 visible text
  statusTooltip: string;      // data-original-title
};

export type Submission = { kind: "出勤" | "退勤"; time: string }; // time in "HH:MM"

export type Correction = {
  row: AttendanceRow;
  submissions: Submission[];
  reason: "full" | "am-off" | "pm-off" | "rw-partial";
};

export type ExistingStamp = { kind: string; time: string };

export async function login(context: BrowserContext, email: string, password: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"], input[name="user[email]"]', email);
  await page.fill('input[type="password"], input[name="user[password]"]', password);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  // Confirm login succeeded — the common ID profile page should appear.
  await page.waitForURL(/id\.jobcan\.jp\/account\/profile/i, { timeout: 15_000 });

  // Establish the ssl.jobcan.jp employee session via SSO.
  await page.goto(SSO_URL, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/ssl\.jobcan\.jp\/employee/i, { timeout: 15_000 });
  return page;
}

export async function fetchMonthRows(
  page: Page,
  year: number,
  month: number,
): Promise<AttendanceRow[]> {
  await page.goto(attendanceUrl(year, month), { waitUntil: "domcontentloaded" });
  // The data table is the one with header 日付 / 出勤時刻 / 勤怠状況.
  await page.waitForSelector('table:has(th:has-text("勤怠状況"))', { timeout: 15_000 });

  // NOTE: Keep this callback body free of declared-name helpers.
  // tsx/esbuild rewrites named arrow-consts via __name(...) which doesn't exist in the page context.
  const rows = await page.$$eval(
    'table:has(th:has-text("勤怠状況")) tbody tr',
    (trs) =>
      trs.map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        const dateLink = tds[0] ? tds[0].querySelector("a") : null;
        const dateLabel = (dateLink && dateLink.textContent ? dateLink.textContent : "").trim();
        const tooltipEl = tds[9] ? tds[9].querySelector("[data-original-title]") : null;
        const statusTooltip = tooltipEl ? (tooltipEl.getAttribute("data-original-title") || "") : "";
        return {
          dateLabel,
          holidayKind: ((tds[1] && tds[1].textContent) || "").trim(),
          shiftTime: ((tds[2] && tds[2].textContent) || "").trim(),
          clockIn: ((tds[3] && tds[3].textContent) || "").trim(),
          clockOut: ((tds[4] && tds[4].textContent) || "").trim(),
          statusText: ((tds[9] && tds[9].textContent) || "").trim(),
          statusTooltip,
        };
      }),
  );

  return rows
    .filter((r) => /^\d{2}\/\d{2}/.test(r.dateLabel))
    .map((r) => {
      const m = r.dateLabel.match(/^(\d{2})\/(\d{2})/)!;
      return {
        ...r,
        year,
        month: Number(m[1]),
        day: Number(m[2]),
      };
    });
}

export function planCorrections(
  rows: AttendanceRow[],
  upToDay?: number,
): Correction[] {
  const corrections: Correction[] = [];
  for (const row of rows) {
    if (upToDay !== undefined && row.day > upToDay) continue;

    const statusBlob = `${row.statusTooltip || ""} ${row.statusText || ""}`;
    const isKetsu = row.statusText.includes("欠");
    const isRW = /(^|[^A-Za-z])RW([^A-Za-z]|$)|在宅勤務|Remote\s*Work/i.test(statusBlob);
    const missingIn = row.clockIn.trim() === "";
    const missingOut = row.clockOut.trim() === "";

    // Fill if the row is 欠, or if it's marked RW but one/both times are blank.
    const needsFill = isKetsu || (isRW && (missingIn || missingOut));
    if (!needsFill) continue;

    // Default times; AM/PM tooltips shift the expected range.
    let targetIn = "09:00";
    let targetOut = "18:00";
    let reason: Correction["reason"] = isKetsu ? "full" : "rw-partial";
    if (/午前|AM/i.test(statusBlob)) {
      reason = "am-off";
      targetIn = "14:00";
      targetOut = "18:00";
    } else if (/午後|PM/i.test(statusBlob)) {
      reason = "pm-off";
      targetIn = "09:00";
      targetOut = "14:00";
    }

    // Submit only the sides that are missing on the 出勤簿.
    // For 欠 rows, both 出勤 and 退勤 are blank by definition.
    const submissions: Submission[] = [];
    if (missingIn) submissions.push({ kind: "出勤", time: targetIn });
    if (missingOut) submissions.push({ kind: "退勤", time: targetOut });
    if (submissions.length === 0) continue;

    corrections.push({ row, submissions, reason });
  }
  return corrections;
}

/**
 * Returns the list of 打刻 entries currently shown in 打刻一覧 on the 打刻修正
 * page for this date (approved + pending-approval, both appear here).
 *
 * Used to dedupe before submitting — if the exact (kind, time) pair we want
 * to submit is already present, we skip it. For a 欠 row after a previous run
 * where everything has been submitted but not yet approved, this returns the
 * full set and the caller ends up with nothing to do.
 */
export async function getExistingStamps(
  page: Page,
  year: number,
  month: number,
  day: number,
): Promise<ExistingStamp[]> {
  await page.goto(modifyUrl(year, month, day), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#logs-table", { timeout: 15_000 });
  const rows = await page.$$eval("#logs-table tbody tr", (trs) =>
    trs.map((tr) => {
      const tds = tr.querySelectorAll("td");
      const kind = ((tds[0] && tds[0].textContent) || "").trim();
      const timeRaw = ((tds[1] && tds[1].textContent) || "").trim();
      const m = timeRaw.match(/\d{2}:\d{2}/);
      return { kind, time: m ? m[0] : "" };
    }),
  );
  return rows.filter((r) => r.kind !== "" && r.time !== "");
}

/** Submit one 打刻 (either 出勤 or 退勤). */
async function punchOnce(page: Page, year: number, month: number, day: number, hhmm: string) {
  await page.goto(modifyUrl(year, month, day), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ter_time", { timeout: 15_000 });
  await page.fill("#ter_time", hhmm);
  // The 打刻 button is an <input type="button"> that triggers AJAX via adit(form).
  // We click it and wait for the response to come back — the endpoint is /employee/adit/insert/.
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/employee/adit/insert") && res.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.click("#insert_button");
  const res = await responsePromise;
  if (!res.ok()) {
    throw new Error(`打刻 POST returned ${res.status()} for ${year}-${month}-${day} ${hhmm}`);
  }
  // Give the UI a moment to settle.
  await page.waitForTimeout(500);
}

export async function applyCorrection(page: Page, c: Correction) {
  const { year, month, day } = c.row;
  // Submissions are ordered 出勤 then 退勤 by planCorrections, which is what
  // Jobcan's auto-detection expects when both are new. If only one is being
  // submitted (RW partial case), the auto-detection still picks the right kind
  // based on the existing stamp already in 打刻一覧.
  for (const s of c.submissions) {
    await punchOnce(page, year, month, day, s.time.replace(":", ""));
  }
}
