# jobcan-attendance-fix

Scans your Jobcan attendance (出勤簿) for unfilled days (勤怠状況 = 欠), proposes
default clock-in/out times, asks for your approval, and submits them via the
打刻修正 page.

- Logs in through `id.jobcan.jp` and bridges to the employee session on
  `ssl.jobcan.jp` via `/jbcoauth/login`.
- Scans the **previous month** in full. If the previous month is fully input,
  it also scans the **current month up to yesterday**.
- A day needs input when either:
  - 勤怠状況 is `欠` (day not stamped at all), or
  - 勤怠状況 indicates RW (`在宅勤務/Remote Work`) **and** at least one of
    出勤時刻 / 退勤時刻 is blank. Only the blank side(s) are submitted.
- Skips weekends and national holidays (they never show 欠 or RW-with-blanks).
- Dedupes per-submission against 打刻一覧 on the 打刻修正 page: any
  (kind, time) already stamped — approved or pending-approval — is removed
  from the plan. A date is fully skipped only when nothing's left to submit.
- Headed browser (Chrome) — you see every action.

## Default times

The same time rules apply to both 欠 and RW-with-blanks. For RW rows, only
the missing side is submitted (so the pre-existing one is untouched).

| 勤怠状況 (tooltip) | 出勤時刻 | 退勤時刻 |
| --- | --- | --- |
| Full day (欠, or RW with both blank) | 09:00 | 18:00 |
| Contains `午前/AM` (AM off, work PM) | 14:00 | 18:00 |
| Contains `午後/PM` (PM off, work AM) | 09:00 | 14:00 |

## Prerequisites

- macOS with [Google Chrome](https://www.google.com/chrome/) installed
  (Playwright launches it via `channel: "chrome"`).
- [`mise`](https://mise.jdx.dev/) — used to pin Node and pnpm.
  ```
  brew install mise
  ```

## Setup

```bash
cd /Users/kw5rx00696/agents/operation/jobcan-attendance-fix

# Install pinned Node + pnpm (see mise.toml)
mise trust
mise install

# Install dependencies (playwright, tsx, dotenv, typescript)
pnpm install

# Create your .env (git-ignored) from the template and fill in credentials
cp .env.example .env
$EDITOR .env
```

`.env` contents:

```
JOBCAN_EMAIL=your.email@example.com
JOBCAN_PASSWORD=your-password-here
```

## Usage

All commands run from the project root.

### Dry-run (scan + print, never submits)

```bash
pnpm dry-run
```

Prints the proposed correction table and exits. No side effects.

### Target a single date (safest first run)

```bash
pnpm exec tsx src/index.ts --only=2026-04-03
```

Only the specified date is considered. Combine with `--dry-run` if you just
want to preview that date:

```bash
pnpm exec tsx src/index.ts --dry-run --only=2026-04-03
```

### Full live run

```bash
pnpm start
```

Scans, prints the correction table, prompts `y/N`. On `y`, for each date it:

1. Opens `https://ssl.jobcan.jp/employee/adit/modify?year=Y&month=M&day=D`
2. Types `HHMM` (e.g. `0900`) into the 時刻 field.
3. Clicks the 打刻 button (Jobcan auto-detects 出勤 vs 退勤).
4. Repeats with the clock-out time.

### Exploration / debugging

A separate script dumps HTML + screenshots of the sign-in, post-login,
attendance, and 打刻修正 pages into `./exploration/`. Useful when Jobcan's
markup changes and selectors break.

```bash
pnpm explore
```

## How duplicate submissions are avoided

Between submitting stamps on 打刻修正 and your manager approving them, the
出勤簿 keeps showing 欠 for those days — the naive scan would propose them
again. The tool does a second pass after the initial scan: for each
candidate it opens the 打刻修正 page, parses `打刻一覧`, and drops any
planned submission whose (打刻区分, 時刻) pair is already present (approved
or 承認待ち). A date is fully skipped only when nothing's left to submit.

This also handles the RW-partial case correctly: an RW day with an existing
09:00 出勤 and a missing 退勤 has `{出勤, 09:00}` on 打刻一覧, so the planner
submits only `{退勤, 18:00}` — the approved side isn't re-punched.

## Project layout

```
.
├── mise.toml              # Node + pnpm version pin
├── package.json           # scripts + deps
├── pnpm-lock.yaml         # pinned dependency versions
├── tsconfig.json
├── .env                   # credentials (git-ignored)
├── .env.example
├── src/
│   ├── index.ts           # CLI: flags, orchestration, prompt, apply
│   ├── jobcan.ts          # login, scraping, planner, form submission
│   ├── explore.ts         # read-only page dumper (whole flow)
│   ├── probe-logs.ts      # dump 打刻一覧 for a single date
│   └── probe-row.ts       # print parsed attendance rows for a month
└── exploration/           # artifacts from probes/explore (git-ignored)
```

## Troubleshooting

- **"Your Login Information is incorrect"** — the credentials in `.env` are
  wrong, or they're meant for the separate "Staff Mypage" login rather than
  the Common ID. Confirm you can sign in manually at
  <https://id.jobcan.jp/users/sign_in> before re-running the tool.
- **`__name is not defined` in a `$$eval` callback** — tsx/esbuild injects
  `__name()` helpers into named arrow-const helpers inside browser callbacks.
  Keep those callbacks free of declared-name helpers (see the comment in
  `src/jobcan.ts`).
- **Selectors broken after a Jobcan update** — re-run `pnpm explore` and
  inspect the dumps in `./exploration/` to find the new markup, then update
  `fetchMonthRows` / `hasPendingStamps` / the modify-form selectors.

## Safety notes

- Credentials live only in `.env`, which is git-ignored.
- Dry-run and `--only` let you preview or limit writes before committing to a
  full-month batch.
- The tool will not submit to dates that already have pending stamps, so
  re-running after a partial run is safe.
