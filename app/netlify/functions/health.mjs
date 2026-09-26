// GET /api/health: liveness, which keys the backend can see (names only, never values), and TOKEN_MINT.
export default async () => Response.json({
  ok: true,
  project: 'payblame',
  time: new Date().toISOString(),
  keys: { helius: !!process.env.HELIUS_API_KEY, birdeye: !!process.env.BIRDEYE_API_KEY, github: !!process.env.GITHUB_TOKEN },
  tokenMint: process.env.TOKEN_MINT || null,
});

export const config = { path: '/api/health' };
