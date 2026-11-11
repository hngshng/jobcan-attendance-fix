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

/**
 * One calendar day covered by a 休暇申請. A request spanning several days is
 * expanded into one LeaveApplication per day, so callers can match a date
 * without knowing anything about ranges.
 */
export type LeaveApplication = {
  year: number;
  month: number;
  day: number;
  status: string;      // "承認", "承認待ち", "却下"
  content: string;     // e.g. "病気休暇/Sick Leave (全休/Full Day)", "在宅勤務/Remote Work"
  isRemoteWork: boolean;
  half: LeaveHalf;     // "am" / "pm" for a half-day request, null for a full day
  appliedId: string;   // 申請No — the applied_id of the request this day came from
  spanLabel?: string;  // "2026-07-27..2026-07-29", set only for multi-day requests
};

// --- Locale-tolerant matchers ---------------------------------------------
// The Jobcan UI renders in either Japanese or English depending on the
// account's language setting. Column headers, status badges, and the leave
// date format all change with it, so every text-based match below accepts
// both languages. IDs (#ter_time, #insert_button, #logs-table) are stable and
// used directly.

// Attendance data table: header is 勤怠状況 (JP) / "Attendance Status" (EN).
const ATTENDANCE_TABLE =
  'table:has(th:has-text("勤怠状況")), table:has(th:has-text("Attendance Status"))';
// Leave-applications table: header is 申請No (JP) / "Request No." (EN).
const LEAVE_TABLE =
  'table:has(th:has-text("申請No")), table:has(th:has-text("Request No."))';
// 休暇申請詳細 page: the date row's header is 希望休暇日 (JP) / "Desired Vacation
// Date" (EN). This is the only place a multi-day request's end date is rendered.
const LEAVE_DETAIL_DATE_CELL =
  'tr:has(th:has-text("希望休暇日")) td, tr:has(th:has-text("Desired Vacation Date")) td';
// Jobcan writes the range separator as a full-width tilde; accept its variants.
const RANGE_SEPARATOR = /[～〜~]/;

/**
 * True when the 勤怠状況 badge marks an absence: 欠 (JP) / "A" (EN).
 *
 * The cell can hold more than one badge. A half-day 休暇 renders the leave
 * badge next to the absence badge — "病A" for an approved 午後/PM sick leave —
 * because the other half of the day is still unstamped. Match the badge as a
 * token inside the cell, not as the whole cell.
 */
export function isAbsenceStatus(statusText: string): boolean {
  const s = statusText.trim();
  return s.includes("欠") || /\bA\b/.test(s);
}

/** Which half of the day a 休暇 covers, or null for a full day. */
export type LeaveHalf = "am" | "pm" | null;

/**
 * Read the half-day marker out of a 勤怠状況 tooltip or a 休暇申請 content
 * string — "病気休暇/Sick Leave (午後/PM)" → "pm" (afternoon off, morning worked).
 * A full-day leave reads "(全休/Full Day)" and yields null.
 */
export function detectLeaveHalf(text: string): LeaveHalf {
  if (/午前|\bAM\b/i.test(text)) return "am";
  if (/午後|\bPM\b/i.test(text)) return "pm";
  return null;
}

/** True when a leave application is pending: 承認待ち (JP) / "Waiting for Approval" (EN). */
export function isPendingApproval(status: string): boolean {
  const s = status.trim();
  return s === "承認待ち" || /waiting for approval/i.test(s);
}

/** Canonicalize a 打刻区分 label so JP and EN stamps compare equal. */
export function normalizeStampKind(raw: string): "in" | "out" | "" {
  const s = raw.trim().toLowerCase();
  if (s.includes("出勤") || s.includes("clock in")) return "in";
  if (s.includes("退勤") || s.includes("clock out")) return "out";
  return "";
}

// --- Date helpers ----------------------------------------------------------

export type YMD = { year: number; month: number; day: number };

const DAY_MS = 86_400_000;
/** Guard against a malformed end date turning into an unbounded expansion. */
const MAX_LEAVE_SPAN_DAYS = 366;

/**
 * Pull every date out of a Jobcan date string, in order of appearance.
 *
 * Handles both locales and both renderings Jobcan uses:
 *   JP list "2026/07/27", EN list "07/27/2026",
 *   detail page "07 / 27 / 2026 (Mon)～07 / 29 / 2026 (Wed)".
 * The four-digit group decides which side the year is on; weekday suffixes and
 * the range separator are ignored.
 */
