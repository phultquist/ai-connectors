/**
 * Minimal 7shifts API v2 client.
 *
 * Uses only `fetch`, so the same file runs unchanged on Node 18+ and on
 * Cloudflare Workers.
 */

export const DEFAULT_BASE_URL = "https://api.7shifts.com/v2";
export const DEFAULT_API_VERSION = "2026-06-01";

export class SevenShiftsError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`7shifts API ${status} on ${path}: ${detail}`);
    this.name = "SevenShiftsError";
  }
}

export interface ClientOptions {
  token: string;
  /** Default company id used when a tool call omits one. */
  companyId?: number;
  apiVersion?: string;
  baseUrl?: string;
  /** When false (the default) every non-GET request is refused. */
  allowWrites?: boolean;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
}

interface PageOptions extends RequestOptions {
  /** Stop after this many records have been collected. */
  maxItems?: number;
  /** Safety valve so a bad filter can't walk an entire company's history. */
  maxPages?: number;
}

export interface PagedResult<T = unknown> {
  data: T[];
  /** Present only when the caller's limit stopped the walk early. */
  truncated?: true;
  next_cursor?: string;
  pages_fetched: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class SevenShiftsClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  readonly allowWrites: boolean;
  private companyId?: number;
  private whoamiCache?: Promise<any>;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("A 7shifts API access token is required.");
    this.token = opts.token;
    this.companyId = opts.companyId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.allowWrites = opts.allowWrites ?? false;
  }

  /**
   * The company the token belongs to. Falls back to /whoami, which is
   * authoritative for access-token auth, and caches the result.
   */
  async resolveCompanyId(explicit?: number): Promise<number> {
    if (explicit) return explicit;
    if (this.companyId) return this.companyId;
    const who = await this.whoami();
    const id = who?.data?.users?.[0]?.company_id;
    if (typeof id !== "number") {
      throw new Error(
        "Could not determine a company id. Pass company_id explicitly or set SEVENSHIFTS_COMPANY_ID.",
      );
    }
    this.companyId = id;
    return id;
  }

  whoami(): Promise<any> {
    this.whoamiCache ??= this.request("GET", "/whoami");
    return this.whoamiCache;
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
          "Set SEVENSHIFTS_ALLOW_WRITES=true on the server to enable writes.",
      );
    }
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
      throw new Error(
        `Invalid path ${JSON.stringify(path)}. Use a root-relative path such as "/company/123/shifts".`,
      );
    }

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "x-api-version": this.apiVersion,
      "User-Agent": "sevenshifts-mcp/1.0",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: SevenShiftsError | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        method: verb,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const detail = await describeFailure(res);
      lastError = new SevenShiftsError(res.status, detail, path);
      if (!RETRYABLE.has(res.status) || attempt === 3) throw lastError;

      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500 + Math.random() * 250;
      await sleep(Math.min(backoff, 15_000));
    }
    throw lastError ?? new Error(`Request to ${path} failed.`);
  }

  /**
   * Walks 7shifts' keyset pagination (`meta.cursor.next`) and concatenates
   * `data` across pages.
   */
  async getPaged<T = unknown>(
    path: string,
    { query, maxItems = 500, maxPages = 20 }: PageOptions = {},
  ): Promise<PagedResult<T>> {
    const collected: T[] = [];
    let cursor: string | undefined;
    let pages = 0;

    while (pages < maxPages) {
      const page = await this.request("GET", path, {
        query: { ...query, cursor, limit: query?.limit ?? 100 },
      });
      pages++;

      const rows: T[] = Array.isArray(page?.data) ? page.data : [];
      collected.push(...rows);

      const next: string | null | undefined = page?.meta?.cursor?.next;
      if (collected.length >= maxItems) {
        return {
          data: collected.slice(0, maxItems),
          truncated: true,
          next_cursor: next ?? undefined,
          pages_fetched: pages,
        };
      }
      if (!next || rows.length === 0) {
        return { data: collected, pages_fetched: pages };
      }
      cursor = next;
    }

    return { data: collected, truncated: true, next_cursor: cursor, pages_fetched: pages };
  }
}

async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || "no response body";
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail ?? parsed?.message ?? parsed?.error ?? text;
    // 7shifts gates several reports behind higher plans; say so plainly.
    if (res.status === 403 || res.status === 402) {
      return `${detail} (this endpoint may require a higher 7shifts plan, e.g. "The Works")`;
    }
    return String(detail);
  } catch {
    return text.slice(0, 400);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
