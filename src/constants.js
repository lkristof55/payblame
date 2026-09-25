// Program ids and account discriminators. Source: @pump-fun/pump-sdk@2.0.0 (src/idl/pump_fees.json,
// pump.json, pump_amm.json, src/pda.ts), checked against mainnet accounts on 2026-09-25.
export const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Anchor account discriminators: sha256("account:<Name>")[0..8]. */
export const DISC = {
  SharingConfig: Uint8Array.from([216, 74, 9, 0, 56, 140, 93, 75]),
  SocialFeePda: Uint8Array.from([139, 96, 53, 17, 42, 169, 206, 150]),
  BondingCurve: Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]),
};
/** The same discriminators in base58, as getProgramAccounts memcmp filters want them. */
export const DISC_B58 = { SharingConfig: 'dBH23jPD3C6', SocialFeePda: 'QK7xVTRGCGD' };

/** SharingConfig byte layout (pump_fees). The account is 1024 bytes; bytes after 80+34n are zero. */
export const SHARING = {
  size: 1024,
  bump: 8, version: 9, status: 10, mint: 11, admin: 43, adminRevoked: 75, vecLen: 76,
  shareholders: 80, stride: 34, maxShareholders: 10,
  /** bytes needed to decode a full config: 80 + 34 * 10 */
  sliceLength: 420,
};
/** Offset of shareholder slot i: the memcmp position of the reverse-index probe. */
export const slotOffset = (i) => SHARING.shareholders + SHARING.stride * i;

/** SocialFeePda (pump_fees): 179 bytes, variable offsets after the user_id string. */
export const SOCIAL = { size: 179, userId: 10, maxUserIdLen: 20, sliceLength: 59 };

/** SocialFeePda.platform values seen on mainnet. 0 Pump, 1 X, 2 GitHub; 3, 4 and 6 exist but are unnamed in the IDL. */
export const PLATFORM = { PUMP: 0, X: 1, GITHUB: 2 };
export const platformName = (p) => (p === 2 ? 'github' : p === 1 ? 'x' : p === 0 ? 'pump' : 'other');

/** BondingCurve (pump): complete bool @48, creator pubkey @49. */
export const CURVE = { complete: 48, creator: 49, minLength: 81 };
