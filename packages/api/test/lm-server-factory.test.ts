import { describe, expect, it } from 'vitest';
import { createLmServerControllerFromEnv } from '../src/services/lm-server-factory.js';

describe('createLmServerControllerFromEnv', () => {
  it('defaults to the local backend', () => {
    const r = createLmServerControllerFromEnv({});
    expect(r.backend).toBe('local');
  });

  it('returns a disabled cli for LM_BACKEND=none whose calls fail with the configured message', async () => {
    const r = createLmServerControllerFromEnv({ LM_BACKEND: 'none' });
    expect(r.backend).toBe('none');
    const start = await r.cli.serverStart();
    expect(start.ok).toBe(false);
    expect(start.errorMessage).toMatch(/LM_BACKEND=none/);
  });

  it('throws on an unknown backend name (caught early at boot, not at first LM call)', () => {
    expect(() => createLmServerControllerFromEnv({ LM_BACKEND: 'magic' })).toThrow(
      /Unknown LM_BACKEND/,
    );
  });

  it('throws for scaleway when required env is missing', () => {
    expect(() => createLmServerControllerFromEnv({ LM_BACKEND: 'scaleway' })).toThrow(
      /SCW_GPU_ZONE/,
    );
  });

  it('builds a scaleway-backed cli when all required env is present', () => {
    const r = createLmServerControllerFromEnv({
      LM_BACKEND: 'scaleway',
      SCW_GPU_ZONE: 'fr-par-2',
      SCW_GPU_INSTANCE_ID: '00000000-0000-0000-0000-000000000000',
      SCW_SECRET_KEY: 'k',
      LM_STUDIO_BASE_URL: 'http://lm:1234/v1',
      LM_STUDIO_MODEL: 'm',
    });
    expect(r.backend).toBe('scaleway');
    expect(r.description).toMatch(/scaleway zone=fr-par-2/);
  });
});
