/**
 * Minimal SevenRooms API client.
 *
 * Uses only `fetch`, so the same file runs on Node 18+ and Cloudflare Workers.
 *
 * SevenRooms' API is not publicly documented — access requires a partnership
 * agreement — so response shapes here are handled defensively rather than
 * assumed. Anything unexpected is passed through to the caller intact.
 */

export const DEFAULT_BASE_URL = "https://api.sevenrooms.com";
export const DEFAULT_API_VERSION = "2_4";

export class SevenRoomsError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`SevenRooms API ${status} on ${path}: ${detail}`);
    this.name = "SevenRoomsError";
  }
}

/**
 * How to present the credential. SevenRooms has been observed accepting both a
 * bearer token and an X-API-Key header depending on the integration; "both"
 * sends the same value in both headers so a new key works either way.
 */
export type AuthStyle = "bearer" | "apikey" | "both";

export interface ClientOptions {
  token: string;
  /** Default venue id used when a tool call omits one. */
  venueId?: string;
  apiVersion?: string;
  baseUrl?: string;
  authStyle?: AuthStyle;
  /** When false (the default) every non-GET request is refused. */
  allowWrites?: boolean;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export interface PagedResult<T = unknown> {
  data: T[];
  truncated?: true;
  next_cursor?: string;
  pages_fetched: number;
  /** Which envelope shape the response used — useful while the API is unverified. */
  shape?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class SevenRoomsClient {
  private readonly token: string;
  private readonly baseUrl: string;
  readonly apiVersion: string;
  private readonly authStyle: AuthStyle;
  readonly allowWrites: boolean;
  readonly venueId?: string;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("A SevenRooms API key is required.");
    this.token = opts.token;
    this.venueId = opts.venueId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.authStyle = opts.authStyle ?? "both";
    this.allowWrites = opts.allowWrites ?? false;
  }

  requireVenue(explicit?: string): string {
    const venue = explicit || this.venueId;
    if (!venue) {
      throw new Error(
        "No venue id given. Call sevenrooms_list_venues first, then pass venue_id " +
          "(or set SEVENROOMS_VENUE_ID on the server).",
      );
    }
    return venue;
  }

  async request(
    method: string,
    path: string,
    { query, body }: RequestOptions = {},
  ): Promise<any> {
    const verb = method.toUpperCase();
    if (verb !== "GET" && !this.allowWrites) {
      throw new Error(
        `This connector is in read-only mode, so ${verb} ${path} was refused. ` +
          "Set SEVENROOMS_ALLOW_WRITES=true on the server to enable writes.",
      );
    }
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
      throw new Error(
        `Invalid path ${JSON.stringify(path)}. Use a root-relative path such as "/2_4/venues".`,
      );
    }

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "sevenrooms-mcp/1.0",
    };
    if (this.authStyle === "bearer" || this.authStyle === "both") {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.authStyle === "apikey" || this.authStyle === "both") {
      headers["X-API-Key"] = this.token;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: SevenRoomsError | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        method: verb,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* leave as text */
      }

      // SevenRooms returns 200 with a "status" field for some errors.
      const embeddedStatus = typeof parsed?.status === "number" ? parsed.status : undefined;
      const effective = res.ok && embeddedStatus && embeddedStatus >= 400 ? embeddedStatus : res.status;

      if (effective < 400) return parsed;

      lastError = new SevenRoomsError(effective, describeFailure(parsed, res), path);
      if (!RETRYABLE.has(effective) || attempt === 3) throw lastError;

      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 500 + Math.random() * 250;
      await sleep(Math.min(backoff, 15_000));
    }
    throw lastError ?? new Error(`Request to ${path} failed.`);
  }

  /**
   * Collects list results across pages.
   *
   * The envelope is not documented, so this accepts the shapes SevenRooms is
   * known to use (`data.results`, `data`, `results`) and follows either a
   * cursor or a page/offset style, stopping as soon as a page yields nothing.
   */
  async getPaged<T = unknown>(
    path: string,
    {
      query,
      maxItems = 500,
      maxPages = 20,
    }: RequestOptions & { maxItems?: number; maxPages?: number } = {},
  ): Promise<PagedResult<T>> {
    const collected: T[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let shape = "unknown";

    while (pages < maxPages) {
      const page = await this.request("GET", path, {
        query: { ...query, ...(cursor ? { cursor } : {}), limit: query?.limit ?? 100 },
      });
      pages++;

      const { rows, detected } = extractRows<T>(page);
      shape = detected;
      collected.push(...rows);

      const next = extractCursor(page);
      if (collected.length >= maxItems) {
        return {
          data: collected.slice(0, maxItems),
          truncated: true,
          next_cursor: next,
          pages_fetched: pages,
          shape,
        };
      }
      if (!next || rows.length === 0) {
        return { data: collected, pages_fetched: pages, shape };
      }
      cursor = next;
    }

    return { data: collected, truncated: true, next_cursor: cursor, pages_fetched: pages, shape };
  }
}

/** Finds the array of records in an undocumented envelope. */
function extractRows<T>(page: any): { rows: T[]; detected: string } {
  if (Array.isArray(page)) return { rows: page, detected: "array" };
  if (Array.isArray(page?.data?.results)) return { rows: page.data.results, detected: "data.results" };
  if (Array.isArray(page?.data)) return { rows: page.data, detected: "data" };
  if (Array.isArray(page?.results)) return { rows: page.results, detected: "results" };
  for (const key of ["venues", "reservations", "clients", "waitlist", "requests", "items"]) {
    if (Array.isArray(page?.data?.[key])) return { rows: page.data[key], detected: `data.${key}` };
    if (Array.isArray(page?.[key])) return { rows: page[key], detected: key };
  }
  // A single object is a one-row result rather than an error.
  if (page && typeof page === "object") return { rows: [page as T], detected: "object" };
  return { rows: [], detected: "empty" };
}

function extractCursor(page: any): string | undefined {
  return (
    page?.data?.cursor ??
    page?.cursor ??
    page?.data?.next_cursor ??
    page?.next_cursor ??
    page?.meta?.cursor?.next ??
    undefined
  );
}

function describeFailure(parsed: any, res: Response): string {
  const detail =
    parsed?.msg ?? parsed?.message ?? parsed?.error ?? parsed?.detail ??
    (typeof parsed === "string" ? parsed.slice(0, 300) : "") ??
    res.statusText;
  const text = String(detail || res.statusText || "request failed");
  if (res.status === 401 || res.status === 403) {
    return `${text} (check the API key, and that SEVENROOMS_AUTH_STYLE matches what your key expects — "bearer", "apikey", or "both")`;
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
