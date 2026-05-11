import { useEffect, useRef, useState, type JSX } from 'react';
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

const AUTOSAVE_DEBOUNCE_MS = 500;

type SavingState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The session's persistent project config. Edits autosave with a short
 * debounce — there's no Save button.
 */
export function SessionConfigPanel({
  sessionId,
  config,
  viewports,
  levels,
  defaults,
  onSaved,
}: Props): JSX.Element {
  const [viewportNames, setViewportNames] = useState<string[]>(() =>
    config.default_viewports.length > 0
      ? config.default_viewports.map((v) => v.name)
      : [defaults.viewportName],
  );
  const [targetLevel, setTargetLevel] = useState<EquivalenceLevelId>(
    config.default_equivalence_level ?? defaults.level,
  );
  const [language, setLanguage] = useState<string>(
    config.filter_query.language?.join(', ') ?? '',
  );
  const [category, setCategory] = useState<string>(
    config.filter_query.category?.join(', ') ?? '',
  );
  const [pathPrefix, setPathPrefix] = useState<string>(config.filter_query.path_prefix ?? '');
  const [hideSelectors, setHideSelectors] = useState<string>(() => {
    const opts = config.default_capture_options as { hideSelectors?: string[] };
    return opts.hideSelectors?.join('\n') ?? '';
  });
  const [settleDelayMs, setSettleDelayMs] = useState<string>(() => {
    const opts = config.default_capture_options as { settleDelayMs?: number };
    return opts.settleDelayMs !== undefined ? String(opts.settleDelayMs) : '';
  });

  const [savingState, setSavingState] = useState<SavingState>('idle');
  const [error, setError] = useState<string | null>(null);

  const buildPayload = (): Partial<SessionConfig> => {
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

    return {
      default_viewports: chosenViewports,
      default_capture_options: captureOpts,
      default_equivalence_level: targetLevel,
      filter_query: filterQuery,
    };
  };

  const savedSnapshotRef = useRef<string | null>(null);
  if (savedSnapshotRef.current === null) {
    savedSnapshotRef.current = JSON.stringify(buildPayload());
  }
  const configRef = useRef<SessionConfig>(config);

  // External config changes (e.g. archive toggle elsewhere): re-hydrate local
  // state and the saved snapshot so we don't auto-save echoed values.
  useEffect(() => {
    if (configRef.current === config) return;
    configRef.current = config;
    setViewportNames(
      config.default_viewports.length > 0
        ? config.default_viewports.map((v) => v.name)
        : [defaults.viewportName],
    );
    setTargetLevel(config.default_equivalence_level ?? defaults.level);
    setLanguage(config.filter_query.language?.join(', ') ?? '');
    setCategory(config.filter_query.category?.join(', ') ?? '');
    setPathPrefix(config.filter_query.path_prefix ?? '');
    const opts = config.default_capture_options as {
      hideSelectors?: string[];
      settleDelayMs?: number;
    };
    setHideSelectors(opts.hideSelectors?.join('\n') ?? '');
    setSettleDelayMs(opts.settleDelayMs !== undefined ? String(opts.settleDelayMs) : '');
  }, [config, defaults.viewportName, defaults.level]);

  // Autosave: debounce any divergence from the last saved snapshot. The
  // serialized-payload comparison short-circuits no-ops (e.g. re-hydration
  // from our own save) without firing a request.
  useEffect(() => {
    const payload = buildPayload();
    const serialized = JSON.stringify(payload);
    if (serialized === savedSnapshotRef.current) return;
    setSavingState('saving');
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.putSessionConfig(sessionId, payload);
        savedSnapshotRef.current = serialized;
        configRef.current = next.config;
        onSaved(next.config);
        setError(null);
        setSavingState('saved');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSavingState('error');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // buildPayload reads each piece of local state directly; listing them as
    // deps captures every user edit. onSaved is treated as stable by callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportNames, targetLevel, language, category, pathPrefix, hideSelectors, settleDelayMs, sessionId]);

  const toggle = <T,>(arr: T[], value: T): T[] =>
    arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];

  return (
    <div className="config-panel">
      <div className="config-panel-header">
        <h3>Configuration</h3>
        <SaveIndicator state={savingState} />
      </div>
      {error && <div className="error">Save failed: {error}</div>}

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
    </div>
  );
}

function SaveIndicator({ state }: { state: SavingState }): JSX.Element | null {
  if (state === 'idle') return null;
  const label =
    state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save failed';
  return <span className={`autosave-indicator autosave-${state}`}>{label}</span>;
}

function parseList(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
