---
name: jobcan-vacation-request
description: Create a Jobcan 休暇申請 (vacation request) for Remote Work (在宅勤務), PTO, or Sick Leave (病気休暇), for one day, a half day, or a date range. It interviews the user, polishes the reason, confirms, then submits with this repo's Playwright tool (`pnpm leave`). Use when the user wants to request, apply for, book, or file remote work / WFH, PTO, a day off, vacation, or sick leave on Jobcan, or mentions 休暇申請.
---

# Jobcan vacation request

Collect the request one step at a time, show one summary, and submit only after
the user confirms it. The tool is `src/request-leave.ts` (`pnpm leave`) in this
repository; run every command from the repository root, the directory holding
`package.json`, three levels above this skill.

Skip any question the user has already answered in their message. Ask the rest
in this order.

## 1. Vacation type

Ask with AskUserQuestion (header "Type"):

- **Remote Work**: 在宅勤務/Remote Work → `--type=rw`
- **PTO** → `--type=pto`
- **Sick Leave**: 病気休暇/Sick Leave → `--type=sick`

Anything else (振休, 特別休暇, 欠勤, EVP…) is not supported by the tool. Tell
the user to file it on https://ssl.jobcan.jp/employee/holiday/new by hand.

## 2. Full or half day (PTO and Sick Leave only)

Remote Work is always a full day. For PTO and Sick Leave, ask (header "Day"):

- **Full day**: no flag
- **Morning off** (works the afternoon) → `--half=am`
- **Afternoon off** (works the morning) → `--half=pm`

## 3. Desired Vacation Date

Ask in plain text for the date or the date range ("Nov 20", "11/24–11/26",
"next Monday to Wednesday"). Resolve it against today's date (`date +%F`), turn
it into `YYYY-MM-DD`, and look up each weekday with
`date -j -f %F 2026-11-20 '+%F (%a)'`.

- A range is `--from` + `--to` (`--to` must not be before `--from`). Ranges
  exist for full-day types only. Weekends and national holidays inside a range
  are fine: Jobcan counts working days only and caps a range at 40 of them.
- A half day covers one date per request. If the user gives several dates for
  a half day, plan one request per date and run them one after another.
- Point out, but don't block, a start date in the past or one on a weekend.

## 4. Reason for Vacation

**Remote Work and Sick Leave need a reason.** Ask for it in plain text. For
PTO, don't ask, but polish one the same way if the user gives it.

Polish the user's text:

- Write in the language the user used. Don't translate. English stays
  English; Japanese becomes natural, polite Japanese (です/ます).
- Fix grammar, spelling and word choice so it reads as a native speaker would
  write it for a manager. Keep the meaning and add no new facts.
- Keep it to one or two sentences on a single line.

Show the original and the polished version. If nothing needed fixing, say so.
The user can accept the polished version or edit it.

## 5. Confirm

Show one summary:

| Field | Value |
| --- | --- |
| Vacation | the Jobcan 休暇名 it maps to, e.g. `PTO(午後/PM Off)` (names in the table below) |
| Date(s) | `2026-11-24 (Tue) – 2026-11-26 (Thu)`, or one line per half-day request |
| Reason | the polished reason, or "—" |

| Flags | Jobcan 休暇名 |
| --- | --- |
| `rw` | 在宅勤務/Remote Work |
| `pto` / `pto --half=am` / `pto --half=pm` | PTO (全休/Full Day) / PTO(午前/AM Off) / PTO(午後/PM Off) |
| `sick` / `sick --half=am` / `sick --half=pm` | 病気休暇/Sick Leave (全休/Full Day) / (午前/AM) / (午後/PM) |

Then ask with AskUserQuestion (header "Submit"):

- **Submit to Jobcan**: go to step 6.
- **Preview on Jobcan first**: run the step-6 command with `--dry-run` in
  place of `--yes`. It fills the form and stops at Jobcan's review page
  without pressing Request. Show the review rows it prints, then ask this
  question again.
- **Change something**: go back to the step concerned.

Never pass `--yes` before the user picks **Submit to Jobcan**. One
confirmation covers every request listed in the summary.

## 6. Submit

Pass the reason through a quoted heredoc so quotes and Japanese text need no
escaping. Use a Bash timeout of 300000 ms. A Chrome window opens and logs in
with the credentials in `.env`.

```bash
pnpm -s leave --type=rw --from=2026-11-24 --to=2026-11-26 --yes --reason-file=/dev/stdin <<'REASON'
I'm waiting for a contractor to repair the heating at home.
REASON
```

- One day: drop `--to`.
- Half day: add `--half=am` or `--half=pm`.
- No reason (PTO): drop `--reason-file` and the heredoc.

Read the result:

- **Exit 0 with `✓ Requested`**: report the 申請No(s) and status (承認待ち until
  the manager approves).
- **Exit 2**: an active request already covers one of the days, and nothing
  was submitted. Show the listed requests and ask whether to file anyway. Add
  `--allow-overlap` only after an explicit yes.
- **Exit 1**: show the error. Don't retry unchanged. If the message says
  **"Request was sent"**, the request may exist: tell the user to check
  https://ssl.jobcan.jp/employee/holiday before running it again, so it
  isn't filed twice. Any other exit-1 error happened before Request was
  pressed, so nothing was submitted.

For several half-day requests, run them in order and stop at the first one
that doesn't exit 0.

## Don't

- Don't read, print, or change `.env`.
- Don't edit the tool's code from this skill. If Jobcan's form changed and
  the tool fails, report it and point to `pnpm explore` and the README's
  troubleshooting section.
