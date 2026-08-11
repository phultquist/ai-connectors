/**
 * Tool registry for the 7shifts connector.
 *
 * Every tool is plain data plus a handler, so the stdio entry point and the
 * HTTP/Worker entry point expose an identical surface.
 */

import { SevenShiftsClient, SevenShiftsError } from "./client.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are hidden unless the server was started with writes enabled. */
  write?: boolean;
  handler: (args: Args, client: SevenShiftsClient) => Promise<unknown>;
}

type Args = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Shared schema fragments                                             */
/* ------------------------------------------------------------------ */

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const companyId = {
  company_id: {
    type: "integer",
    description:
      "7shifts company id. Optional — defaults to the company the API token belongs to.",
  },
};

const dateStr = (description: string) => ({
  type: "string",
  description: `${description} Format: YYYY-MM-DD.`,
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
});

const paging = {
  max_items: {
    type: "integer",
    description: "Maximum records to return across all pages. Default 500.",
    minimum: 1,
    maximum: 5000,
  },
  limit: {
    type: "integer",
    description: "Page size sent to the API (1-100). Default 100.",
    minimum: 1,
    maximum: 100,
  },
};

/** Copies only the keys that were actually supplied, renaming as instructed. */
function pick(args: Args, keys: (string | [string, string])[]) {
  const out: Record<string, any> = {};
  for (const key of keys) {
    const [from, to] = Array.isArray(key) ? key : [key, key];
    if (args[from] !== undefined && args[from] !== null && args[from] !== "") {
      out[to] = args[from];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export const TOOLS: ToolDef[] = [
  /* --- identity & company ----------------------------------------- */
  {
    name: "sevenshifts_whoami",
    title: "Who am I",
    description:
      "Identify the account behind the API token: user id, name, email, company id, and permission level. Call this first when you do not know the company id.",
    inputSchema: obj({}),
    handler: (_a, c) => c.whoami(),
  },
  {
    name: "sevenshifts_list_companies",
    title: "List companies",
    description:
      "List every company the token can access, with plan, timezone, and status. Use this to discover company ids for a multi-brand or multi-entity group.",
    inputSchema: obj({}),
    handler: (_a, c) => c.request("GET", "/companies"),
  },
  {
    name: "sevenshifts_get_company",
    title: "Get company",
    description: "Retrieve a single company's profile and settings.",
    inputSchema: obj({ ...companyId }),
    handler: async (a, c) =>
      c.request("GET", `/company/${await c.resolveCompanyId(a.company_id)}`),
  },
  {
    name: "sevenshifts_get_labor_settings",
    title: "Get labor settings",
    description:
      "Retrieve company labor settings: overtime rules, break rules, and labor-cost configuration. Useful for interpreting labor figures correctly.",
    inputSchema: obj({ ...companyId }),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/labor_settings`,
      ),
  },

  /* --- org structure ----------------------------------------------- */
  {
    name: "sevenshifts_list_locations",
    title: "List locations",
    description:
      "List all locations (stores/restaurants) for the company. Most reporting endpoints require a location_id, so start here.",
    inputSchema: obj({
      ...companyId,
      include_deleted: { type: "boolean", description: "Include deleted locations." },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/locations`, {
        query: pick(a, [["include_deleted", "deleted"], "limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_departments",
    title: "List departments",
    description:
      "List departments (e.g. Kitchen, Front of House), optionally filtered to one location.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer", description: "Filter to one location." },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/departments`, {
        query: pick(a, ["location_id", "limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_roles",
    title: "List roles",
    description:
      "List job roles (e.g. Server, Line Cook) with their department and location. Needed to break labor down by role.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer" },
      department_id: { type: "integer" },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/roles`, {
        query: pick(a, ["location_id", "department_id", "limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_users",
    title: "List employees",
    description:
      "List employees with contact details, employment type, and status. Use status='active' for current headcount.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer" },
      department_id: { type: "integer" },
      role_id: { type: "integer" },
      status: {
        type: "string",
        enum: ["active", "inactive"],
        description: "Filter by employment status.",
      },
      name: { type: "string", description: "Search by name." },
      modified_since: {
        type: "string",
        description: "ISO 8601 timestamp; only return users changed since then.",
      },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/users`, {
        query: pick(a, [
          "location_id",
          "department_id",
          "role_id",
          "status",
          "name",
          "modified_since",
          "limit",
        ]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_get_user",
    title: "Get employee",
    description: "Retrieve one employee's full record by user id.",
    inputSchema: obj({ ...companyId, user_id: { type: "integer" } }, ["user_id"]),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/users/${a.user_id}`,
      ),
  },
  {
    name: "sevenshifts_list_user_wages",
    title: "Get employee wages",
    description:
      "Retrieve wage history for one employee: hourly rates or salary per role, with effective dates. Sensitive compensation data.",
    inputSchema: obj({ ...companyId, user_id: { type: "integer" } }, ["user_id"]),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/users/${a.user_id}/wages`,
      ),
  },
  {
    name: "sevenshifts_list_user_assignments",
    title: "Get employee assignments",
    description:
      "List the locations, departments, and roles one employee is assigned to.",
    inputSchema: obj({ ...companyId, user_id: { type: "integer" } }, ["user_id"]),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/users/${a.user_id}/assignments`,
      ),
  },

  /* --- scheduling & time ------------------------------------------- */
  {
    name: "sevenshifts_list_shifts",
    title: "List scheduled shifts",
    description:
      "List scheduled shifts in a date range, with assigned employee, role, location, and times. The basis for scheduled-labor analysis. Filter with start_gte/start_lte.",
    inputSchema: obj({
      ...companyId,
      start_gte: {
        type: "string",
        description: "Only shifts starting at or after this ISO 8601 datetime or YYYY-MM-DD.",
      },
      start_lte: {
        type: "string",
        description: "Only shifts starting at or before this ISO 8601 datetime or YYYY-MM-DD.",
      },
      location_id: { type: "integer" },
      department_id: { type: "integer" },
      role_id: { type: "integer" },
      user_id: { type: "integer" },
      open: { type: "boolean", description: "Only unassigned (open) shifts." },
      include_draft: { type: "boolean", description: "Include unpublished draft shifts." },
      include_deleted: { type: "boolean" },
      sort_by: { type: "string", enum: ["start", "end", "modified"] },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/shifts`, {
        query: pick(a, [
          ["start_gte", "start[gte]"],
          ["start_lte", "start[lte]"],
          "location_id",
          "department_id",
          "role_id",
          "user_id",
          "open",
          "include_draft",
          "include_deleted",
          "sort_by",
          "limit",
        ]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_time_punches",
    title: "List time punches",
    description:
      "List actual clock-in/clock-out records with worked hours, breaks, and wages. This is actual (not scheduled) labor — use it for worked-hours and labor-cost analysis.",
    inputSchema: obj({
      ...companyId,
      clocked_in_gte: {
        type: "string",
        description: "Only punches clocked in at or after this ISO 8601 datetime or YYYY-MM-DD.",
      },
      clocked_in_lte: { type: "string", description: "Upper bound on clock-in time." },
      business_date_start: dateStr("Start of the business-date range."),
      business_date_end: dateStr("End of the business-date range."),
      location_id: { type: "integer" },
      department_id: { type: "integer" },
      role_id: { type: "integer" },
      user_id: { type: "integer" },
      approved: { type: "boolean", description: "Filter to approved punches only." },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/time_punches`, {
        query: pick(a, [
          ["clocked_in_gte", "clocked_in[gte]"],
          ["clocked_in_lte", "clocked_in[lte]"],
          "business_date_start",
          "business_date_end",
          "location_id",
          "department_id",
          "role_id",
          "user_id",
          "approved",
          "limit",
        ]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_time_off",
    title: "List time off",
    description:
      "List time-off requests with status, category (paid/unpaid/paid_sick), and date range. Use for absence and PTO-liability reporting.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer" },
      user_id: { type: "integer" },
      status: {
        type: "integer",
        description: "Status code: 0 pending, 1 approved, 2 declined.",
        enum: [0, 1, 2],
      },
      category: { type: "string", enum: ["paid", "unpaid", "paid_sick"] },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged("/time_off", {
        query: {
          company_id: await c.resolveCompanyId(a.company_id),
          ...pick(a, ["location_id", "user_id", "status", "category", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_list_availability",
    title: "List availability",
    description:
      "List employee availability records (when staff can and cannot work). Useful for scheduling-constraint and coverage analysis.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer" },
      user_id: { type: "integer" },
      week_gte: dateStr("Only availability for weeks on or after this date."),
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(
        `/company/${await c.resolveCompanyId(a.company_id)}/availabilities`,
        {
          query: pick(a, ["location_id", "user_id", "week_gte", "limit"]),
          maxItems: a.max_items,
        },
      ),
  },
  {
    name: "sevenshifts_list_events",
    title: "List events",
    description:
      "List calendar events (promotions, holidays, private bookings) in a date range. Useful context for sales and labor anomalies.",
    inputSchema: obj(
      {
        ...companyId,
        start_date: dateStr("Start of the range."),
        end_date: dateStr("End of the range."),
        location_id: { type: "integer" },
      },
      ["start_date", "end_date"],
    ),
    handler: async (a, c) =>
      c.request("GET", `/company/${await c.resolveCompanyId(a.company_id)}/events`, {
        query: pick(a, ["start_date", "end_date", "location_id"]),
      }),
  },
  {
    name: "sevenshifts_list_payroll_periods",
    title: "List payroll periods",
    description:
      "List payroll periods with their date ranges and punch-approval status. Use to align reporting with actual pay periods.",
    inputSchema: obj({
      ...companyId,
      include_punches_status: {
        type: "boolean",
        description: "Include whether punches in each period are fully approved.",
      },
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged("/time_clocking/payroll_periods", {
        query: {
          company_id: await c.resolveCompanyId(a.company_id),
          ...pick(a, ["include_punches_status", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },

  /* --- sales & labor reporting ------------------------------------- */
  {
    name: "sevenshifts_daily_sales_and_labor",
    title: "Daily sales and labor report",
    description:
      "THE core executive metric: per-day actual and projected sales, labor cost, labor minutes, overtime, labor percentage, and sales per labor hour for one location. Money fields are in CENTS; labor_percent is a fraction (0.28 = 28%). Requires the 'The Works' plan.",
    inputSchema: obj(
      {
        ...companyId,
        location_id: { type: "integer", description: "Required. Location to report on." },
        start_date: dateStr("First day of the range."),
        end_date: dateStr("Last day of the range."),
        department_id: { type: "integer" },
      },
      ["location_id", "start_date", "end_date"],
    ),
    handler: async (a, c) =>
      c.request("GET", "/reports/daily_sales_and_labor", {
        query: {
          company_id: await c.resolveCompanyId(a.company_id),
          ...pick(a, ["location_id", "start_date", "end_date", "department_id"]),
        },
      }),
  },
  {
    name: "sevenshifts_hours_and_wages",
    title: "Worked hours and wages report",
    description:
      "Per-employee worked hours and wages broken out by week and role: regular/overtime/holiday hours and pay, plus tips. Set punches=true for actual punched time or false for scheduled. Requires the 'The Works' plan. This report is slow — always pass a location_id and keep the range to roughly one week.",
    inputSchema: obj(
      {
        ...companyId,
        from: dateStr("Start of the range."),
        to: dateStr("End of the range."),
        punches: {
          type: "boolean",
          description:
            "true = report on actual time punches; false = report on scheduled shifts.",
        },
        location_id: { type: "integer", description: "Strongly recommended to avoid timeouts." },
        department_id: { type: "integer" },
        role_id: { type: "integer" },
        user_id: { type: "integer" },
        include_tips: { type: "boolean" },
      },
      ["from", "to", "punches"],
    ),
    handler: async (a, c) =>
      c.request("GET", "/reports/hours_and_wages", {
        query: {
          company_id: await c.resolveCompanyId(a.company_id),
          ...pick(a, [
            "from",
            "to",
            "punches",
            "location_id",
            "department_id",
            "role_id",
            "user_id",
            "include_tips",
          ]),
        },
      }),
  },
  {
    name: "sevenshifts_daily_stats",
    title: "Daily stats for a location",
    description:
      "Retrieve sales, labor, and forecast statistics for a single location on a single date.",
    inputSchema: obj(
      {
        ...companyId,
        location_id: { type: "integer" },
        date: dateStr("The date to report on."),
        department_id: { type: "integer" },
        include_future: { type: "boolean", description: "Include forecast/future values." },
      },
      ["location_id", "date"],
    ),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/location/${a.location_id}/daily_stats`,
        { query: pick(a, ["date", "department_id", "include_future"]) },
      ),
  },
  {
    name: "sevenshifts_receipts_summary",
    title: "Sales receipts summary",
    description:
      "Aggregated POS sales receipts for a location over a date range — totals without the per-transaction detail. Prefer this over listing raw receipts for dashboards.",
    inputSchema: obj(
      {
        ...companyId,
        location_id: { type: "integer" },
        receipt_date_gte: dateStr("Start of the range."),
        receipt_date_lte: dateStr("End of the range."),
      },
      ["location_id"],
    ),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/receipts_summary`,
        {
          query: pick(a, [
            "location_id",
            ["receipt_date_gte", "receipt_date[gte]"],
            ["receipt_date_lte", "receipt_date[lte]"],
          ]),
        },
      ),
  },
  {
    name: "sevenshifts_list_receipts",
    title: "List sales receipts",
    description:
      "List individual POS sales receipts (transaction-level detail) for a location. High volume — always bound the date range.",
    inputSchema: obj(
      {
        ...companyId,
        location_id: { type: "integer" },
        receipt_date_gte: dateStr("Start of the range."),
        receipt_date_lte: dateStr("End of the range."),
        status: { type: "string" },
        ...paging,
      },
      ["location_id"],
    ),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/receipts`, {
        query: pick(a, [
          "location_id",
          ["receipt_date_gte", "receipt_date[gte]"],
          ["receipt_date_lte", "receipt_date[lte]"],
          "status",
          "limit",
        ]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_tip_pool_summary",
    title: "Tip pool summary report",
    description:
      "Tip pool summary for a location over a date range: tips collected, pooled, and distributed.",
    inputSchema: obj(
      {
        ...companyId,
        location_id: { type: "integer" },
        start_date: dateStr("Start of the range."),
        end_date: dateStr("End of the range."),
      },
      ["location_id", "start_date", "end_date"],
    ),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/locations/${a.location_id}/tip_pool_summary_report`,
        { query: pick(a, ["start_date", "end_date"]) },
      ),
  },

  /* --- engagement --------------------------------------------------- */
  {
    name: "sevenshifts_list_shift_feedback",
    title: "List shift feedback",
    description:
      "Employee shift-feedback ratings and comments over a date range — a leading indicator of staff sentiment and turnover risk.",
    inputSchema: obj(
      {
        ...companyId,
        start_date: dateStr("Start of the range."),
        end_date: dateStr("End of the range."),
        location_id: { type: "integer" },
        user_id: { type: "integer" },
        ...paging,
      },
      ["start_date", "end_date"],
    ),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/shift_feedback`, {
        query: pick(a, ["start_date", "end_date", "location_id", "user_id", "limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenshifts_engagement_overview",
    title: "Engagement overview",
    description:
      "Engagement metrics for a location: participation, sentiment, and related staff-health indicators.",
    inputSchema: obj({ ...companyId, location_id: { type: "integer" } }, ["location_id"]),
    handler: async (a, c) =>
      c.request(
        "GET",
        `/company/${await c.resolveCompanyId(a.company_id)}/locations/${a.location_id}/engage_overview`,
      ),
  },
  {
    name: "sevenshifts_list_log_book_posts",
    title: "List log book posts",
    description:
      "Manager log book entries — shift notes and incident reports. Qualitative context behind the numbers.",
    inputSchema: obj({
      ...companyId,
      location_id: { type: "integer" },
      posted_date_gte: dateStr("Start of the range."),
      posted_date_lte: dateStr("End of the range."),
      ...paging,
    }),
    handler: async (a, c) =>
      c.getPaged(`/company/${await c.resolveCompanyId(a.company_id)}/log_book_posts`, {
        query: pick(a, [
          "location_id",
          "posted_date_gte",
          "posted_date_lte",
          "limit",
        ]),
        maxItems: a.max_items,
      }),
  },

  /* --- composite ----------------------------------------------------- */
  {
    name: "sevenshifts_executive_summary",
    title: "Executive summary",
    description:
      "One-call executive rollup for a date range across every location (or a chosen subset): sales, labor cost, labor percentage, overtime hours, sales per labor hour, and a per-location breakdown. Money is converted to dollars. Built on the daily sales & labor report, so it needs the 'The Works' plan; locations that fail are reported individually rather than failing the whole call.",
    inputSchema: obj(
      {
        ...companyId,
        start_date: dateStr("First day of the range."),
        end_date: dateStr("Last day of the range."),
        location_ids: {
          type: "array",
          items: { type: "integer" },
          description: "Locations to include. Omit to include all active locations.",
        },
        include_daily: {
          type: "boolean",
          description: "Include the per-day series for each location. Default false.",
        },
      },
      ["start_date", "end_date"],
    ),
    handler: async (a, c) => executiveSummary(a, c),
  },

  /* --- escape hatch --------------------------------------------------- */
  {
    name: "sevenshifts_api_request",
    title: "Raw 7shifts API request",
    description:
      "Escape hatch for any 7shifts v2 endpoint not covered by a dedicated tool. Pass a root-relative path such as '/company/435911/roles'. GET always works; other methods only if the server was started with writes enabled. Full endpoint list: https://developers.7shifts.com/llms.txt",
    inputSchema: obj(
      {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method. Defaults to GET.",
        },
        path: {
          type: "string",
          description:
            "Root-relative path under https://api.7shifts.com/v2, e.g. '/company/435911/shifts'.",
        },
        query: {
          type: "object",
          description: "Query-string parameters as a flat object.",
          additionalProperties: true,
        },
        body: { type: "object", description: "JSON body for write methods.", additionalProperties: true },
        paginate: {
          type: "boolean",
          description: "Follow cursor pagination and merge all pages. GET only.",
        },
        max_items: { type: "integer", description: "Cap when paginate is true. Default 500." },
      },
      ["path"],
    ),
    handler: async (a, c) => {
      const method = (a.method ?? "GET").toUpperCase();
      if (a.paginate && method === "GET") {
        return c.getPaged(a.path, { query: a.query, maxItems: a.max_items });
      }
      return c.request(method, a.path, { query: a.query, body: a.body });
    },
  },
];

/* ------------------------------------------------------------------ */
/* Composite report                                                    */
/* ------------------------------------------------------------------ */

const cents = (n: unknown) => (typeof n === "number" ? n / 100 : 0);
const round = (n: number, places = 2) =>
  Math.round(n * 10 ** places) / 10 ** places;

async function executiveSummary(a: Args, c: SevenShiftsClient) {
  const company = await c.resolveCompanyId(a.company_id);

  let locations: { id: number; name: string }[];
  if (Array.isArray(a.location_ids) && a.location_ids.length) {
    locations = a.location_ids.map((id: number) => ({ id, name: `Location ${id}` }));
    const all = await c.getPaged<any>(`/company/${company}/locations`, { maxItems: 500 });
    for (const loc of locations) {
      const match = all.data.find((l: any) => l.id === loc.id);
      if (match) loc.name = match.name ?? loc.name;
    }
  } else {
    const all = await c.getPaged<any>(`/company/${company}/locations`, { maxItems: 500 });
    locations = all.data
      .filter((l: any) => !l.deleted)
      .map((l: any) => ({ id: l.id, name: l.name ?? `Location ${l.id}` }));
  }

  const perLocation = await Promise.all(
    locations.map(async (loc) => {
      try {
        const res = await c.request("GET", "/reports/daily_sales_and_labor", {
          query: {
            company_id: company,
            location_id: loc.id,
            start_date: a.start_date,
            end_date: a.end_date,
          },
        });
        const days: any[] = Array.isArray(res?.data) ? res.data : [];
        const sales = days.reduce((s, d) => s + cents(d.actual_sales), 0);
        const projected = days.reduce((s, d) => s + cents(d.projected_sales), 0);
        const labor = days.reduce((s, d) => s + cents(d.actual_labor_cost), 0);
        const laborMinutes = days.reduce((s, d) => s + (d.actual_labor_minutes ?? 0), 0);
        const otMinutes = days.reduce((s, d) => s + (d.actual_ot_minutes ?? 0), 0);
        const laborHours = laborMinutes / 60;

        return {
          location_id: loc.id,
          location_name: loc.name,
          days_reported: days.length,
          actual_sales: round(sales),
          projected_sales: round(projected),
          sales_vs_projection_pct:
            projected > 0 ? round(((sales - projected) / projected) * 100, 1) : null,
          labor_cost: round(labor),
          labor_pct_of_sales: sales > 0 ? round((labor / sales) * 100, 1) : null,
          labor_hours: round(laborHours, 1),
          overtime_hours: round(otMinutes / 60, 1),
          overtime_pct_of_hours:
            laborMinutes > 0 ? round((otMinutes / laborMinutes) * 100, 1) : null,
          sales_per_labor_hour: laborHours > 0 ? round(sales / laborHours) : null,
          ...(a.include_daily ? { daily: days } : {}),
        };
      } catch (err) {
        return {
          location_id: loc.id,
          location_name: loc.name,
          error:
            err instanceof SevenShiftsError
              ? `${err.status}: ${err.detail}`
              : String((err as Error).message ?? err),
        };
      }
    }),
  );

  const ok = perLocation.filter((l: any) => !l.error) as any[];
  const totalSales = ok.reduce((s, l) => s + l.actual_sales, 0);
  const totalLabor = ok.reduce((s, l) => s + l.labor_cost, 0);
  const totalHours = ok.reduce((s, l) => s + l.labor_hours, 0);
  const totalOt = ok.reduce((s, l) => s + l.overtime_hours, 0);

  return {
    company_id: company,
    period: { start_date: a.start_date, end_date: a.end_date },
    currency_note: "All money values are in dollars (converted from the API's cents).",
    totals: {
      locations_reported: ok.length,
      locations_failed: perLocation.length - ok.length,
      actual_sales: round(totalSales),
      labor_cost: round(totalLabor),
      labor_pct_of_sales: totalSales > 0 ? round((totalLabor / totalSales) * 100, 1) : null,
      labor_hours: round(totalHours, 1),
      overtime_hours: round(totalOt, 1),
      sales_per_labor_hour: totalHours > 0 ? round(totalSales / totalHours) : null,
    },
    locations: perLocation,
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export function listTools(allowWrites: boolean) {
  return TOOLS.filter((t) => allowWrites || !t.write).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export async function callTool(
  name: string,
  args: Args,
  client: SevenShiftsClient,
): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }
  try {
    const result = await tool.handler(args ?? {}, client);
    return { text: JSON.stringify(result, null, 2), isError: false };
  } catch (err) {
    const message =
      err instanceof SevenShiftsError
        ? err.message
        : String((err as Error)?.message ?? err);
    return { text: message, isError: true };
  }
}
