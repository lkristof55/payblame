/** Every error the library throws on purpose. `code` and `status` map straight onto an HTTP API. */
export class PayblameError extends Error {
  /**
   * @param {'BAD_INPUT'|'GITHUB_NOT_FOUND'|'NOT_PUMP'|'GITHUB_RATE_LIMIT'|'UPSTREAM'} code
   * @param {string} message
   * @param {{ retryAfterSeconds?: number, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'PayblameError';
    this.code = code;
    this.status = { BAD_INPUT: 400, GITHUB_NOT_FOUND: 404, NOT_PUMP: 404, GITHUB_RATE_LIMIT: 429, UPSTREAM: 502 }[code] || 500;
    if (extra.retryAfterSeconds != null) this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}
