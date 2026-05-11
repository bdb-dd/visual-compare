import { describe, expect, it } from 'vitest';
import { summariseResults } from '../src/services/evaluator.js';
import type {
  AcceptanceStatus,
  CaptureStatusInfo,
  MatchedAtLevel,
  MatchedDecidedBy,
  PairOutcome,
  SessionResultRow,
} from '../src/types.js';

const completeCapture: CaptureStatusInfo = { status: 'complete', error_message: null };

function row(opts: {
  matched_at_level?: MatchedAtLevel | null;
  matched_decided_by?: MatchedDecidedBy | null;
  acceptance_status?: AcceptanceStatus;
  status?: 'pending' | 'cached';
  pair_outcome?: PairOutcome;
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
    pair_outcome: opts.pair_outcome ?? 'both_present',
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
      missing: 0,
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
    expect(s.by_pair_outcome).toEqual({
      both_present: 0,
      a_missing: 0,
      b_missing: 0,
      both_missing: 0,
    });
  });

  it('buckets rows by pair_outcome', () => {
    const rows = [
      row({ matched_at_level: 'tolerant', matched_decided_by: 'pixel' }),
      row({ matched_at_level: 'tolerant', matched_decided_by: 'pixel' }),
      row({ pair_outcome: 'b_missing' }),
      row({ pair_outcome: 'b_missing' }),
      row({ pair_outcome: 'a_missing' }),
      row({ pair_outcome: 'both_missing' }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.total).toBe(6);
    expect(s.by_pair_outcome).toEqual({
      both_present: 2,
      a_missing: 1,
      b_missing: 2,
      both_missing: 1,
    });
  });

  it('counts missing-page rows in by_level.missing, not by_level.pending', () => {
    // Two rows actually pending a verdict, four rows already classified as
    // missing-page. The histogram cell for `pending` should reflect just the
    // first two — otherwise reviewers see "lots of work left" when in fact
    // those rows are settled (no diff was attempted by design).
    const rows = [
      row({ matched_at_level: null, status: 'pending' }),
      row({ matched_at_level: null, status: 'pending' }),
      row({ matched_at_level: null, status: 'cached', pair_outcome: 'a_missing' }),
      row({ matched_at_level: null, status: 'cached', pair_outcome: 'a_missing' }),
      row({ matched_at_level: null, status: 'cached', pair_outcome: 'b_missing' }),
      row({ matched_at_level: null, status: 'cached', pair_outcome: 'both_missing' }),
    ];
    const s = summariseResults(rows, 'tolerant');
    expect(s.by_level.pending).toBe(2);
    expect(s.by_level.missing).toBe(4);
    // Buckets must still sum to total — adding `missing` shouldn't double-count.
    const sum = Object.values(s.by_level).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.total);
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
