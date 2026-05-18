import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { csrfGuard } from '../src/middleware/csrf.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', csrfGuard);
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  app.post('/api/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('csrfGuard', () => {
  it('allows GET regardless of Sec-Fetch-Site', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/x').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(200);
  });

  it('allows POST with no Sec-Fetch-Site (supertest / curl / server-to-server)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/x');
    expect(res.status).toBe(200);
  });

  it('allows POST with Sec-Fetch-Site: same-origin', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/x').set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(200);
  });

  it('allows POST with Sec-Fetch-Site: none (direct nav / bookmark)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/x').set('Sec-Fetch-Site', 'none');
    expect(res.status).toBe(200);
  });

  it('rejects POST with Sec-Fetch-Site: cross-site', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/x').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_blocked');
  });
});
