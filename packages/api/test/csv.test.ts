import { describe, expect, it } from 'vitest';
import { parseSessionCsv } from '../src/services/csv.js';

describe('parseSessionCsv', () => {
  it('accepts a minimal valid CSV', () => {
    const text = 'url_a,url_b\nhttps://a.example.com,https://b.example.com\n';
    const r = parseSessionCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.url_a).toBe('https://a.example.com');
      expect(r.rows[0]?.url_b).toBe('https://b.example.com');
      expect(r.rows[0]?.label).toBeUndefined();
    }
  });

  it('preserves extra columns in raw_row', () => {
    const text = 'url_a,url_b,label,extra\nhttps://a.com,https://b.com,Home,foo\n';
    const r = parseSessionCsv(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows[0]?.label).toBe('Home');
      expect(r.rows[0]?.raw_row).toMatchObject({ extra: 'foo' });
    }
  });

  it('rejects missing required columns', () => {
    const text = 'url_a,foo\nhttps://a.com,bar\n';
    const r = parseSessionCsv(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('url_b');
  });

  it('rejects upload when any row is invalid', () => {
    const text = 'url_a,url_b\nhttps://a.com,not-a-url\nhttps://a2.com,https://b2.com\n';
    const r = parseSessionCsv(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.row_errors).toBeDefined();
      expect(r.row_errors!.find((e) => e.row_index === 0)?.errors[0]).toMatch(/http\(s\)/);
    }
  });

  it('rejects empty CSV', () => {
    const r = parseSessionCsv('url_a,url_b\n');
    expect(r.ok).toBe(false);
  });

  it('rejects non-http(s) URLs', () => {
    const text = 'url_a,url_b\nftp://a.com,https://b.com\n';
    const r = parseSessionCsv(text);
    expect(r.ok).toBe(false);
  });
});
