import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRateLimit } from '../src/middleware/rate-limit.js';

function makeApp(t: { now: number }) {
  const app = express();
  app.use(
    createRateLimit({
      refillPerSecond: 1,
      burst: 3,
      now: () => t.now,
    }),
  );
  app.get('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rate-limit middleware', () => {
  it('allows up to burst requests before throttling', async () => {
    const t = { now: 0 };
    const app = makeApp(t);
    const r1 = await request(app).get('/x');
    const r2 = await request(app).get('/x');
    const r3 = await request(app).get('/x');
    const r4 = await request(app).get('/x');
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    expect(r4.status).toBe(429);
    expect(r4.headers['retry-after']).toBeDefined();
    expect(r4.body.error).toBe('rate_limited');
  });

  it('refills tokens over time', async () => {
    const t = { now: 0 };
    const app = makeApp(t);
    await request(app).get('/x');
    await request(app).get('/x');
    await request(app).get('/x');
    expect((await request(app).get('/x')).status).toBe(429);

    t.now += 1000; // +1 token
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
  });

  it('caps refill at the burst size', async () => {
    const t = { now: 0 };
    const app = makeApp(t);
    await request(app).get('/x');
    await request(app).get('/x');
    await request(app).get('/x');
    expect((await request(app).get('/x')).status).toBe(429);

    t.now += 60_000; // refill well above burst
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/x')).status).toBe(200);
    }
    expect((await request(app).get('/x')).status).toBe(429);
  });
});
