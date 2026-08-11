---
name: seven-shifts-reporting
description: Pull 7shifts scheduling, labor, sales, and payroll data and turn it into executive reporting. Use when the user asks about labor cost, labor percentage, overtime, sales per labor hour, scheduling, staffing, headcount, tips, time off, or an executive/ops dashboard for their restaurant group.
---

# 7shifts reporting

Guidance for answering operational and financial questions from 7shifts data.

## Orient yourself first

The company id is usually implicit in the API key, so most tools work without it.

1. `sevenshifts_whoami` — confirms the account and company id.
2. `sevenshifts_list_locations` — **most reporting endpoints require a `location_id`**, so get these early and keep the id → name mapping.

## Start with the rollup

For almost any "how is the business doing" question, call
`sevenshifts_executive_summary` with a `start_date` and `end_date`. One call
returns, across every location: sales, labor cost, labor % of sales, labor
hours, overtime hours, and sales per labor hour — already converted to dollars.

Only drop to the underlying tools when you need detail the rollup doesn't carry.

## Units — read this before quoting any number

| Source | Unit | Conversion |
| --- | --- | --- |
| `sevenshifts_daily_sales_and_labor` money fields | **cents** | divide by 100 |
| `labor_percent` from that report | **fraction** | 0.28 means 28% |
| `*_labor_minutes` | minutes | divide by 60 for hours |
| `sevenshifts_executive_summary` | **dollars and percent** | already converted |

Quoting cents as dollars overstates figures 100×. Check the unit every time.

## Choosing the right source

| Question | Tool |
| --- | --- |
| Sales vs. labor, by day, by location | `sevenshifts_daily_sales_and_labor` |
| Per-employee hours, overtime, wages | `sevenshifts_hours_and_wages` (`punches: true`) |
| What was *scheduled* | `sevenshifts_list_shifts` |
| What was *actually worked* | `sevenshifts_list_time_punches` |
| Headcount / roster | `sevenshifts_list_users` (`status: "active"`) |
| Absence, PTO | `sevenshifts_list_time_off` |
| Tips | `sevenshifts_tip_pool_summary` |
| Staff sentiment | `sevenshifts_list_shift_feedback` |
| Why a day looked odd | `sevenshifts_list_events`, `sevenshifts_list_log_book_posts` |

Scheduled ≠ worked. Never present shift data as actual labor; use time punches
or the hours-and-wages report for anything cost-related.

## Practical constraints

- **`sevenshifts_hours_and_wages` is slow.** Always pass a `location_id` and
  keep the range to about one week, or it times out with a 500.
- **Some reports need the "The Works" plan.** A 402/403 means the plan, not a
  bug — say so plainly rather than retrying.
- **Bound every date range.** Punches and receipts are high-volume; an
  unbounded call returns truncated data with `"truncated": true`. When you see
  that flag, say the result was capped rather than treating it as complete.
- **Anything not covered** by a dedicated tool: `sevenshifts_api_request` with
  any path from https://developers.7shifts.com/llms.txt.

## Reporting well

- Align periods to payroll with `sevenshifts_list_payroll_periods` when the
  question is about pay, not calendar weeks.
- Labor % is the headline restaurant metric — always pair it with the sales and
  labor-cost figures it came from.
- Compare against `projected_sales` when it's available; variance to forecast is
  usually more interesting to an operator than the raw number.
- Call out overtime concentration by location: it is the most actionable cost
  lever in the data.
- Wages and individual pay are sensitive. Report them when asked, but don't
  volunteer per-person compensation in a summary that didn't call for it.
