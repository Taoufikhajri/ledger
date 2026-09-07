import { NextResponse } from 'next/server';

// Simple shared-password gate. Set APP_PASSWORD in your Vercel project's
// environment variables to turn this on. Username can be anything.
export function middleware(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return NextResponse.next(); // no password configured — gate disabled

  const auth = req.headers.get('authorization');
  if (auth && auth.startsWith('Basic ')) {
    const decoded = atob(auth.slice(6));
    const separatorIndex = decoded.indexOf(':');
    const suppliedPass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';
    if (suppliedPass === pass) return NextResponse.next();
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Ledger"' },
  });
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
