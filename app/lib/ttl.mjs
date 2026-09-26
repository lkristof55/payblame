// Module-level TTL cache with in-flight de-duplication (two identical requests share one upstream run).
export class TtlCache {
  constructor({ max = 500, now = () => Date.now() } = {}) { this.map = new Map(); this.inflight = new Map(); this.max = max; this.now = now; }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key, value, ttlSeconds) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: this.now() + ttlSeconds * 1000 });
  }
  /** Run fn once per key at a time. */
  async once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => fn())().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
