import type { RequestHandler } from 'express';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF guard via the `Sec-Fetch-Site` Fetch Metadata header.
 *
 * Modern browsers (Chrome ≥76, Firefox ≥90, Safari ≥16.4) attach this header
 * to every fetch/XHR/navigation. The value tells the server where the request
 * originated: `same-origin`, `same-site`, `none` (typed-URL / bookmark), or
 * `cross-site`. A forged request from `attacker.example` will carry
 * `cross-site` — that's the case we reject.
 *
 * Non-browser clients (curl, supertest, server-to-server) don't set the
 * header; we allow those through. The browser CSRF threat is what this
 * mitigates; an attacker who can already control a non-browser client doesn't
 * need CSRF to begin with.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (!UNSAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    res.status(403).json({ error: 'csrf_blocked', message: 'cross-site request rejected' });
    return;
  }
  next();
};
