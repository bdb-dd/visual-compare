import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type {
  EquivalenceLevelId,
  SessionConfig,
  ViewportDef,
} from '@visual-compare/api/types';
import type { EquivalenceLevelDef } from '@visual-compare/api/constants/equivalence';

interface Props {
  sessionId: string;
  config: SessionConfig;
  viewports: ViewportDef[];
  levels: EquivalenceLevelDef[];
  /** System defaults so empty session config can be presented as "use defaults". */
  defaults: { viewportName: string; level: EquivalenceLevelId };
  onSaved: (next: SessionConfig) => void;
}

/**
 * The session's persistent project config. Each section saves on the
 * "Save" button — there's intentionally no autosave so users can stage a
 * batch of changes before triggering re-evaluation.
 */
export function SessionConfigPanel({
  sessionId,
  config,
  viewports,
  levels,
  defaults,
  onSaved,
}: Props): JSX.Element {
  // Local edit state, hydrated from the saved config. Empty arrays mean
  // "no override" — the form pre-fills the visual representation but only
  // persists what the user touches.
  const [viewportNames, setViewportNames] = useState<string[]>([]);
  const [targetLevel, setTargetLevel] = useState<EquivalenceLevelId>(defaults.level);
  const [language, setLanguage] = useState('');
  const [category, setCategory] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [hideSelectors, setHideSelectors] = useState('');
  const [settleDelayMs, setSettleDelayMs] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setViewportNames(
      config.default_viewports.length > 0
        ? config.default_viewports.map((v) => v.name)
        : [defaults.viewportName],
    );
    setTargetLevel(config.default_equivalence_level ?? defaults.level);
    setLanguage(config.filter_query.language?.join(', ') ?? '');
    setCategory(config.filter_query.category?.join(', ') ?? '');
    setPathPrefix(config.filter_query.path_prefix ?? '');
    const opts = config.default_capture_options as { hideSelectors?: string[]; settleDelayMs?: number };
    setHideSelectors(opts.hideSelectors?.join('\n') ?? '');
    setSettleDelayMs(opts.settleDelayMs !== undefined ? String(opts.settleDelayMs) : '');
  }, [config, defaults.viewportName, defaults.level]);

  const toggle = <T,>(arr: T[], value: T): T[] =>
    arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosenViewports = viewports.filter((v) => viewportNames.includes(v.name));
      const captureOpts: Record<string, unknown> = {};
      const trimmedHide = hideSelectors
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (trimmedHide.length > 0) captureOpts.hideSelectors = trimmedHide;
      if (settleDelayMs.trim().length > 0) {
        const n = Number(settleDelayMs);
        if (Number.isFinite(n) && n >= 0) captureOpts.settleDelayMs = Math.round(n);
      }
      const filterQuery: Record<string, unknown> = {};
      const langs = parseList(language);
      if (langs.length > 0) filterQuery.language = langs;
      const cats = parseList(category);
      if (cats.length > 0) filterQuery.category = cats;
      if (pathPrefix.trim().length > 0) filterQuery.path_prefix = pathPrefix.trim();

      const next = await api.putSessionConfig(sessionId, {
        default_viewports: chosenViewports,
        default_capture_options: captureOpts,
        default_equivalence_level: targetLevel,
        region_match_config: config.region_match_config,
        filter_query: filterQuery,
      });
      onSaved(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config-panel">
      <h3 style={{ marginTop: 0 }}>Configuration</h3>
      {error && <div className="error">{error}</div>}

      <section>
        <h4>Viewports</h4>
        <div className="checkbox-row">
          {viewports.map((v) => (
            <label key={v.name}>
              <input
                type="checkbox"
                checked={viewportNames.includes(v.name)}
                onChange={() => setViewportNames((prev) => toggle(prev, v.name))}
              />
              {v.name} <span className="muted">({v.width}×{v.height})</span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h4>Target equivalence level</h4>
        <div className="checkbox-row">
          {levels.map((l) => (
            <label key={l.id}>
              <input
                type="radio"
                name="target-level"
                checked={targetLevel === l.id}
                onChange={() => setTargetLevel(l.id)}
              />
              {l.name}
            </label>
          ))}
        </div>
      </section>

      <section>
        <h4>Filter</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          Comma-separated. Empty means no constraint on that facet.
        </p>
        <label className="field">
          <span>Languages</span>
          <input
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="e.g. no, en"
          />
        </label>
        <label className="field">
          <span>Categories</span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. starte-og-drive, hjelp"
          />
        </label>
        <label className="field">
          <span>Path prefix</span>
          <input
            type="text"
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
            placeholder="e.g. /starte-og-drive/regnskap"
          />
        </label>
      </section>

      <section>
        <h4>Capture options</h4>
        <label className="field">
          <span>Hide selectors (one per line)</span>
          <textarea
            rows={3}
            value={hideSelectors}
            onChange={(e) => setHideSelectors(e.target.value)}
            placeholder=".banner&#10;#cookie-consent"
          />
        </label>
        <label className="field">
          <span>Settle delay (ms)</span>
          <input
            type="number"
            min={0}
            value={settleDelayMs}
            onChange={(e) => setSettleDelayMs(e.target.value)}
            placeholder="250"
          />
        </label>
      </section>

      {/* Allow-list section removed: subsumed by acceptances (phase 3+). */}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save config'}
        </button>
      </div>
    </div>
  );
}

function parseList(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
