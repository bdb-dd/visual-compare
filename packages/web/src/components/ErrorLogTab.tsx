import { useEffect, useMemo, useState, type JSX } from 'react';
import { api, type SessionErrorEntry } from '../api/client.js';

/**
 * Config view's "Errors" surface. Surfaces every persisted capture /
 * comparison error for the session so an operator can track failures
 * without drilling into rows.
 *
 * Display strategy: entries are rolled up into "buckets" keyed by a
 * user-controlled combination of dimensions — Error (message), Kind,
 * Viewport, and Pair — chosen via the chip selector. Two extremes:
 *
 *   - All four on (granular): one row per distinct failure signature.
 *     Best when chasing a single flaky URL across runs.
 *   - All four off (incident view): one row total. Best as a sanity
 *     check on overall failure volume.
 *
 * When Error is on, buckets are presented under outer collapsible
 * headers by `error_message` (each header holds buckets that share
 * that message). When Error is off, the outer wrapper goes away and a
 * `message` column appears in the table; a single bucket may then
 * span multiple distinct messages, which the detail pane breaks down.
 *
 * Top-level Kind tabs (All / Capture / Comparison) carry occurrence
 * counts. Secondary filters (time period, viewport, URL substring)
 * narrow the working set before the rollup. Clicking a bucket opens
 * the right-hand pane with the full error message(s) plus a "Recent
 * occurrences" timeline.
 */

type Period = 'hour' | 'day' | 'week' | 'all';

interface Filters {
  period: Period;
  viewport: string;
  urlQuery: string;
}

interface GroupBy {
  /** When true, buckets are partitioned by error_message AND outer
   *  collapsible headers reappear per-message. When false, message is
   *  not part of the bucket key and the outer headers collapse away. */
  error: boolean;
  /** When true, capture vs. comparison (and capture A vs. B) split into separate buckets. */
  kind: boolean;
  /** When true, separate buckets per viewport. */
  viewport: boolean;
  /** When true, separate buckets per URL pair. */
  pair: boolean;
}

const PERIOD_MS: Record<Exclude<Period, 'all'>, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const PERIOD_LABEL: Record<Period, string> = {
  hour: 'Last hour',
  day: 'Last 24h',
  week: 'Last 7 days',
  all: 'All time',
};

const INITIAL_FILTERS: Filters = {
  period: 'all',
  viewport: '',
  urlQuery: '',
};

const INITIAL_GROUP_BY: GroupBy = {
  error: true,
  kind: true,
  viewport: true,
  pair: false,
};

/** Number of timestamps surfaced in the detail pane's occurrence list
 *  before we elide the tail with "+ N older". Large enough to read at
 *  a glance, small enough that a 10k-occurrence bucket doesn't blow up
 *  layout. */
const OCCURRENCES_PREVIEW = 20;

interface Bucket {
  key: string;
  /** Newest-first. */
  occurrences: SessionErrorEntry[];
  /** Distinct dimension values across the bucket's occurrences. Used
   *  both to derive single-value display when the dimension is in the
   *  key, and the summary count ("3 viewports", "12 pairs") when it
   *  isn't. */
  messages: Set<string>;
  kinds: Set<'capture' | 'comparison'>;
  sides: Set<'a' | 'b' | null>;
  viewports: Set<string>;
  pair_ids: Set<string>;
}

interface MessageGroup {
  message: string;
  buckets: Bucket[];
  total_count: number;
  captures: number;
  comparisons: number;
}

function bucketKeyFor(e: SessionErrorEntry, groupBy: GroupBy): string {
  const parts: string[] = [];
  if (groupBy.error) parts.push(e.error_message);
  if (groupBy.kind) parts.push(e.kind, e.side ?? '-');
  if (groupBy.viewport) parts.push(e.viewport_name);
  if (groupBy.pair) parts.push(e.url_pair_id);
  // Empty key (all dimensions off) is fine — every entry lands in one
  // bucket, which is the explicit "show me the total" view.
  return parts.join('|') || '*';
}

