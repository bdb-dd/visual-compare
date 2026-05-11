import { useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type {
  LmPromptDto,
  LmPromptInvocationReasonDto,
  PromptGuidanceDto,
  PromptGuidanceTogglesDto,
} from '@visual-compare/api/types';

interface Props {
  sessionId: string;
  onClose: () => void;
}

type ToggleKind = 'scope' | 'trigger';

interface ToggleDef {
  key: keyof PromptGuidanceTogglesDto;
  kind: ToggleKind;
  label: string;
  helper: string;
}

const AUTOSAVE_DEBOUNCE_MS = 500;

type SavingState = 'idle' | 'saving' | 'saved' | 'error';

const TOGGLES: ToggleDef[] = [
  {
    key: 'ignore_chrome_only_diffs',
    kind: 'scope',
    label: 'Ignore site chrome',
    helper:
      'Excludes the top banner, header buttons (Log in, Menu), and footer from evaluation. Differences confined to these regions cannot flip the verdict.',
  },
  {
    key: 'language_must_match',
    kind: 'trigger',
    label: 'Language must match',
    helper:
      'A language change (e.g. English vs Norwegian) is treated as a content change, not a localization.',
  },
  {
    key: 'flag_added_removed_content',
    kind: 'trigger',
    label: 'Flag added/removed content',
    helper:
      'Any added or removed list item, announcement, or link in non-excluded regions flips the verdict to non-equivalent.',
  },
];

const TOGGLES_BY_KIND: Record<ToggleKind, ToggleDef[]> = {
  scope: TOGGLES.filter((t) => t.kind === 'scope'),
  trigger: TOGGLES.filter((t) => t.kind === 'trigger'),
};

const REASON_LABELS: Record<LmPromptInvocationReasonDto, string> = {
  target_level_failure: 'Second-pass review (after target-level miss)',
  ambiguous_pixel_result: 'Tiebreaker (ambiguous pixel result)',
};

const REASONS: LmPromptInvocationReasonDto[] = [
  'target_level_failure',
  'ambiguous_pixel_result',
];

export function PromptConfigPanel({ sessionId, onClose }: Props): JSX.Element {
  const [prompts, setPrompts] = useState<Record<LmPromptInvocationReasonDto, LmPromptDto> | null>(
    null,
  );
  const [activeReason, setActiveReason] = useState<LmPromptInvocationReasonDto>('target_level_failure');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listSessionPrompts(sessionId);
        if (cancelled) return;
        const map = {} as Record<LmPromptInvocationReasonDto, LmPromptDto>;
        for (const p of res.prompts) map[p.invocation_reason] = p;
        setPrompts(map);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) {
    return (
      <div className="prompt-config-panel">
        <div className="prompt-config-header">
          <h3>LM prompt configuration</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
        <p className="muted">Failed to load: {error}</p>
      </div>
    );
  }

  if (!prompts) {
    return (
      <div className="prompt-config-panel">
        <div className="prompt-config-header">
          <h3>LM prompt configuration</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const active = prompts[activeReason];

  function replaceActive(updated: LmPromptDto) {
    setPrompts((prev) => (prev ? { ...prev, [updated.invocation_reason]: updated } : prev));
  }

  return (
    <div className="prompt-config-panel">
      <div className="prompt-config-header">
        <h3>LM prompt configuration</h3>
        <button className="btn secondary" onClick={onClose}>Close</button>
      </div>
      <p className="muted prompt-config-intro">
        Tune what the vision model treats as a meaningful difference for this session.
        Toggles + house rules are appended to the base prompt; advanced mode replaces it
        entirely. Edits autosave and invalidate the LM cache for affected comparisons.
      </p>
      <div className="prompt-config-tabs">
        {REASONS.map((r) => (
          <button
            key={r}
            className={`prompt-config-tab ${r === activeReason ? 'active' : ''}`}
            onClick={() => setActiveReason(r)}
            type="button"
          >
            {REASON_LABELS[r]}
          </button>
        ))}
      </div>
      <PromptEditor
        sessionId={sessionId}
        prompt={active}
        onSaved={replaceActive}
      />
    </div>
  );
}

function buildBody(draft: LmPromptDto): unknown {
  if (draft.mode === 'structured') {
    const guidance: PromptGuidanceDto =
      draft.guidance ?? { toggles: {}, house_rules: { scope: [], trigger: [] } };
    return {
      mode: 'structured' as const,
      guidance: {
        toggles: guidance.toggles,
        house_rules: {
          scope: guidance.house_rules.scope.filter((r) => r.trim().length > 0),
          trigger: guidance.house_rules.trigger.filter((r) => r.trim().length > 0),
        },
      },
    };
  }
  return { mode: 'advanced' as const, prompt_text: draft.prompt_text };
}

function PromptEditor({
  sessionId,
  prompt,
  onSaved,
}: {
  sessionId: string;
  prompt: LmPromptDto;
  onSaved: (next: LmPromptDto) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<LmPromptDto>(prompt);
  const [showAdvanced, setShowAdvanced] = useState(prompt.mode === 'advanced');
  const [savingState, setSavingState] = useState<SavingState>('idle');
  const [resetBusy, setResetBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedSnapshotRef = useRef<string | null>(null);
  if (savedSnapshotRef.current === null) {
    savedSnapshotRef.current = JSON.stringify(buildBody(prompt));
  }
  const promptRef = useRef<LmPromptDto>(prompt);

  // Re-hydrate when the parent swaps in a different prompt (tab switch or
  // an externally saved version). Resetting savedSnapshotRef prevents the
  // autosave effect from echoing the rehydrated values back to the server.
  useEffect(() => {
    if (promptRef.current === prompt) return;
    promptRef.current = prompt;
    setDraft(prompt);
    setShowAdvanced(prompt.mode === 'advanced');
    setError(null);
    savedSnapshotRef.current = JSON.stringify(buildBody(prompt));
  }, [prompt]);

  // Autosave on draft changes (debounced).
  useEffect(() => {
    const serialized = JSON.stringify(buildBody(draft));
    if (serialized === savedSnapshotRef.current) return;
    setSavingState('saving');
    const timer = window.setTimeout(async () => {
      try {
        const body = buildBody(draft) as Parameters<typeof api.putSessionPrompt>[2];
        const res = await api.putSessionPrompt(sessionId, draft.invocation_reason, body);
        savedSnapshotRef.current = serialized;
        promptRef.current = res.prompt;
        onSaved(res.prompt);
        setError(null);
        setSavingState('saved');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSavingState('error');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sessionId]);

  const guidance: PromptGuidanceDto =
    draft.guidance ?? { toggles: {}, house_rules: { scope: [], trigger: [] } };

  function setToggle(key: keyof PromptGuidanceTogglesDto, value: boolean) {
    setDraft({
      ...draft,
      mode: 'structured',
      guidance: {
        ...guidance,
        toggles: { ...guidance.toggles, [key]: value },
      },
    });
  }

  function setHouseRulesText(kind: ToggleKind, text: string) {
    const rules = text.split('\n').slice(0, 10);
    setDraft({
      ...draft,
      mode: 'structured',
      guidance: {
        ...guidance,
        house_rules: { ...guidance.house_rules, [kind]: rules },
      },
    });
  }

  function setAdvancedText(text: string) {
    setDraft({ ...draft, mode: 'advanced', prompt_text: text, guidance: null });
  }

  async function reset() {
    setResetBusy(true);
    setError(null);
    try {
      const res = await api.resetSessionPrompt(sessionId, draft.invocation_reason);
      savedSnapshotRef.current = JSON.stringify(buildBody(res.prompt));
      promptRef.current = res.prompt;
      setDraft(res.prompt);
      setShowAdvanced(res.prompt.mode === 'advanced');
      onSaved(res.prompt);
      setSavingState('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSavingState('error');
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="prompt-editor">
      {!showAdvanced && (
        <>
          <p className="muted prompt-editor-flow">
            Step 1 narrows what the model looks at. Step 2 decides equivalence on what remains.
            A difference confined to a Step 1 region cannot itself flip the verdict.
          </p>
          <RuleStage
            kind="scope"
            heading="Step 1 — Regions to exclude"
            placeholder={'e.g.\nCookie consent overlays\nNewsletter signup modal'}
            toggles={TOGGLES_BY_KIND.scope}
            toggleValues={guidance.toggles}
            onToggle={setToggle}
            houseRules={guidance.house_rules.scope}
            onHouseRulesChange={(t) => setHouseRulesText('scope', t)}
          />
          <RuleStage
            kind="trigger"
            heading="Step 2 — Equivalence triggers"
            placeholder={'e.g.\nHero headline must be identical\nFlag any "Last updated" date difference'}
            toggles={TOGGLES_BY_KIND.trigger}
            toggleValues={guidance.toggles}
            onToggle={setToggle}
            houseRules={guidance.house_rules.trigger}
            onHouseRulesChange={(t) => setHouseRulesText('trigger', t)}
          />
        </>
      )}

      <details
        className="prompt-advanced"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary>Advanced: edit the raw system prompt</summary>
        <p className="muted">
          Replaces the entire system prompt verbatim. Your toggles and house rules above are
          ignored while in advanced mode. Use Reset to return to the structured editor.
        </p>
        <textarea
          value={draft.prompt_text}
          onChange={(e) => setAdvancedText(e.target.value)}
          rows={16}
          spellCheck={false}
        />
      </details>

      {error && <p className="prompt-editor-error">Save failed: {error}</p>}

      <div className="prompt-editor-actions">
        <SaveIndicator state={savingState} />
        <button className="btn secondary" onClick={() => void reset()} disabled={resetBusy} type="button">
          {resetBusy ? 'Resetting…' : 'Reset to default'}
        </button>
        <span className="muted prompt-editor-meta">
          mode: {draft.mode} · prompt_id {draft.prompt_id.slice(0, 8)}
        </span>
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SavingState }): JSX.Element | null {
  if (state === 'idle') return null;
  const label =
    state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save failed';
  return <span className={`autosave-indicator autosave-${state}`}>{label}</span>;
}

function RuleStage({
  kind,
  heading,
  placeholder,
  toggles,
  toggleValues,
  onToggle,
  houseRules,
  onHouseRulesChange,
}: {
  kind: ToggleKind;
  heading: string;
  placeholder: string;
  toggles: ToggleDef[];
  toggleValues: PromptGuidanceTogglesDto;
  onToggle: (key: keyof PromptGuidanceTogglesDto, value: boolean) => void;
  houseRules: string[];
  onHouseRulesChange: (text: string) => void;
}): JSX.Element {
  return (
    <fieldset className={`prompt-stage prompt-stage-${kind}`}>
      <legend>{heading}</legend>
      {toggles.length > 0 ? (
        <div className="prompt-stage-toggles">
          {toggles.map((t) => (
            <label key={t.key} className="prompt-toggle">
              <input
                type="checkbox"
                checked={Boolean(toggleValues[t.key])}
                onChange={(e) => onToggle(t.key, e.target.checked)}
              />
              <span className="prompt-toggle-label">{t.label}</span>
              <span className="prompt-toggle-helper muted">{t.helper}</span>
            </label>
          ))}
        </div>
      ) : null}
      <label className="prompt-house-rules">
        <span className="muted">
          {kind === 'scope'
            ? 'Custom regions to exclude (one per line)'
            : 'Custom triggers (one per line)'}
        </span>
        <textarea
          value={houseRules.join('\n')}
          onChange={(e) => onHouseRulesChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
        />
      </label>
    </fieldset>
  );
}
