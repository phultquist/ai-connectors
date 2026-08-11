/**
 * Multi-tenant credential store.
 *
 * A customer never sees or sends their 7shifts token to Claude. Instead we
 * provision them a connector key (`ck_live_...`) that Claude sends as a bearer
 * token; the Worker exchanges it for that tenant's 7shifts token server-side.
 *
 * Only a SHA-256 hash of the connector key is persisted, so a dump of the KV
 * namespace does not yield working credentials.
 */

export interface TenantRecord {
  tenant_id: string;
  name: string;
  sevenshifts_token: string;
  company_id?: number;
  allow_writes?: boolean;
  created_at: string;
  disabled?: boolean;
  last_used_at?: string;
}

/** Public view — never includes the 7shifts token. */
export type TenantSummary = Omit<TenantRecord, "sevenshifts_token"> & {
  sevenshifts_token: "[stored]";
};

/** The subset of the Cloudflare KV API we rely on. */
export interface KVLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

const KEY_PREFIX = "ck_live_";
const HASH_NS = "keyhash:";
const TENANT_NS = "tenant:";

export function generateConnectorKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return KEY_PREFIX + hex;
}

export function generateTenantId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "t_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, to keep admin-secret checks safe. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class TenantStore {
  constructor(private readonly kv: KVLike) {}

  async create(input: {
    name: string;
    sevenshifts_token: string;
    company_id?: number;
    allow_writes?: boolean;
  }): Promise<{ tenant: TenantSummary; connector_key: string }> {
    if (!input.name?.trim()) throw new Error("A tenant name is required.");
    if (!input.sevenshifts_token?.trim()) {
      throw new Error("A 7shifts access token is required.");
    }

    const connectorKey = generateConnectorKey();
    const record: TenantRecord = {
      tenant_id: generateTenantId(),
      name: input.name.trim(),
      sevenshifts_token: input.sevenshifts_token.trim(),
      company_id: input.company_id,
      allow_writes: input.allow_writes ?? false,
      created_at: new Date().toISOString(),
    };

    const keyHash = await hashKey(connectorKey);
    await this.kv.put(HASH_NS + keyHash, JSON.stringify(record));
    await this.kv.put(
      TENANT_NS + record.tenant_id,
      JSON.stringify({ key_hash: keyHash, name: record.name, created_at: record.created_at }),
    );

    return { tenant: redact(record), connector_key: connectorKey };
  }

  /** Resolves a presented connector key to its tenant, or null. */
  async lookup(connectorKey: string): Promise<TenantRecord | null> {
    if (!connectorKey.startsWith(KEY_PREFIX)) return null;
    const raw = await this.kv.get(HASH_NS + (await hashKey(connectorKey)));
    if (!raw) return null;
    const record = JSON.parse(raw) as TenantRecord;
    return record.disabled ? null : record;
  }

  async list(): Promise<TenantSummary[]> {
    const { keys } = await this.kv.list({ prefix: TENANT_NS });
    const out: TenantSummary[] = [];
    for (const { name } of keys) {
      const pointer = await this.kv.get(name);
      if (!pointer) continue;
      const { key_hash } = JSON.parse(pointer) as { key_hash: string };
      const raw = await this.kv.get(HASH_NS + key_hash);
      if (raw) out.push(redact(JSON.parse(raw) as TenantRecord));
    }
    return out;
  }

  async revoke(tenantId: string): Promise<boolean> {
    const pointer = await this.kv.get(TENANT_NS + tenantId);
    if (!pointer) return false;
    const { key_hash } = JSON.parse(pointer) as { key_hash: string };
    await this.kv.delete(HASH_NS + key_hash);
    await this.kv.delete(TENANT_NS + tenantId);
    return true;
  }

  /** Issues a fresh connector key and invalidates the old one. */
  async rotate(tenantId: string): Promise<{ connector_key: string } | null> {
    const pointer = await this.kv.get(TENANT_NS + tenantId);
    if (!pointer) return null;
    const meta = JSON.parse(pointer) as { key_hash: string };
    const raw = await this.kv.get(HASH_NS + meta.key_hash);
    if (!raw) return null;

    const record = JSON.parse(raw) as TenantRecord;
    const connectorKey = generateConnectorKey();
    const newHash = await hashKey(connectorKey);

    await this.kv.put(HASH_NS + newHash, JSON.stringify(record));
    await this.kv.delete(HASH_NS + meta.key_hash);
    await this.kv.put(
      TENANT_NS + tenantId,
      JSON.stringify({ ...meta, key_hash: newHash, rotated_at: new Date().toISOString() }),
    );
    return { connector_key: connectorKey };
  }
}

function redact(record: TenantRecord): TenantSummary {
  return { ...record, sevenshifts_token: "[stored]" };
}
