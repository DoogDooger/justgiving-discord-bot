import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppContext } from '../context.js';
import { createWebApi, type WebApi } from './api.js';

/** Astro's Node adapter in middleware mode (built into web-dist/ by `npm run build:web`). */
export type AstroHandler = (req: Request, res: Response, next: NextFunction, locals: { web: WebApi }) => void | Promise<void>;

/** How long one rendered copy of the home page is reused. */
const HOME_PAGE_TTL_MS = 20_000;

/** Where `astro build` puts its output, relative to both src/web/ and dist/web/. */
const ASTRO_SERVER_ENTRY = new URL('../../web-dist/server/entry.mjs', import.meta.url);
const ASTRO_CLIENT_DIR = fileURLToPath(new URL('../../web-dist/client/', import.meta.url));

export async function loadAstroHandler(): Promise<AstroHandler> {
  const entry = (await import(ASTRO_SERVER_ENTRY.href)) as { handler: AstroHandler };
  return entry.handler;
}

export function createWebServer(getContext: () => AppContext, astro: AstroHandler) {
  const app = express();
  const web = createWebApi(getContext);
  app.disable('x-powered-by');
  // Fly.io's proxy sits in front of the app; trust one hop so rate limiting sees the real client IP.
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      // The return URL carries the user's token and donation ID; never leak it to other sites.
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });

  // Send visitors on any other public address (e.g. the old my-donor-bot.fly.dev) to the
  // official one, keeping the path and query so older /donate return links still work.
  app.use((req, res, next) => {
    const official = new URL(getContext().config.publicBaseUrl);
    if (official.protocol === 'https:' && req.hostname.endsWith('.fly.dev') && req.hostname !== official.hostname) {
      res.redirect(301, new URL(req.originalUrl, official).href);
      return;
    }
    next();
  });

  // Astro's built CSS and images. Hashed file names under /_astro can be cached for a long time.
  app.use(
    express.static(ASTRO_CLIENT_DIR, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader('Cache-Control', path.includes('_astro') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    }),
  );

  app.use(
    '/justgiving/return',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).type('text/plain').send('Too many attempts. Please wait a few minutes and try again, or use /claim in Discord.');
      },
    }),
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
  );

  // The home page is the same for everyone and refreshes itself each minute, so render it
  // once and reuse the HTML for a few seconds. Without this, a burst of visitors makes Astro
  // render (and hold in memory) one copy per request.
  let home: { at: number; revision: number; body: Buffer; type: string } | null = null;
  let rendering: Promise<void> | null = null;
  app.get('/', async (req, res, next) => {
    const sendCached = () => {
      res.set({ 'Content-Type': home!.type, 'Cache-Control': 'public, max-age=30' }).send(home!.body);
    };
    const revision = () => getContext().donations.store.getPrivacyRevision();
    if (home && home.revision === revision() && Date.now() - home.at < HOME_PAGE_TTL_MS) return sendCached();
    // Only one render at a time; everyone else waits for it and gets the same copy.
    if (rendering) {
      await rendering.catch(() => undefined);
      if (home && home.revision === revision()) return sendCached();
    }
    const renderRevision = revision();
    const chunks: Buffer[] = [];
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    let finish!: () => void;
    rendering = new Promise<void>((resolve) => (finish = resolve));
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      return (write as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...args: unknown[]) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      if (res.statusCode === 200 && renderRevision === revision()) {
        home = { at: Date.now(), revision: renderRevision, body: Buffer.concat(chunks), type: String(res.getHeader('content-type') ?? 'text/html; charset=utf-8') };
      }
      rendering = null;
      finish();
      return (end as (...a: unknown[]) => Response)(chunk, ...args);
    }) as typeof res.end;
    res.once('close', () => {
      rendering = null;
      finish();
    });
    try {
      await astro(req, res, next, { web });
    } catch (error) {
      rendering = null;
      finish();
      next(error);
    }
  });

  // Pages (web/pages/*.astro). Anything Astro doesn't have a page for falls through.
  app.use((req, res, next) => astro(req, res, next, { web }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Web request failed:', error);
    if (!res.headersSent) res.status(500).type('text/plain').send('Something went wrong. Please try again, or use /claim in Discord.');
  });

  return app;
}
