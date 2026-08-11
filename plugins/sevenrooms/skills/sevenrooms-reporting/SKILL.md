---
name: sevenrooms-reporting
description: Pull SevenRooms reservations, covers, guest, and waitlist data and turn it into executive reporting. Use when the user asks about covers, reservations, bookings, no-shows, cancellations, party size, waitlist, guest profiles, VIPs, table availability, or restaurant demand.
---

# SevenRooms reporting

Guidance for answering demand and guest questions from SevenRooms data.

## Orient yourself first

1. `sevenrooms_list_venues` — **most tools need a `venue_id`.** Keep the id → name
   mapping; ids are opaque strings, so always label output with venue names.
2. The server may have a default venue configured, in which case `venue_id` is
   optional for a single-venue operator.

## Start with the rollup

For "how busy were we" questions, call `sevenrooms_covers_summary` with
`from_date` and `to_date`. It returns covers, reservation count, average party
size, cancellations, and no-shows, plus a per-day series.

## Read this before quoting numbers

**The SevenRooms API is not publicly documented, and field names vary by
account configuration.** This connector handles several response envelopes and
reports which one it saw in a `response_shape` field.

- If `covers` looks implausibly low, party size may live under a different key
  for this account. Pull a couple of raw reservations with
  `sevenrooms_list_reservations` and inspect the actual fields before trusting
  an aggregate.
- If a filter seems ignored (a date range returning everything), the parameter
  name may differ. Fall back to `sevenrooms_api_request` and say you did.
- `"truncated": true` means the result was capped — say so rather than
  presenting it as complete.

Prefer stating what a field literally says over inferring a business metric
from an uncertain mapping.

## Choosing the right source

| Question | Tool |
| --- | --- |
| Covers and bookings over time | `sevenrooms_covers_summary` |
| Individual bookings | `sevenrooms_list_reservations` |
| Guest profiles, VIPs, visit history | `sevenrooms_list_clients` |
| Walk-in demand, wait times | `sevenrooms_list_waitlist` |
| Demand that never converted | `sevenrooms_list_requests` |
| Unsold capacity | `sevenrooms_get_availability` |
| Seating configuration | `sevenrooms_list_tables` |
| Bucketing by daypart | `sevenrooms_list_shifts` |
| Why a night looked unusual | `sevenrooms_list_events` |
| Anything else | `sevenrooms_api_request` |

## Reporting well

- **Covers ≠ reservations.** A reservation carries a party size; covers is the
  sum. Say which one you are quoting.
- Exclude cancellations and no-shows from covers, and report them separately —
  no-show rate is itself a metric operators act on.
- Waitlist and requests together are the demand the book *didn't* capture; pair
  them with availability to distinguish "sold out" from "not booked".
- Guest records are personal data. Report them when asked, but don't volunteer
  names, contact details, or spend history in a summary that didn't call for it.
- Combined with a labor connector, covers per labor hour is the metric that ties
  demand to cost — but only compute it if both sides cover the same venue and
  date range.
