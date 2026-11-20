// Fetch helper for intel providers: timeouts, a small TTL cache, and per-host pacing so we stay
// inside each public API's limits (GDELT asks for at most one request every 5 seconds).
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
const lastHit = new Map<string, number>();
const queue = new Map<string, Promise<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const coolUntil = new Map<string, number>(); // host → time it may be asked again after a 429

const MIN_GAP: Record<string, number> = {
  "api.gdeltproject.org": 5500,
};
/** Slow public APIs get longer to answer. */
const TIMEOUT: Record<string, number> = {
  "api.gdeltproject.org": 25000, // often takes 15-20 seconds
  "api.worldbank.org": 20000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * GET JSON with caching. `ttlMs` = how long a good answer is reused. Requests to a paced host run
 * one at a time with the required gap between them.
 */
export async function getJson<T = any>(url: string, { ttlMs = 10 * 60_000, timeoutMs }: { ttlMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
  // the same request already on its way: share it
  if (inflight.has(url)) return inflight.get(url) as Promise<T>;
  const p = fetchJson<T>(url, ttlMs, timeoutMs);
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

async function fetchJson<T>(url: string, ttlMs: number, timeoutOverride?: number): Promise<T> {
  const host = new URL(url).host;
  if ((coolUntil.get(host) ?? 0) > Date.now()) throw new HttpError(`${host} is rate-limiting us; skipping for now`, 429);
  const timeoutMs = timeoutOverride ?? TIMEOUT[host] ?? 9000;
  const run = async () => {
    const gap = MIN_GAP[host] ?? 0;
    if (gap) {
      const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastHit.set(host, Date.now());
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "StakeClash/0.1 (game server)" }, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429) coolUntil.set(host, Date.now() + 60_000);
      if (!res.ok) throw new HttpError(`${host} ${res.status}`, res.status);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new HttpError(`${host} sent something that isn't JSON`, 502);
      }
      cache.set(url, { at: Date.now(), ttl: ttlMs, value });
      if (cache.size > 800) cache.delete(cache.keys().next().value!);
      return value as T;
    } finally {
      clearTimeout(timer);
    }
  };
  if (!MIN_GAP[host]) return run();
  // chain requests to paced hosts so they never overlap
  const prev = queue.get(host) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  queue.set(host, next);
  return next as Promise<T>;
}

/** POST JSON-RPC (used for the Solana RPC endpoint). */
export async function rpcCall<T = any>(url: string, method: string, params: unknown[] = [], { ttlMs = 30_000, timeoutMs = 9000 } = {}): Promise<T> {
  const key = `rpc:${url}:${method}:${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const j: any = await res.json();
    if (j.error) throw new HttpError(`rpc ${method}: ${j.error.message}`, 502);
    cache.set(key, { at: Date.now(), ttl: ttlMs, value: j.result });
    return j.result as T;
  } finally {
    clearTimeout(timer);
  }
}
