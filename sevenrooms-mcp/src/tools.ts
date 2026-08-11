/**
 * Tool registry for the SevenRooms connector.
 *
 * Endpoint paths were confirmed by probing (the API distinguishes 401 for a
 * real route from 404 for an unknown one). Query-parameter names are the
 * conventional ones and are NOT verified against live data — when a filter is
 * ignored or rejected, fall back to sevenrooms_api_request.
 */

import { SevenRoomsClient, SevenRoomsError } from "./client.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: boolean;
  handler: (args: Args, client: SevenRoomsClient) => Promise<unknown>;
}

type Args = Record<string, any>;

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const venueId = {
  venue_id: {
    type: "string",
    description:
      "SevenRooms venue id. Optional if the server has a default venue configured; otherwise call sevenrooms_list_venues first.",
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
    description: "Page size sent to the API. Default 100.",
    minimum: 1,
    maximum: 400,
  },
};

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

const v = (client: SevenRoomsClient) => client.apiVersion;

export const TOOLS: ToolDef[] = [
  /* --- venues -------------------------------------------------------- */
  {
    name: "sevenrooms_list_venues",
    title: "List venues",
    description:
      "List every venue the API key can access, with id and name. Start here — most other tools need a venue_id.",
    inputSchema: obj({ ...paging }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/venues`, { query: pick(a, ["limit"]), maxItems: a.max_items }),
  },
  {
    name: "sevenrooms_get_venue",
    title: "Get venue",
    description: "Retrieve one venue's configuration and details.",
    inputSchema: obj({ ...venueId }),
    handler: (a, c) => c.request("GET", `/${v(c)}/venues/${c.requireVenue(a.venue_id)}`),
  },

  /* --- reservations -------------------------------------------------- */
  {
    name: "sevenrooms_list_reservations",
    title: "List reservations",
    description:
      "List reservations for a venue over a date range, with party size, status, guest, and time. The core of covers and booking analysis. Always bound the date range.",
    inputSchema: obj(
      {
        ...venueId,
        from_date: dateStr("Start of the range."),
        to_date: dateStr("End of the range."),
        status: { type: "string", description: "Filter by reservation status, e.g. BOOKED or CANCELED." },
        client_id: { type: "string", description: "Only reservations for one guest." },
        ...paging,
      },
      ["from_date", "to_date"],
    ),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/reservations`, {
        query: {
          venue_id: c.requireVenue(a.venue_id),
          ...pick(a, ["from_date", "to_date", "status", "client_id", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenrooms_get_reservation",
    title: "Get reservation",
    description: "Retrieve one reservation in full by its id.",
    inputSchema: obj({ reservation_id: { type: "string" } }, ["reservation_id"]),
    handler: (a, c) => c.request("GET", `/${v(c)}/reservations/${a.reservation_id}`),
  },

  /* --- guests -------------------------------------------------------- */
  {
    name: "sevenrooms_list_clients",
    title: "List guests",
    description:
      "List guest (client) profiles for a venue — names, contact details, visit history, tags, and lifetime value. Sensitive personal data; use only as the question requires.",
    inputSchema: obj({
      ...venueId,
      query: { type: "string", description: "Search by name, email, or phone." },
      updated_since: { type: "string", description: "ISO 8601 timestamp; only guests changed since then." },
      ...paging,
    }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/clients`, {
        query: {
          venue_id: c.requireVenue(a.venue_id),
          ...pick(a, ["query", "updated_since", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenrooms_get_client",
    title: "Get guest",
    description: "Retrieve one guest profile in full, including visit history and tags.",
    inputSchema: obj({ client_id: { type: "string" } }, ["client_id"]),
    handler: (a, c) => c.request("GET", `/${v(c)}/clients/${a.client_id}`),
  },

  /* --- demand -------------------------------------------------------- */
  {
    name: "sevenrooms_list_waitlist",
    title: "List waitlist entries",
    description:
      "List waitlist entries for a venue — walk-in demand and quoted wait times. Read alongside reservations to see demand the book didn't capture.",
    inputSchema: obj({
      ...venueId,
      from_date: dateStr("Start of the range."),
      to_date: dateStr("End of the range."),
      ...paging,
    }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/waitlist`, {
        query: {
          venue_id: c.requireVenue(a.venue_id),
          ...pick(a, ["from_date", "to_date", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenrooms_list_requests",
    title: "List reservation requests",
    description:
      "List booking requests for a venue — demand that did not convert into a confirmed reservation. Useful for measuring turned-away covers.",
    inputSchema: obj({
      ...venueId,
      from_date: dateStr("Start of the range."),
      to_date: dateStr("End of the range."),
      ...paging,
    }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/requests`, {
        query: {
          venue_id: c.requireVenue(a.venue_id),
          ...pick(a, ["from_date", "to_date", "limit"]),
        },
        maxItems: a.max_items,
      }),
  },

  /* --- capacity ------------------------------------------------------ */
  {
    name: "sevenrooms_get_availability",
    title: "Get availability",
    description:
      "Retrieve bookable availability for a venue on a date — open times by party size. Use to see where capacity is going unsold.",
    inputSchema: obj(
      {
        ...venueId,
        date: dateStr("The date to check."),
        party_size: { type: "integer", description: "Party size to check availability for.", minimum: 1 },
        time: { type: "string", description: "Time of day to centre the search on, e.g. 19:00." },
      },
      ["date"],
    ),
    handler: (a, c) =>
      c.request("GET", `/${v(c)}/venues/${c.requireVenue(a.venue_id)}/availability`, {
        query: pick(a, ["date", "party_size", "time"]),
      }),
  },
  {
    name: "sevenrooms_list_tables",
    title: "List tables",
    description:
      "List a venue's tables and seating configuration — capacity, sections, and floor plan detail.",
    inputSchema: obj({ ...venueId, ...paging }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/venues/${c.requireVenue(a.venue_id)}/tables`, {
        query: pick(a, ["limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenrooms_list_shifts",
    title: "List service shifts",
    description:
      "List a venue's service periods (lunch, dinner, brunch) with their times. Needed to bucket covers by daypart.",
    inputSchema: obj({
      ...venueId,
      from_date: dateStr("Start of the range."),
      to_date: dateStr("End of the range."),
      ...paging,
    }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/venues/${c.requireVenue(a.venue_id)}/shifts`, {
        query: pick(a, ["from_date", "to_date", "limit"]),
        maxItems: a.max_items,
      }),
  },
  {
    name: "sevenrooms_list_events",
    title: "List events",
    description:
      "List a venue's events and special bookings. Context for unusual cover counts on a given night.",
    inputSchema: obj({
      ...venueId,
      from_date: dateStr("Start of the range."),
      to_date: dateStr("End of the range."),
      ...paging,
    }),
    handler: (a, c) =>
      c.getPaged(`/${v(c)}/venues/${c.requireVenue(a.venue_id)}/events`, {
        query: pick(a, ["from_date", "to_date", "limit"]),
        maxItems: a.max_items,
      }),
  },

  /* --- composite ------------------------------------------------------ */
  {
    name: "sevenrooms_covers_summary",
    title: "Covers summary",
    description:
      "Rollup of reservations over a date range for one or more venues: total covers, reservation count, average party size, cancellations and no-shows, and a per-day series. Computed from the reservations list, so it degrades gracefully if a field is missing.",
    inputSchema: obj(
      {
        from_date: dateStr("Start of the range."),
        to_date: dateStr("End of the range."),
        venue_ids: {
          type: "array",
          items: { type: "string" },
          description: "Venues to include. Omit to use the server's default venue.",
        },
        include_daily: { type: "boolean", description: "Include the per-day series. Default true." },
      },
      ["from_date", "to_date"],
    ),
    handler: (a, c) => coversSummary(a, c),
  },

  /* --- escape hatch ---------------------------------------------------- */
  {
    name: "sevenrooms_api_request",
    title: "Raw SevenRooms API request",
    description:
      "Escape hatch for any SevenRooms endpoint or parameter not covered by a dedicated tool. Pass a root-relative path such as '/2_4/reservations'. GET always works; other methods only if the server was started with writes enabled. Use this when a typed tool's filter appears to be ignored.",
    inputSchema: obj(
      {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method. Defaults to GET.",
        },
        path: {
          type: "string",
          description: "Root-relative path under https://api.sevenrooms.com, e.g. '/2_4/venues'.",
        },
        query: { type: "object", description: "Query-string parameters.", additionalProperties: true },
        body: { type: "object", description: "JSON body for write methods.", additionalProperties: true },
        paginate: { type: "boolean", description: "Follow pagination and merge pages. GET only." },
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

const num = (...candidates: unknown[]) => {
  for (const value of candidates) {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return 0;
};

const str = (...candidates: unknown[]) => {
  for (const value of candidates) if (typeof value === "string" && value) return value;
  return "";
};

async function coversSummary(a: Args, c: SevenRoomsClient) {
  const venues: string[] =
    Array.isArray(a.venue_ids) && a.venue_ids.length ? a.venue_ids : [c.requireVenue()];

  const perVenue = await Promise.all(
    venues.map(async (venue) => {
      try {
        const res = await c.getPaged<any>(`/${v(c)}/reservations`, {
          query: { venue_id: venue, from_date: a.from_date, to_date: a.to_date },
          maxItems: 5000,
        });
        const rows = res.data;

        let covers = 0;
        let canceled = 0;
        let noShow = 0;
        const byDay = new Map<string, { covers: number; reservations: number }>();

        for (const r of rows) {
          const size = num(r?.party_size, r?.max_guests, r?.guests, r?.covers);
          const status = str(r?.status, r?.reservation_status).toUpperCase();
          if (status.includes("CANCEL")) canceled++;
          else if (status.includes("NO_SHOW") || status.includes("NOSHOW")) noShow++;
          else covers += size;

          const day = str(r?.date, r?.arrival_time, r?.created).slice(0, 10);
          if (day) {
            const bucket = byDay.get(day) ?? { covers: 0, reservations: 0 };
            bucket.covers += size;
            bucket.reservations += 1;
            byDay.set(day, bucket);
          }
        }

        const counted = rows.length - canceled - noShow;
        return {
          venue_id: venue,
          reservations: rows.length,
          seated_reservations: counted,
          covers,
          average_party_size: counted > 0 ? Math.round((covers / counted) * 10) / 10 : null,
          canceled,
          no_shows: noShow,
          truncated: res.truncated ?? false,
          response_shape: res.shape,
          ...(a.include_daily === false
            ? {}
            : {
                daily: [...byDay.entries()]
                  .sort(([x], [y]) => x.localeCompare(y))
                  .map(([date, t]) => ({ date, ...t })),
              }),
        };
      } catch (err) {
        return {
          venue_id: venue,
          error:
            err instanceof SevenRoomsError
              ? `${err.status}: ${err.detail}`
              : String((err as Error)?.message ?? err),
        };
      }
    }),
  );

  const ok = perVenue.filter((x: any) => !x.error) as any[];
  return {
    period: { from_date: a.from_date, to_date: a.to_date },
    note:
      "Covers are summed from each reservation's party size, excluding cancellations and no-shows. " +
      "Field names vary by SevenRooms configuration; check response_shape if a figure looks wrong.",
    totals: {
      venues_reported: ok.length,
      venues_failed: perVenue.length - ok.length,
      reservations: ok.reduce((s, x) => s + x.reservations, 0),
      covers: ok.reduce((s, x) => s + x.covers, 0),
      canceled: ok.reduce((s, x) => s + x.canceled, 0),
      no_shows: ok.reduce((s, x) => s + x.no_shows, 0),
    },
    venues: perVenue,
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
  client: SevenRoomsClient,
): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  try {
    const result = await tool.handler(args ?? {}, client);
    return { text: JSON.stringify(result, null, 2), isError: false };
  } catch (err) {
    const message =
      err instanceof SevenRoomsError ? err.message : String((err as Error)?.message ?? err);
    return { text: message, isError: true };
  }
}