export function parseJobcanDates(raw: string): YMD[] {
  const out: YMD[] = [];
  for (const m of raw.matchAll(/(\d{1,4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,4})/g)) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
    if (m[1].length === 4) out.push({ year: a, month: b, day: c });       // YYYY/MM/DD
    else if (m[3].length === 4) out.push({ year: c, month: a, day: b });  // MM/DD/YYYY
  }
  return out;
}

function toUtcMs(d: YMD): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function fromUtcMs(ms: number): YMD {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Every calendar day from `start` to `end` inclusive. */
export function expandDays(start: YMD, end: YMD): YMD[] {
  const startMs = toUtcMs(start);
  const endMs = toUtcMs(end);
  if (!(endMs > startMs)) return [start];
  const span = Math.min(Math.round((endMs - startMs) / DAY_MS), MAX_LEAVE_SPAN_DAYS);
  const days: YMD[] = [];
  for (let i = 0; i <= span; i++) days.push(fromUtcMs(startMs + i * DAY_MS));
  return days;
}

function ymdLabel(d: YMD): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

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
  // The data table is the one with header 日付 / 出勤時刻 / 勤怠状況 ("Attendance Status" in EN).
  await page.waitForSelector(ATTENDANCE_TABLE, { timeout: 15_000 });

  // NOTE: Keep this callback body free of declared-name helpers.
  // tsx/esbuild rewrites named arrow-consts via __name(...) which doesn't exist in the page context.
  const rows = await page.locator(ATTENDANCE_TABLE).first().locator("tbody tr").evaluateAll(
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
    const isKetsu = isAbsenceStatus(row.statusText);
    const isRW = /(^|[^A-Za-z])RW([^A-Za-z]|$)|在宅勤務|Remote\s*Work/i.test(statusBlob);
    const missingIn = row.clockIn.trim() === "";
    const missingOut = row.clockOut.trim() === "";

    // Fill if the row is 欠, or if it's marked RW but one/both times are blank.
    const needsFill = isKetsu || (isRW && (missingIn || missingOut));
    if (!needsFill) continue;

    // Default times; a half-day 休暇 shifts the expected range to the half
    // that was actually worked. An approved 午後/PM leave shows as "病A" with
    // the half in the tooltip, so the 欠 branch above already caught the row —
    // only the times differ.
    let targetIn = "09:00";
    let targetOut = "18:00";
    let reason: Correction["reason"] = isKetsu ? "full" : "rw-partial";
    const half = detectLeaveHalf(statusBlob);
    if (half === "am") {
      reason = "am-off";
      targetIn = "14:00";
      targetOut = "18:00";
    } else if (half === "pm") {
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

/**
 * Read a request's end date off its 休暇申請詳細 page.
 *
 * The 休暇申請一覧 truncates a multi-day request's 希望休暇日 cell to
 * "07/27/2026～" — the end date is rendered only here. Returns null when the
 * page shows a single date (or can't be parsed).
 */
async function fetchLeaveEndDate(page: Page, appliedId: string): Promise<YMD | null> {
  await page.goto(`https://ssl.jobcan.jp/employee/holiday/info?applied_id=${appliedId}`, {
    waitUntil: "domcontentloaded",
  });

  const labelled = page.locator(LEAVE_DETAIL_DATE_CELL);
  let dates: YMD[] = [];
  if (await labelled.count() > 0) {
    dates = parseJobcanDates((await labelled.first().textContent()) || "");
  }
  if (dates.length < 2) {
    // Locale whose 希望休暇日 label we don't match: fall back to the first cell
    // on the page holding a "date～date" range.
    for (const cell of await page.locator("td").allTextContents()) {
      if (!RANGE_SEPARATOR.test(cell)) continue;
      const parsed = parseJobcanDates(cell);
      if (parsed.length >= 2) { dates = parsed; break; }
    }
  }
  return dates.length >= 2 ? dates[1] : null;
}

/**
 * Jobcan's term search matches a request by its START date only — a request
 * that began before the window but runs into it is not returned. Query this
 * many days earlier than asked, then clip the expanded days to the window.
 */
const LEAVE_QUERY_LOOKBACK_DAYS = 62;

/**
 * Fetch 休暇申請 (leave applications) covering any day between two dates
 * (inclusive), one entry per covered calendar day. Used to detect pending
 * (承認待ち) non-RW applications so we don't accidentally submit 打刻 for days
 * the user is on leave.
 */
export async function fetchLeaveApplications(
  page: Page,
  from: YMD,
  to: YMD,
): Promise<LeaveApplication[]> {
  const queryFrom = fromUtcMs(toUtcMs(from) - LEAVE_QUERY_LOOKBACK_DAYS * DAY_MS);
  const params = new URLSearchParams({
    search_type: "term",
    "from[y]": String(queryFrom.year),
    "from[m]": String(queryFrom.month),
    "from[d]": String(queryFrom.day),
    "to[y]": String(to.year),
    "to[m]": String(to.month),
    "to[d]": String(to.day),
  });
  const url = `https://ssl.jobcan.jp/employee/holiday?${params.toString()}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // The data table's header is 申請No (JP) / "Request No." (EN). If zero
  // applications exist in the range, Jobcan omits the table entirely — treat
  // that as an empty list.
  const tableCount = await page.locator(LEAVE_TABLE).count();
  if (tableCount === 0) return [];

  // Scrape every row up front — resolving ranges below navigates this page away.
  const rows = await page.locator(LEAVE_TABLE).first().locator("tbody tr").evaluateAll(
    (trs) =>
      trs.map((tr) => {
        const tds = tr.querySelectorAll("td");
        const link = tds[0] ? tds[0].querySelector("a[href*='applied_id=']") : null;
        const href = link ? link.getAttribute("href") || "" : "";
        const idFromHref = href.match(/applied_id=(\d+)/);
        return {
          appliedId: idFromHref ? idFromHref[1] : ((tds[0] && tds[0].textContent) || "").trim(),
          date: ((tds[1] && tds[1].textContent) || "").trim(),
          status: ((tds[2] && tds[2].textContent) || "").trim(),
          content: ((tds[3] && tds[3].textContent) || "").trim(),
        };
      }),
  );

  const fromMs = toUtcMs(from);
  const toMs = toUtcMs(to);
  const leaves: LeaveApplication[] = [];

  for (const r of rows) {
    const dates = parseJobcanDates(r.date);
    if (dates.length === 0) continue;
    const start = dates[0];
    let end: YMD | null = dates[1] ?? null;

    // A bare separator with no second date means the list truncated a range.
    if (!end && RANGE_SEPARATOR.test(r.date)) {
      end = r.appliedId ? await fetchLeaveEndDate(page, r.appliedId) : null;
      if (!end) {
        console.warn(
          `   ! 休暇申請 #${r.appliedId || "?"} (${r.date}) spans multiple days but its end date could not be read — treating it as ${ymdLabel(start)} only.`,
        );
      }
    }

    const days = expandDays(start, end ?? start);
    const spanLabel = days.length > 1
      ? `${ymdLabel(days[0])}..${ymdLabel(days[days.length - 1])}`
      : undefined;

    for (const d of days) {
      const ms = toUtcMs(d);
      if (ms < fromMs || ms > toMs) continue; // clip the lookback / overrun back to the window
      leaves.push({
        ...d,
        status: r.status,
        content: r.content,
        isRemoteWork: /在宅勤務|Remote\s*Work/i.test(r.content),
        half: detectLeaveHalf(r.content),
        appliedId: r.appliedId,
        spanLabel,
      });
    }
  }

  return leaves;
}

