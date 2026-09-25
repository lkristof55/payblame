// Type declarations for payblame (hand-written; the library is plain ESM JavaScript).

export type Lamports = number;

export interface Cache {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
}

export interface Rpc {
  call(method: string, params: unknown): Promise<any>;
  stats: { calls: number; credits: number };
  getMultipleAccounts(keys: string[], opts?: { dataSlice?: { offset: number; length: number }; encoding?: string }): Promise<(AccountInfo | null)[]>;
  getAccountInfo(key: string, cfg?: object): Promise<AccountInfo | null>;
  getProgramAccounts(program: string, cfg: object): Promise<{ pubkey: string; account: AccountInfo }[]>;
  getMinimumBalanceForRentExemption(size: number): Promise<number>;
  getAsset(id: string): Promise<any>;
  getAssetBatch(ids: string[]): Promise<any[]>;
}

export interface AccountInfo { lamports: number; owner: string; data: [string, 'base64'] | string; executable?: boolean; space?: number }

export interface Options {
  /** Any Solana mainnet RPC that allows getProgramAccounts with memcmp filters. */
  rpcUrl?: string;
  /** Use your own client (tests, custom transports). */
  rpc?: Rpc;
  /** Optional GitHub token: raises GitHub REST from 60 to 5000 requests/h. */
  githubToken?: string;
  /** Inject fetch to record or replay traffic. */
  fetch?: typeof fetch;
  /** GitHub id<->login cache (7-day entries). Defaults to an in-memory Map. */
  cache?: Cache;
  /** Per-request timeout, default 8000 ms. */
  timeoutMs?: number;
}

export type ParsedQuery =
  | { kind: 'github'; login: string }
  | { kind: 'ghid'; id: string }
  | { kind: 'x'; id: string }
  | { kind: 'address'; address: string }
  | { kind: 'invalid'; reason: string };

export interface Meta {
  fetchedAt: string;
  cached: boolean;
  timingMs: { resolve: number; probes: number; accounts: number; metadata: number; total: number };
  rpcCalls: number;
}

export interface Recipient {
  type: 'github' | 'x' | 'social' | 'wallet';
  address: string;
  platform: 'github' | 'x' | 'pump' | 'other' | null;
  userId: string | null;
  login: string | null;
  accountType: 'User' | 'Organization' | null;
  githubDeleted: boolean;
  /** Set by maskLookup: address = ADDRESS_MASK, userId = null, login = LOGIN_MASK (github) or null. */
  masked?: boolean;
}

export interface RecipientAccount {
  exists: boolean;
  lamports: Lamports;
  unclaimedLamports: Lamports | null;
  totalClaimedLamports: Lamports | null;
  lastClaimedAt: string | null;
  everClaimed: boolean | null;
  receivedLamports: Lamports | null;
}

export interface CoinLine {
  /** Ticker without a leading '$' (see ticker()). */
  mint: string; symbol: string | null; name: string | null; sharingConfig: string;
  slot: number; shareholderCount: number; bps: number; status: 'active' | 'paused'; version: number;
  admin: string; adminRevoked: boolean;
  pumpVaultLamports: Lamports; ammVaultLamports: Lamports; ammVaultExists: boolean;
  pendingLamports: Lamports; pendingForRecipientLamports: Lamports;
  coRecipients: { address: string; bps: number }[];
}

export interface RecipientBlame {
  kind: 'recipient';
  query: string;
  recipient: Recipient;
  account: RecipientAccount;
  coins: CoinLine[];
  totals: { coins: number; listed: number; truncated: boolean; mutable: number; pendingForRecipientLamports: Lamports };
  /** Hits per shareholder slot 0..9 (one memcmp probe each). */
  probeHits: number[];
  blame: string[];
  meta: Meta;
  /** Present when the result went through maskLookup. */
  masked?: true; logins?: 'masked'; loginsNote?: string;
}

export interface Shareholder {
  address: string; bps: number; kind: 'github' | 'x' | 'social' | 'wallet'; platform: number | null;
  userId: string | null; login: string | null; accountType: 'User' | 'Organization' | null; githubDeleted: boolean;
  unclaimedLamports: Lamports | null; totalClaimedLamports: Lamports | null; lastClaimedAt: string | null;
  everClaimed: boolean | null; pendingForShareholderLamports: Lamports;
  /** Set by maskLookup on social shareholders. */
  masked?: boolean;
}

