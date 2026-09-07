export const runtime = 'nodejs';
export const maxDuration = 15;

// Phrases checked on every link regardless of type, based on common wording
// across activation/redemption services. Type-specific phrases (set when you
// add a type) are added on top of these.
//
// Known limitation: this reads the page's initial HTML only. Pages that
// build their "already used" message with JavaScript after loading (this
// includes some of Google's activation pages) won't show that text here —
// a clean result on those means "couldn't tell," not "confirmed working."
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

    let text = '';
    try {
      const raw = await res.text();
      text = raw.slice(0, 300000).toLowerCase();
    } catch {
      // body couldn't be read — still report the status code below
    }

    const matched = phrases.find((p) => text.includes(p));

    return Response.json({
      ok: true,
      status: res.status,
      looksUsed: Boolean(matched),
    });
  } catch (err) {
    clearTimeout(timeout);
    const timedOut = err.name === 'AbortError';
    return Response.json({
      ok: false,
      error: timedOut ? 'Timed out reaching the link' : 'Could not reach the link',
    });
  }
}
