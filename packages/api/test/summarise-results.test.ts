import { describe, expect, it } from 'vitest';
import { summariseResults } from '../src/services/evaluator.js';
import type {
  AcceptanceStatus,
  CaptureStatusInfo,
  MatchedAtLevel,
  MatchedDecidedBy,
  SessionResultRow,
} from '../src/types.js';

const completeCapture: CaptureStatusInfo = { status: 'complete', error_message: null };

function row(opts: {
  matched_at_level?: MatchedAtLevel | null;
  matched_decided_by?: MatchedDecidedBy | null;
  acceptance_status?: AcceptanceStatus;
  status?: 'pending' | 'cached';
}): SessionResultRow {
  return {
    url_pair_id: 'p',
    url_a: 'a',
    url_b: 'b',
    label: null,
    viewport_name: 'desktop',
    matched_at_level: opts.matched_at_level ?? null,
    matched_decided_by: opts.matched_decided_by ?? null,
    capture_a_sha: null,
    capture_b_sha: null,
    comparison_id: null,
    capture_a_status: completeCapture,
    capture_b_status: completeCapture,
    pixel: null,
    lm: null,
    acceptance_status: opts.acceptance_status ?? 'unaccepted',
    status: opts.status ?? 'cached',
  };
}

describe('summariseResults', () => {
  it('zeroes everywhere for an empty result set', () => {
    const s = summariseResults([], 'tolerant');
    expect(s.total).toBe(0);
    expect(s.by_level).toEqual({
      'pixel-perfect': 0,
      strict: 0,
      tolerant: 0,
      loose: 0,
      none: 0,
      pending: 0,
    });
    expect(s.by_acceptance_status).toEqual({
      unaccepted: 0,
      accepted: 0,
      regressed: 0,
      expanded_diff: 0,
    });
    expect(s.by_decided_by).toEqual({ pixel: 0, lm: 0, none: 0 });
    expect(s.by_target_status).toEqual({
      reached_target: 0,
      weaker_than_target: 0,
      pending: 0,
    });
  });

  it('buckets pending rows correctly across all breakdowns', () => {
    const s = summariseResults(
      [row({ matched_at_level: null, status: 'pending' })],
      'tolerant',
    );
    expect(s.total).toBe(1);
    expect(s.by_level.pending).toBe(1);
    expect(s.by_target_status.pending).toBe(1);
    expect(s.by_decided_by.none).toBe(1);
  });

  it('reached_target counts levels at or stricter than target', () => {
    const rows = [
      row({ matched_at_level: 'pixel-perfect', matched_decided_by: 'pixel' }),
      row({ matched_at_level: 'strict', matched_decided_by: 'pixel' }),
      row({ matched_at_level: 'tolerant', matched_decided_by: 'lm' }),
      row({ matched_at_level: 'loose', matched_decided_by: 'pixel' }),
      row({ matched_at_level: 'none', matched_decided_by: 'pixel' }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.total).toBe(5);
    expect(s.by_level).toMatchObject({
      'pixel-perfect': 1,
      strict: 1,
      tolerant: 1,
      loose: 1,
      none: 1,
      pending: 0,
    });
    expect(s.by_target_status).toEqual({
      reached_target: 3, // pixel-perfect, strict, tolerant
      weaker_than_target: 2, // loose, none
      pending: 0,
    });
  });

  it('counts by_decided_by correctly across pixel/lm/none', () => {
    const rows = [
      row({ matched_at_level: 'tolerant', matched_decided_by: 'pixel' }),
      row({ matched_at_level: 'tolerant', matched_decided_by: 'lm' }),
      row({ matched_at_level: 'tolerant', matched_decided_by: 'lm' }),
      row({ matched_at_level: null }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.by_decided_by).toEqual({ pixel: 1, lm: 2, none: 1 });
  });

  it('counts each acceptance_status into its bucket', () => {
    const rows = [
      row({ matched_at_level: 'tolerant', acceptance_status: 'unaccepted' }),
      row({ matched_at_level: 'tolerant', acceptance_status: 'accepted' }),
      row({ matched_at_level: 'loose', acceptance_status: 'regressed' }),
      row({ matched_at_level: 'tolerant', acceptance_status: 'expanded_diff' }),
      row({ matched_at_level: 'tolerant', acceptance_status: 'accepted' }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.by_acceptance_status).toEqual({
      unaccepted: 1,
      accepted: 2,
      regressed: 1,
      expanded_diff: 1,
    });
  });

  it('respects different target levels in by_target_status', () => {
    const rows = [
      row({ matched_at_level: 'tolerant' }),
      row({ matched_at_level: 'strict' }),
      row({ matched_at_level: 'loose' }),
    ];
    // target=strict: only the strict row reaches; tolerant/loose are weaker.
    expect(summariseResults(rows, 'strict').by_target_status).toEqual({
      reached_target: 1,
      weaker_than_target: 2,
      pending: 0,
    });
    // target=loose: strict and tolerant are stricter, loose matches → all reach.
    expect(summariseResults(rows, 'loose').by_target_status).toEqual({
      reached_target: 3,
      weaker_than_target: 0,
      pending: 0,
    });
  });

  it('all bucket totals sum to .total', () => {
    const rows = [
      row({ matched_at_level: 'tolerant', matched_decided_by: 'pixel', acceptance_status: 'accepted' }),
      row({ matched_at_level: 'none', matched_decided_by: 'pixel', acceptance_status: 'regressed' }),
      row({ matched_at_level: null, status: 'pending' }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.total).toBe(3);
    const sumLevel = Object.values(s.by_level).reduce((a, b) => a + b, 0);
    const sumTarget = Object.values(s.by_target_status).reduce((a, b) => a + b, 0);
    const sumDecided = Object.values(s.by_decided_by).reduce((a, b) => a + b, 0);
    const sumAcc = Object.values(s.by_acceptance_status).reduce((a, b) => a + b, 0);
    expect(sumLevel).toBe(3);
    expect(sumTarget).toBe(3);
    expect(sumDecided).toBe(3);
    expect(sumAcc).toBe(3);
  });
});
