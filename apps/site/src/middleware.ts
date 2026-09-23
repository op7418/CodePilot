import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { i18n } from './lib/i18n';

const localeMiddleware = createI18nMiddleware(i18n);

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  // Fumadocs v15 rewrites `/` to `/en/`. Next removes that trailing slash
  // with a redirect to `/en`, which the locale middleware redirects to `/`.
  // Keep the canonical English root and rewrite directly to the slashless route.
  if (request.nextUrl.pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = `/${i18n.defaultLanguage}`;
    return NextResponse.rewrite(url);
  }
  return localeMiddleware(request, event);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