export interface Declared { platform: 'x' | 'github'; handle: string; source: 'name' | 'symbol' | 'description'; status?: 'match' | 'absent' | 'unverifiable' }

export interface CoinBlame {
  kind: 'coin';
  query: string;
  /** symbol: ticker without a leading '$' (see ticker()). */
  mint: string; name: string | null; symbol: string | null; description: string | null;
  marketCapUsd: number | null; dexId: string | null; pairUrl: string | null;
  curve: { address: string; exists: boolean; complete: boolean | null; creator: string | null };
  feeSharing: boolean;
  sharingConfig: string;
  config: null | { version: number; status: 'active' | 'paused'; admin: string; adminRevoked: boolean; shareholders: Shareholder[] };
  vaults: { pumpVault: string; pumpVaultLamports: Lamports; ammVaultAta: string; ammVaultLamports: Lamports; pendingLamports: Lamports };
  declared: Declared[];
  mismatch: boolean;
  diff: string[];
  blame: string[];
  meta: Meta;
  /** Present when the result went through maskLookup. */
  masked?: true; logins?: 'masked'; loginsNote?: string;
}

/**
 * A ledger row. Masked rows (the default of buildLedger and of the CLI) carry login = LOGIN_MASK
 * ('####', the one MASK), githubId = null, socialFeePda = null, masked = true and a rowId
 * ('row:' + 8 hex of HMAC-SHA256(secret, socialFeePda)). The numbers and accountType stay.
 */
export interface LedgerRow {
  githubId: string | null; login: string | null; accountType: 'User' | 'Organization' | null; githubDeleted: boolean;
  socialFeePda: string | null; unclaimedLamports: Lamports; totalClaimedLamports: Lamports; lastClaimedAt: string | null;
  masked?: true; rowId?: string;
}

export interface Ledger {
  snapshotAt: string;
  source: string;
  rentExemptLamports: Lamports;
  accounts: { total: number; github: number; x: number; pump: number; other: number };
  github: { accounts: number; everClaimed: number; neverClaimed: number; neverClaimedOver1Sol: number; unclaimedLamports: Lamports; unclaimedNeverClaimedLamports: Lamports; totalClaimedLamports: Lamports };
  x: { accounts: number; unclaimedLamports: Lamports; totalClaimedLamports: Lamports };
  topUnclaimed: LedgerRow[];
  topClaimed: LedgerRow[];
  recentClaims: LedgerRow[];
  blame: string[];
  /** 'masked' unless buildLedger got { reveal: true } ('revealed'); absent on a bare aggregateLedger result (no logins yet). */
  logins?: 'masked' | 'revealed';
  loginsNote?: string;
}

export interface SharingConfig {
  bump: number; version: number; versionRecognized: boolean; statusCode: number; status: 'active' | 'paused';
  mint: string; admin: string; adminRevoked: boolean; shareholders: { address: string; bps: number }[]; bpsTotal: number;
}
/** userId is usually a numeric account id as text; some mainnet accounts hold free text (a handle, a name, a URL). */
export interface SocialFeePda { bump: number; version: number; userId: string; platform: number; totalClaimed: number; lastClaimed: number; totalStableClaimed: number | null }

export class PayblameError extends Error {
  code: 'BAD_INPUT' | 'GITHUB_NOT_FOUND' | 'NOT_PUMP' | 'GITHUB_RATE_LIMIT' | 'UPSTREAM';
  status: number;
  retryAfterSeconds?: number;
}
export class DecodeError extends Error {}

