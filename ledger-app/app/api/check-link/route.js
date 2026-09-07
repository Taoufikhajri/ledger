export const runtime = 'nodejs';
export const maxDuration = 30;

// Phrases checked in the page text, based on common wording across
// activation/redemption services. Type-specific phrases (set when you add a
// type in the app) are added on top of these.
const GENERIC_USED_PHRASES = [
  'already in use',
  'already been used',
  'already redeemed',
  'already claimed',
  'already activated',
  'already been redeemed',
  'already been claimed',
  'already been activated',
  'already applied',
  'has already been applied',
  'no longer valid',
  'link has expired',
  'this link has expired',
  'this offer has expired',
  'this offer has already been redeemed',
  'this promotion has already been redeemed',
  'code has already been used',
  'code has already been redeemed',
  'redemption code has already been used',
  'this code has already been redeemed',
  'invalid code',
  'invalid or expired',
  'invalid or has expired',
  'this link is not valid',
  'not eligible',
  'ineligible',
];

// Uses Cloudflare's Browser Rendering API (a real browser running on
// Cloudflare's servers) to load the page and run its JavaScript, then
// returns the fully rendered HTML. This is what lets the checker see
// messages that only appear after a page finishes loading — something a
// plain fetch can never see. Returns null if the two Cloudflare env vars
// below aren't set, so the app still works without them (just falls back
// to the plain-fetch method further down).
async function fetchRenderedHtml(url) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          url,
          gotoOptions: { waitUntil: 'networkidle0', timeout: 20000 },
        }),
      }
    );
    clearTimeout(timeout);
    const data = await res.json();
    if (!data || data.success !== true || typeof data.result !== 'string') {
      const message = data?.errors?.[0]?.message || 'Browser rendering request failed';
      throw new Error(message);
    }
    return data.result;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Fallback: a plain server-side fetch with no JavaScript execution. Used
// when Cloudflare rendering isn't configured, or if it errors on a
// particular request.
async function fetchPlainHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    const raw = await res.text();
    return { html: raw, status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 });
  }

  const { url, extraPhrases } = body || {};
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return Response.json({ ok: false, error: 'Missing or invalid URL' }, { status: 400 });
  }

  const phrases = [...GENERIC_USED_PHRASES, ...(Array.isArray(extraPhrases) ? extraPhrases : [])]
    .map((p) => String(p).toLowerCase().trim())
    .filter(Boolean);

  let html = null;
  let status = null;
  let renderer = 'plain';

  try {
    html = await fetchRenderedHtml(url);
    if (html !== null) renderer = 'rendered';
  } catch (err) {
    html = null; // fall through to plain fetch below
  }

  if (html === null) {
    try {
      const plain = await fetchPlainHtml(url);
      html = plain.html;
      status = plain.status;
      renderer = 'plain';
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      return Response.json({
        ok: false,
        error: timedOut ? 'Timed out reaching the link' : 'Could not reach the link',
      });
    }
  }

  const text = html.slice(0, 300000).toLowerCase();
  const matched = phrases.find((p) => text.includes(p));

  return Response.json({
    ok: true,
    status,
    renderer,
    looksUsed: Boolean(matched),
  });
}
