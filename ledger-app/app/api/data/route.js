import { Redis } from '@upstash/redis';

const KEY = 'ledger-data';
const EMPTY = { suppliers: [], batches: [] };

// Works with either naming convention Vercel's Redis/Upstash marketplace
// integration might inject, depending on how you connect it.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function getClient() {
  if (!url || !token) {
    throw new Error(
      'No Redis database connected yet. Add one from the Vercel Storage/Marketplace tab — see README.'
    );
  }
  return new Redis({ url, token });
}

export async function GET() {
  try {
    const redis = getClient();
    const data = await redis.get(KEY);
    return Response.json(data || EMPTY);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const redis = getClient();
    const body = await request.json();
    await redis.set(KEY, body);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