export function parseQuery(q: string): ParsedQuery;
export function lookup(q: string, opts?: Options & { limit?: number }): Promise<RecipientBlame | CoinBlame>;
export function blameRecipient(input: string | Exclude<ParsedQuery, { kind: 'invalid' }> & { account?: AccountInfo | null }, opts?: Options & { limit?: number }): Promise<RecipientBlame>;
export function blameCoin(mint: string, opts?: Options): Promise<CoinBlame>;
export function buildLedger(opts?: Options & { maxLookups?: number; reveal?: boolean; maskSecret?: string | Uint8Array }): Promise<Ledger>;
export function applyLogins(ledger: Ledger, logins: Map<string, { login?: string | null; type?: 'User' | 'Organization' | null; deleted?: boolean }>): Ledger;
export function maskLedger(ledger: Ledger, opts?: { secret?: string | Uint8Array }): Ledger;
export function ledgerRowId(socialFeePda: string, secret?: string | Uint8Array): string;
/** The one mask payblame prints for anything that identifies an account: '####' (4 '#', whatever the real length). */
export const MASK: '####';
/** Same as MASK. */
export const LOGIN_MASK: '####';
/**
 * Mask a lookup result for output nobody asked for: GitHub logins -> LOGIN_MASK, declared handles ->
 * HANDLE_MASK, social user ids -> null, SocialFeePda addresses -> ADDRESS_MASK (in the structure, the
 * name/symbol/description text, the diff and the blame lines). Numbers, mints and bps stay. Idempotent.
 */
export function maskLookup<T extends RecipientBlame | CoinBlame>(result: T): T;
/** Same as MASK. */
export const HANDLE_MASK: '####';
/** Same as MASK. */
export const ADDRESS_MASK: '####';
/** Strip leading '$' sigils from a symbol ("$RapCat" -> "RapCat"); null for null/empty. */
export function ticker(symbol: string | null | undefined): string | null;
export function aggregateLedger(accounts: { pubkey: string; lamports: number; data: Uint8Array }[], opts: { rentExemptLamports: number; snapshotAt?: string }): Ledger;
export function probeSharingConfigs(rpc: Rpc, recipient: string): Promise<{ slotOf: Map<string, number>; hitsPerSlot: number[] }>;

export function decodeSharingConfig(bytes: Uint8Array): SharingConfig;
export function decodeSocialFeePda(bytes: Uint8Array): SocialFeePda;
export function decodeBondingCurve(bytes: Uint8Array): { complete: boolean; creator: string } | null;
export function accountData(data: [string, string] | string): Uint8Array;

export function socialFeePda(userId: string | number, platform?: number): string;
export function sharingConfigPda(mint: string): string;
export function bondingCurvePda(mint: string): string;
export function creatorVaultPdas(creator: string): { pumpVault: string; ammVaultAuthority: string; ammVaultAta: string };
export function findProgramAddress(seeds: (Uint8Array | string)[], programId: string): [string, number];
export function isOnCurve(bytes: Uint8Array): boolean;

export function formatBlame(b: RecipientBlame): string[];
export function formatCoin(c: CoinBlame, opts?: { rent0?: number }): string[];
export function formatLedger(l: Ledger): string[];
export function extractDeclared(meta: { name?: string | null; symbol?: string | null; description?: string | null }): Declared[];
export function diffDeclared(declared: Declared[], shareholders: { address: string; bps: number; kind: string; login?: string | null; userId?: string | null }[]): { declared: Declared[]; mismatch: boolean; diff: string[] };

export function resolveLogin(login: string, opts?: Options): Promise<{ id: string; login: string; type: 'User' | 'Organization' | null } | null>;
export function resolveId(id: string, opts?: Options): Promise<{ id: string; login: string | null; type: 'User' | 'Organization' | null; deleted: boolean } | null>;
/** Many ids at once (cache first, then at most opts.max network lookups). Text (non-numeric) ids map to null without a request. */
export function resolveIds(ids: string[], opts?: Options & { max?: number; concurrency?: number }): Promise<Map<string, { id: string; login: string | null; type: 'User' | 'Organization' | null; deleted: boolean } | null>>;
/** True for a numeric on-chain user_id (1-20 digits). Some SocialFeePdas hold text instead: a handle, a name or a URL. */
export function isNumericId(id: string | number): boolean;
export function memoryCache(): Cache;
export function createRpc(opts: { rpcUrl: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number }): Rpc;
export function encodeBase58(bytes: Uint8Array): string;
export function decodeBase58(s: string): Uint8Array;
export function isAddress(s: string): boolean;
