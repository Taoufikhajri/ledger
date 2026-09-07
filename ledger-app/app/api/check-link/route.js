import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';

export const runtime = 'nodejs';
export const maxDuration = 30;

// A prebuilt Chromium binary hosted on Sparticuz's GitHub releases — this is
// what lets a real browser run inside Vercel's serverless function instead
// of bundling a 50+ MB binary into the deployment itself. If this checker
// ever needs upgrading, bump the version number in this URL to match a newer
// release of https://github.com/Sparticuz/chromium (and the chromium-min /
// puppeteer-core versions in package.json to match).
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

// Phrases checked in the fully-rendered page text, based on common wording
// across activation/redemption services. Type-specific phrases (set when you
// add a type in the app) are added on top of these.
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

async function getBrowser() {
  const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
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

  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const status = response ? response.status() : null;

    // Give client-rendered content (React/Angular-style single-page apps)
    // a moment to finish rendering after the network goes quiet.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const text = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
    const matched = phrases.find((p) => text.includes(p));

    return Response.json({
      ok: true,
      status,
      looksUsed: Boolean(matched),
    });
  } catch (err) {
    const timedOut = /timeout/i.test(err?.message || '');
    return Response.json({
      ok: false,
      error: timedOut ? 'Timed out reaching the link' : 'Could not check the link (browser error)',
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