// 打刻修正 page. Since Jobcan's late-2026 redesign the 打刻 form (#modifyForm,
// holding #ter_time and #insert_button) sits inside the Bootstrap modal
// #modifyModal, which is hidden until the 新規打刻 / "Add New Clocking" link
// runs intoModifyMode(). The onclick attribute is the one locale-independent
// hook for that link. The button itself now reads 申請 / "Requests" and calls
// applyAditWithSelectionRemarks(form) → adit(form), which still POSTs the form
// to /employee/adit/insert/.
const MODIFY_MODAL_OPENER = 'a[onclick*="intoModifyMode()"]';
const MODIFY_MODAL_SHOWN = "#modifyModal.show";

/** Submit one 打刻 (either 出勤 or 退勤). */
async function punchOnce(page: Page, year: number, month: number, day: number, hhmm: string) {
  await page.goto(modifyUrl(year, month, day), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#logs-table", { timeout: 15_000 });
  // Open the modal first — #ter_time exists in the DOM but is not visible (and
  // therefore not fillable) until then.
  await page.click(MODIFY_MODAL_OPENER);
  await page.waitForSelector(MODIFY_MODAL_SHOWN, { timeout: 10_000 });
  await page.fill("#ter_time", hhmm);
  // The 申請/"Requests" button submits via AJAX; wait for the POST to /employee/adit/insert/.
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/employee/adit/insert") && res.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.click("#insert_button");
  const res = await responsePromise;
  if (!res.ok()) {
    throw new Error(`打刻 POST returned ${res.status()} for ${year}-${month}-${day} ${hhmm}`);
  }
  // Validation failures (closed month, duplicate time, required note, …) come
  // back as HTTP 200 with {result: false, errors: {field: code}} — surface them
  // instead of reporting success.
  let body: { result?: boolean; error?: unknown; errors?: Record<string, string> } | null = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body: fall through and trust the HTTP status, as before.
  }
  if (body && (body.error || body.result === false)) {
    const detail = body.errors ? JSON.stringify(body.errors) : JSON.stringify(body);
    throw new Error(`打刻 rejected for ${year}-${month}-${day} ${hhmm}: ${detail}`);
  }
  // Give the UI a moment to settle (Jobcan may reload the page on success).
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

// --- 休暇申請 (new vacation request) ----------------------------------------
// A two-step form:
//   1. /employee/holiday/new — prefilled with the start date from
//      ?holiday_year=&holiday_month=&holiday_day=. "Go to Review Page"
//      (#submit-button) POSTs it to /employee/holiday/confirm.
//   2. The review page renders a read-only summary plus #form1, whose "Request"
//      button (onclick="return submitForm();") POSTs to /employee/holiday/save.
//      Only that second POST creates the request.
// A date range is offered for full-day vacation types only: ticking
// #scheduleCheckbox (期間指定 / "Specify the time period") reveals the
// to_holiday_* selects. Half-day types are always a single date. Jobcan's own
// JS disables #submit-button when a range exceeds 40 working days.

/** The vacation types the leave CLI supports. */
export type LeaveKind = "rw" | "pto" | "sick";

export type LeaveRequest = {
  kind: LeaveKind;
  half: LeaveHalf;  // "am" = morning off, "pm" = afternoon off, null = full day
  from: YMD;
  to: YMD;          // equal to `from` for a single day
  reason: string;   // "" for none
};

/** Label → value rows of Jobcan's review page, in page order. */
export type LeaveReview = { vacationName: string; rows: [string, string][] };

export type LeaveRequestResult = {
  review: LeaveReview;
  submitted: boolean;
  /** Requests that appeared on 休暇申請一覧 after saving, one entry per covered day. */
  created: LeaveApplication[];
};

/** Thrown when an active request already covers one of the requested days. */
export class LeaveOverlapError extends Error {
  constructor(readonly overlapping: LeaveApplication[]) {
    super(`${overlapping.length} requested day(s) are already covered by an active 休暇申請`);
  }
}

// Vacation names are configured per company and render the same in either UI
// language ("PTO (全休/Full Day)", "病気休暇/Sick Leave (午後/PM)",
// "在宅勤務/Remote Work"), so match on the name; option values are internal IDs.
const LEAVE_KIND_PATTERN: Record<LeaveKind, RegExp> = {
  rw: /在宅勤務|Remote\s*Work/i,
  pto: /\bPTO\b/i,
  sick: /病気休暇|Sick\s*Leave/i,
};

const LEAVE_TYPE_SELECT = 'select[name="holiday_id[0]"]';
const LEAVE_RANGE_CHECKBOX = "#scheduleCheckbox";
const LEAVE_REVIEW_FORM = 'form#form1[action*="/employee/holiday/save"]';
const LEAVE_REVIEW_SUBMIT = '#form1 input[type="button"][onclick*="submitForm"]';
// Review-page row labels (JP / EN).
const REVIEW_NAME_LABEL = /休暇名|Vacation Name/i;
const REVIEW_DATE_LABEL = /希望休暇日|休暇希望日|Desired Vacation Date/i;
const REVIEW_REASON_LABEL = /休暇理由|Reason for Vacation/i;

/** A request that no longer blocks its days: 却下 / Rejected, or cancelled. */
export function isInactiveLeaveStatus(status: string): boolean {
  return /却下|取消|取り消|reject|cancel/i.test(status);
}

/**
 * Pick the one 休暇名 option for a kind + half: "pto" + "pm" → "PTO(午後/PM Off)".
 * Throws when the account offers none or several, listing what is available.
 */
export function pickVacationOption(
  options: { value: string; text: string }[],
  kind: LeaveKind,
  half: LeaveHalf,
): { value: string; text: string } {
  const matches = options.filter(
    (o) => o.value !== "" && LEAVE_KIND_PATTERN[kind].test(o.text) && detectLeaveHalf(o.text) === half,
  );
  if (matches.length === 1) return matches[0];
  const want = `${kind}${half ? ` (${half.toUpperCase()} off)` : " (full day)"}`;
  const available = options.filter((o) => o.value !== "").map((o) => `  ${o.value}: ${o.text}`).join("\n");
  throw new Error(
    `${matches.length === 0 ? "No" : "More than one"} 休暇名 option matches ${want}. Available:\n${available}`,
  );
}

export function ymdEquals(a: YMD, b: YMD): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** For comparing what we typed with what Jobcan echoes: <br> and wrapping drop or add whitespace. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/** Visible error text on a Jobcan form page, for error messages. */
async function visibleFormErrors(page: Page): Promise<string> {
  const texts = await page
    .locator(".invalid-feedback:visible, .alert:visible, .jbc-text-danger:visible")
    .allTextContents();
  return texts.map(collapseWhitespace).filter((t) => t !== "" && t !== "(Required)" && t !== "(必須)").join(" / ");
}

async function selectDate(page: Page, prefix: "" | "to_", d: YMD) {
  // Year → month → day: each onchange re-clamps the day list to the month.
  await page.selectOption(`#${prefix}holiday_year`, String(d.year));
  await page.selectOption(`#${prefix}holiday_month`, String(d.month));
  await page.selectOption(`#${prefix}holiday_day`, String(d.day));
}

async function readDate(page: Page, prefix: "" | "to_"): Promise<YMD> {
  return {
    year: Number(await page.inputValue(`#${prefix}holiday_year`)),
    month: Number(await page.inputValue(`#${prefix}holiday_month`)),
    day: Number(await page.inputValue(`#${prefix}holiday_day`)),
  };
}

/**
 * File a 休暇申請 through the two-step form.
 *
 * Before touching the form it reads 休暇申請一覧 for the requested days and
 * throws LeaveOverlapError if an active (not 却下) request already covers one,
 * unless `allowOverlap`. It then fills the form, opens the review page and
 * checks that Jobcan echoes back the chosen vacation name, dates and reason.
 * `onReview` sees that summary and decides whether to press Request; returning
 * false (dry-run, declined prompt) leaves without saving anything.
 *
 * After saving, the new request is confirmed by re-reading 休暇申請一覧 for an
 * 申請No that wasn't there before. Errors raised after the Request click say so,
 * because the request may exist even though verification failed.
 */
export async function createLeaveRequest(
  page: Page,
  req: LeaveRequest,
  opts: { allowOverlap?: boolean; onReview?: (review: LeaveReview) => Promise<boolean> } = {},
): Promise<LeaveRequestResult> {
  const isRange = toUtcMs(req.to) !== toUtcMs(req.from);
  if (toUtcMs(req.to) < toUtcMs(req.from)) {
    throw new Error(`End date ${ymdLabel(req.to)} is before start date ${ymdLabel(req.from)}`);
  }
  if (req.kind === "rw" && req.half) throw new Error("Remote Work has no half-day variant");
  if (req.half && isRange) {
    throw new Error("Jobcan takes a half-day vacation for one date at a time; file one request per date");
  }

  // 1. Existing requests for these days: overlap check + baseline for verification.
  const before = await fetchLeaveApplications(page, req.from, req.to);
  const overlapping = before.filter((l) => !isInactiveLeaveStatus(l.status));
  if (overlapping.length > 0 && !opts.allowOverlap) throw new LeaveOverlapError(overlapping);
  const knownIds = new Set(before.map((l) => l.appliedId));

  // 2. Fill the form.
  const params = new URLSearchParams({
    holiday_year: String(req.from.year),
    holiday_month: String(req.from.month),
    holiday_day: String(req.from.day),
  });
  await page.goto(`https://ssl.jobcan.jp/employee/holiday/new?${params.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(LEAVE_TYPE_SELECT, { timeout: 15_000 });

  const options = await page.$$eval(`${LEAVE_TYPE_SELECT} option`, (os) =>
    os.map((o) => ({ value: (o as HTMLOptionElement).value, text: (o.textContent || "").trim() })),
  );
  const option = pickVacationOption(options, req.kind, req.half);
  await page.selectOption(LEAVE_TYPE_SELECT, option.value);

  if (!ymdEquals(await readDate(page, ""), req.from)) await selectDate(page, "", req.from);
  if (!ymdEquals(await readDate(page, ""), req.from)) {
    throw new Error(`Could not set the start date to ${ymdLabel(req.from)}`);
  }

  if (isRange) {
    const rangeBox = page.locator(LEAVE_RANGE_CHECKBOX);
    if ((await rangeBox.count()) === 0) {
      throw new Error(`"${option.text}" does not offer a date range (期間指定) on Jobcan`);
    }
    await rangeBox.check();
    await page.waitForSelector("#toDisplay", { state: "visible", timeout: 5_000 });
    await selectDate(page, "to_", req.to);
    if (!ymdEquals(await readDate(page, "to_"), req.to)) {
      throw new Error(`Could not set the end date to ${ymdLabel(req.to)}`);
    }
  }

  if (req.reason) await page.fill("#description", req.reason);

  if (await page.locator("#submit-button").isDisabled()) {
    throw new Error(`Jobcan disabled "Go to Review Page": ${(await visibleFormErrors(page)) || "no message shown"}`);
  }

  // 3. Review page — Jobcan validates server-side here; a rejected form comes
  //    back re-rendered with errors instead of the review form.
  await Promise.all([
    // A server-side rejection may not land on /confirm; fall through to the form check.
    page.waitForURL(/\/employee\/holiday\/confirm/, { timeout: 15_000, waitUntil: "domcontentloaded" }).catch(() => {}),
    page.click("#submit-button"),
  ]);
  if ((await page.locator(LEAVE_REVIEW_FORM).count()) === 0) {
    throw new Error(`Jobcan did not accept the form: ${(await visibleFormErrors(page)) || `no review page (at ${page.url()})`}`);
  }

  const rows = (await page.locator(".card-body table tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      return [((th && th.textContent) || "").trim(), ((td && td.textContent) || "").trim()];
    }),
  )) as [string, string][];
  const valueOf = (label: RegExp) => rows.find(([k]) => label.test(k))?.[1] ?? "";
  const review: LeaveReview = { vacationName: option.text, rows };

  const shownName = valueOf(REVIEW_NAME_LABEL);
  if (!sameText(shownName, option.text)) {
    throw new Error(`Review page shows vacation "${shownName}", expected "${option.text}"`);
  }
  const shownDates = parseJobcanDates(valueOf(REVIEW_DATE_LABEL));
  const wantDates = isRange ? [req.from, req.to] : [req.from];
  if (shownDates.length !== wantDates.length || !shownDates.every((d, i) => ymdEquals(d, wantDates[i]))) {
    throw new Error(
      `Review page shows dates "${valueOf(REVIEW_DATE_LABEL)}", expected ${wantDates.map(ymdLabel).join(" ～ ")}`,
    );
  }
  if (req.reason && !sameText(valueOf(REVIEW_REASON_LABEL), req.reason)) {
    throw new Error(`Review page shows reason "${valueOf(REVIEW_REASON_LABEL)}", expected "${req.reason}"`);
  }

  if (opts.onReview && !(await opts.onReview(review))) {
    return { review, submitted: false, created: [] };
  }

  // 4. Save.
  const savePromise = page.waitForResponse(
    (res) => res.url().includes("/employee/holiday/save") && res.request().method() === "POST",
    { timeout: 20_000 },
  );
  const leftReview = page.waitForURL((u) => !u.pathname.startsWith("/employee/holiday/confirm"), {
    timeout: 20_000,
    waitUntil: "domcontentloaded",
  });
  await page.click(LEAVE_REVIEW_SUBMIT);
  const saveRes = await savePromise;
  await leftReview.catch(() => {});
  if (saveRes.status() >= 400) {
    throw new Error(`Request was sent but /employee/holiday/save answered HTTP ${saveRes.status()} — check 休暇申請一覧 before retrying`);
  }
  const saveErrors = await visibleFormErrors(page);
  const savedAt = page.url();

  // 5. Verify on 休暇申請一覧.
  const after = await fetchLeaveApplications(page, req.from, req.to);
  const created = after.filter(
    (l) => !knownIds.has(l.appliedId) && sameText(l.content, option.text),
  );
  if (created.length === 0) {
    throw new Error(
      `Request was sent but no new "${option.text}" request appeared on 休暇申請一覧 for ${wantDates.map(ymdLabel).join("..")} ` +
        `(after saving: ${savedAt}${saveErrors ? `; page said: ${saveErrors}` : ""}) — check Jobcan before retrying`,
    );
  }
  return { review, submitted: true, created };
}