export function ErrorLogTab({ sessionId }: { sessionId: string }): JSX.Element {
  const [errors, setErrors] = useState<SessionErrorEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>(INITIAL_GROUP_BY);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSessionErrors(sessionId);
      setErrors(res.errors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [sessionId]);

  // Distinct viewports for the viewport filter dropdown. Sorted for
  // stable rendering across loads.
  const viewports = useMemo(() => {
    if (!errors) return [];
    return [...new Set(errors.map((e) => e.viewport_name))].sort();
  }, [errors]);

  // Period / viewport / URL filtering. Kind is no longer a filter —
  // the "Kind" Group-by chip serves that role now, since users can
  // either split kinds into separate buckets or merge them.
  const filtered = useMemo(() => {
    if (!errors) return [];
    const now = Date.now();
    const q = filters.urlQuery.trim().toLowerCase();
    return errors.filter((e) => {
      if (filters.period !== 'all') {
        const t = new Date(e.timestamp).getTime();
        if (Number.isNaN(t)) return false;
        if (now - t > PERIOD_MS[filters.period]) return false;
      }
      if (filters.viewport && e.viewport_name !== filters.viewport) return false;
      if (q) {
        const fields = [e.url, e.url_a, e.url_b, e.url_pair_label]
          .filter((s): s is string => Boolean(s));
        if (!fields.some((f) => f.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [errors, filters.period, filters.viewport, filters.urlQuery]);

  // Rollup. Bucket key is built from whichever GroupBy fields are
  // active; each bucket aggregates every entry that maps to that key,
  // accumulating distinct-value sets for every dimension (so summary
  // labels like "3 viewports" / "5 messages" work regardless of
  // which fields are in or out of the key).
  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    for (const e of filtered) {
      const key = bucketKeyFor(e, groupBy);
      let b = map.get(key);
      if (!b) {
        b = {
          key,
          occurrences: [],
          messages: new Set(),
          kinds: new Set(),
          sides: new Set(),
          viewports: new Set(),
          pair_ids: new Set(),
        };
        map.set(key, b);
      }
      b.occurrences.push(e);
      b.messages.add(e.error_message);
      b.kinds.add(e.kind);
      b.sides.add(e.side);
      b.viewports.add(e.viewport_name);
      b.pair_ids.add(e.url_pair_id);
    }
    const out = [...map.values()];
    for (const b of out) {
      b.occurrences.sort((a, c) => c.timestamp.localeCompare(a.timestamp));
    }
    out.sort((a, b) => b.occurrences.length - a.occurrences.length);
    return out;
  }, [filtered, groupBy]);

  // Outer message groups for the "Error on" presentation. When Error
  // is off the renderer skips this and shows buckets as a flat table
  // with a message column.
  const groups = useMemo<MessageGroup[] | null>(() => {
    if (!groupBy.error) return null;
    const byMessage = new Map<string, Bucket[]>();
    for (const b of buckets) {
      // With Error grouping on, every bucket has exactly one message.
      const msg = [...b.messages][0] ?? '';
      const list = byMessage.get(msg) ?? [];
      list.push(b);
      byMessage.set(msg, list);
    }
    const out: MessageGroup[] = [];
    for (const [message, bs] of byMessage) {
      const total = bs.reduce((acc, b) => acc + b.occurrences.length, 0);
      const captures = bs.reduce(
        (acc, b) => acc + b.occurrences.filter((o) => o.kind === 'capture').length,
        0,
      );
      out.push({
        message,
        buckets: bs,
        total_count: total,
        captures,
        comparisons: total - captures,
      });
    }
    out.sort((a, b) => b.total_count - a.total_count);
    return out;
  }, [buckets, groupBy.error]);

  // Flat lookup so the detail pane can find a bucket from the current
  // selection in O(1).
  const bucketByKey = useMemo(() => {
    const m = new Map<string, Bucket>();
    for (const b of buckets) m.set(b.key, b);
    return m;
  }, [buckets]);

  // Clear the selection if the selected bucket disappears (filter
  // change or groupBy change altered the keys).
  useEffect(() => {
    if (selectedKey === null) return;
    if (!bucketByKey.has(selectedKey)) setSelectedKey(null);
  }, [bucketByKey, selectedKey]);

  const selectedBucket = selectedKey ? bucketByKey.get(selectedKey) ?? null : null;

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const toggleGroupBy = (dim: keyof GroupBy) => {
    setGroupBy((prev) => ({ ...prev, [dim]: !prev[dim] }));
  };

  if (errors === null) {
    return (
      <p className="error-log__empty">
        {error ? `Failed to load errors: ${error}` : 'Loading errors…'}
      </p>
    );
  }
  if (error) {
    return <div className="error">Failed to load errors: {error}</div>;
  }
  if (errors.length === 0) {
    return (
      <p className="error-log__empty">
        No capture or comparison errors recorded for this session.
      </p>
    );
  }

  const distinctMessages = new Set(filtered.map((e) => e.error_message)).size;

  return (
    <div className="error-log">
      <div className="error-log__filters">
        <label className="error-log__filter">
          <span>When</span>
          <select
            value={filters.period}
            onChange={(e) => updateFilter('period', e.target.value as Period)}
          >
            {(['hour', 'day', 'week', 'all'] as const).map((p) => (
              <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
            ))}
          </select>
        </label>
        <label className="error-log__filter">
          <span>Viewport</span>
          <select
            value={filters.viewport}
            onChange={(e) => updateFilter('viewport', e.target.value)}
          >
            <option value="">All viewports</option>
            {viewports.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="error-log__filter error-log__filter--grow">
          <span>URL</span>
          <input
            type="text"
            placeholder="Filter by URL substring…"
            value={filters.urlQuery}
            onChange={(e) => updateFilter('urlQuery', e.target.value)}
          />
        </label>
        {(filters.period !== 'all' || filters.viewport || filters.urlQuery) && (
          <button
            type="button"
            className="btn btn-compact secondary"
            onClick={() => setFilters(INITIAL_FILTERS)}
          >
            Reset
          </button>
        )}
      </div>

      <div className="error-log__groupby">
        <span className="error-log__groupby-label">Group by</span>
        {(['error', 'kind', 'viewport', 'pair'] as const).map((dim) => (
          <button
            key={dim}
            type="button"
            role="switch"
            aria-checked={groupBy[dim]}
            className={`error-log__chip${groupBy[dim] ? ' error-log__chip--active' : ''}`}
            onClick={() => toggleGroupBy(dim)}
          >
            {dim === 'error' ? 'Error' : dim === 'kind' ? 'Kind' : dim === 'viewport' ? 'Viewport' : 'Pair'}
          </button>
        ))}
        <div className="error-log__groupby-spacer" />
        <button
          type="button"
          className="btn btn-compact secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <p className="muted error-log__summary">
        {filtered.length.toLocaleString()} failure{filtered.length === 1 ? '' : 's'}
        {' rolled up into '}
        {buckets.length.toLocaleString()} distinct issue{buckets.length === 1 ? '' : 's'}
        {' across '}
        {distinctMessages.toLocaleString()} message{distinctMessages === 1 ? '' : 's'}
        {filtered.length !== errors.length ? ` (of ${errors.length.toLocaleString()} total)` : ''}.
      </p>

      <div className={`error-log__body${selectedBucket ? ' error-log__body--split' : ''}`}>
        <div className="error-log__list">
          {buckets.length === 0 ? (
            <p className="error-log__empty">No errors match the current filters.</p>
          ) : groups ? (
            <ul className="error-log__groups">
              {groups.map((g, i) => (
                <li key={g.message} className="error-log__group">
                  <details open={i === 0}>
                    <summary>
                      <span className="error-log__group-count">
                        {g.total_count.toLocaleString()}×
                      </span>
                      <span className="error-log__group-kind">
                        {g.captures > 0 && g.comparisons === 0
                          ? 'capture'
                          : g.comparisons > 0 && g.captures === 0
                            ? 'comparison'
                            : 'mixed'}
                      </span>
                      <span className="error-log__group-message">{g.message}</span>
                      <span className="error-log__group-buckets muted">
                        {g.buckets.length} issue{g.buckets.length === 1 ? '' : 's'}
                      </span>
                    </summary>
                    <BucketTable
                      buckets={g.buckets}
                      groupBy={groupBy}
                      selectedKey={selectedKey}
                      onSelect={setSelectedKey}
                    />
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <div className="error-log__flat">
              <BucketTable
                buckets={buckets}
                groupBy={groupBy}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
            </div>
          )}
        </div>

        {selectedBucket && (
          <BucketDetail
            bucket={selectedBucket}
            groupBy={groupBy}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
    </div>
  );
}

interface BucketDisplayKind {
  pillClass: 'capture' | 'comparison' | 'mixed';
  label: string;
}

/** Resolve the kind/side display for a bucket. When `groupBy.kind` is
 *  on, every occurrence shares the same kind+side so we render the
 *  single value. When it's off, the bucket may mix kinds; we either
 *  render the single kind that happens to be present or "mixed". */
function describeKind(b: Bucket): BucketDisplayKind {
  if (b.kinds.size === 1) {
    const kind = [...b.kinds][0]!;
    const side = b.sides.size === 1 ? [...b.sides][0] : null;
    return {
      pillClass: kind,
      label: `${kind}${side ? ` ${side.toUpperCase()}` : ''}`,
    };
  }
  return { pillClass: 'mixed', label: 'mixed' };
}

function describeViewport(b: Bucket): string {
  if (b.viewports.size === 1) return [...b.viewports][0]!;
  return `${b.viewports.size} viewports`;
}

function describeUrl(b: Bucket): JSX.Element {
  if (b.pair_ids.size > 1) {
    return <span className="muted">{b.pair_ids.size} pairs</span>;
  }
  // Single pair — derive from any occurrence (they all share pair info).
  const rep = b.occurrences[0]!;
  if (rep.kind === 'capture' && rep.url) {
    return <span>{shorten(rep.url)}</span>;
  }
  return (
    <>
      <span title={`A: ${rep.url_a}`}>{shorten(rep.url_a)}</span>
      {' vs '}
      <span title={`B: ${rep.url_b}`}>{shorten(rep.url_b)}</span>
    </>
  );
}

function describeMessage(b: Bucket): JSX.Element {
  if (b.messages.size > 1) {
    return <span className="muted">{b.messages.size} messages</span>;
  }
  return <span>{[...b.messages][0] ?? ''}</span>;
}

function BucketTable({
  buckets,
  groupBy,
  selectedKey,
  onSelect,
}: {
  buckets: Bucket[];
  groupBy: GroupBy;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}): JSX.Element {
  const showMessage = !groupBy.error;
  return (
    <table className="error-log__table">
      <thead>
        <tr>
          <th className="error-log__col-count">×</th>
          <th>kind</th>
          <th>viewport</th>
          <th>url</th>
          {showMessage && <th>message</th>}
          <th>last seen</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => {
          const active = b.key === selectedKey;
          const last = b.occurrences[0]!;
          const kind = describeKind(b);
          return (
            <tr
              key={b.key}
              className={`error-log__row${active ? ' error-log__row--active' : ''}`}
              onClick={() => onSelect(active ? null : b.key)}
            >
              <td className="error-log__bucket-count">
                {b.occurrences.length.toLocaleString()}
              </td>
              <td>
                <span className={`error-log__pill error-log__pill--${kind.pillClass}`}>
                  {kind.label}
                </span>
              </td>
              <td className="muted">{describeViewport(b)}</td>
              <td className="error-log__url">{describeUrl(b)}</td>
              {showMessage && (
                <td className="error-log__message-cell">{describeMessage(b)}</td>
              )}
              <td className="error-log__when">{formatTime(last.timestamp)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BucketDetail({
  bucket,
  groupBy,
  onClose,
}: {
  bucket: Bucket;
  groupBy: GroupBy;
  onClose: () => void;
}): JSX.Element {
  const count = bucket.occurrences.length;
  const last = bucket.occurrences[0]!;
  const first = bucket.occurrences[count - 1]!;
  const preview = bucket.occurrences.slice(0, OCCURRENCES_PREVIEW);
  const omitted = Math.max(0, count - preview.length);
  const kind = describeKind(bucket);
  const showUrlFields = bucket.pair_ids.size === 1;

  // For the "Error message" section when the bucket spans multiple
  // messages (only possible when groupBy.error is off): break down
  // occurrences by message, sorted by count desc so the dominant
  // message reads first.
  const messageBreakdown = useMemo(() => {
    if (bucket.messages.size <= 1) return null;
    const byMsg = new Map<string, number>();
    for (const o of bucket.occurrences) {
      byMsg.set(o.error_message, (byMsg.get(o.error_message) ?? 0) + 1);
    }
    return [...byMsg.entries()]
      .map(([message, n]) => ({ message, n }))
      .sort((a, b) => b.n - a.n);
  }, [bucket]);

  return (
    <aside className="error-log__detail" aria-label="Error details">
      <div className="error-log__detail-head">
        <span className={`error-log__pill error-log__pill--${kind.pillClass}`}>
          {kind.label}
        </span>
        <span className="muted">{describeViewport(bucket)}</span>
        <span className="muted error-log__detail-when">
          {count.toLocaleString()}× · last {formatTime(last.timestamp)}
        </span>
        <button
          type="button"
          className="error-log__detail-close"
          aria-label="Close details"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <dl className="error-log__detail-fields">
        {showUrlFields ? (
          <>
            {last.url_pair_label && (
              <>
                <dt>Label</dt>
                <dd>{last.url_pair_label}</dd>
              </>
            )}
            {last.kind === 'capture' && last.url ? (
              <>
                <dt>URL ({last.side?.toUpperCase() ?? 'A/B'})</dt>
                <dd className="error-log__detail-url">{last.url}</dd>
              </>
            ) : (
              <>
                <dt>URL A</dt>
                <dd className="error-log__detail-url">{last.url_a}</dd>
                <dt>URL B</dt>
                <dd className="error-log__detail-url">{last.url_b}</dd>
              </>
            )}
            <dt>Pair id</dt>
            <dd className="muted error-log__detail-mono">{last.url_pair_id}</dd>
          </>
        ) : (
          <>
            <dt>Affected pairs</dt>
            <dd>{bucket.pair_ids.size.toLocaleString()}</dd>
          </>
        )}
        {!groupBy.kind && bucket.kinds.size > 1 && (
          <>
            <dt>Kinds</dt>
            <dd>{[...bucket.kinds].join(', ')}</dd>
          </>
        )}
        {!groupBy.viewport && bucket.viewports.size > 1 && (
          <>
            <dt>Viewports</dt>
            <dd>{[...bucket.viewports].sort().join(', ')}</dd>
          </>
        )}
        <dt>First seen</dt>
        <dd>{formatTime(first.timestamp)}</dd>
        <dt>Last seen</dt>
        <dd>{formatTime(last.timestamp)}</dd>
        <dt>Total</dt>
        <dd>{count.toLocaleString()} occurrence{count === 1 ? '' : 's'}</dd>
      </dl>

      {count > 1 && (
        <div className="error-log__detail-occurrences">
          <h4>Recent occurrences</h4>
          <ol>
            {preview.map((o) => (
              <li key={`${o.kind}:${o.id}`}>
                <span>{formatTime(o.timestamp)}</span>
                {(!groupBy.kind || !groupBy.viewport || !groupBy.pair) && (
                  <span className="muted error-log__detail-occurrence-sub">
                    {!groupBy.kind && ` · ${o.kind}${o.side ? ` ${o.side.toUpperCase()}` : ''}`}
                    {!groupBy.viewport && ` · ${o.viewport_name}`}
                    {!groupBy.pair && ` · ${shorten(o.url_pair_label ?? o.url_a ?? o.url ?? o.url_pair_id)}`}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {omitted > 0 && (
            <p className="muted error-log__detail-omitted">
              + {omitted.toLocaleString()} older
            </p>
          )}
        </div>
      )}

      <div className="error-log__detail-message">
        <h4>Error message{messageBreakdown ? `s (${messageBreakdown.length})` : ''}</h4>
        {messageBreakdown ? (
          <ul className="error-log__detail-message-list">
            {messageBreakdown.map(({ message, n }, i) => (
              <li key={message}>
                <details open={i === 0}>
                  <summary>
                    <span className="error-log__detail-message-count">
                      {n.toLocaleString()}×
                    </span>
                    <span className="error-log__detail-message-preview">{message}</span>
                  </summary>
                  <pre>{message}</pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <pre>{[...bucket.messages][0] ?? ''}</pre>
        )}
      </div>
    </aside>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shorten(url: string): string {
  if (url.length <= 60) return url;
  return `${url.slice(0, 40)}…${url.slice(-15)}`;
}
