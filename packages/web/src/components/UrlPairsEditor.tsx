import { useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { UrlPairRow } from '@visual-compare/api/types';

interface Props {
  sessionId: string;
  pairs: UrlPairRow[];
  onChange: () => void;
}

interface PairEditState {
  url_a: string;
  url_b: string;
  label: string;
  language: string;
  category: string;
  subcategory: string;
  path: string;
}

const empty: PairEditState = {
  url_a: '',
  url_b: '',
  label: '',
  language: '',
  category: '',
  subcategory: '',
  path: '',
};

function toEditState(p: UrlPairRow): PairEditState {
  return {
    url_a: p.url_a,
    url_b: p.url_b,
    label: p.label ?? '',
    language: p.language ?? '',
    category: p.category ?? '',
    subcategory: p.subcategory ?? '',
    path: p.path ?? '',
  };
}

function toPatchBody(state: PairEditState, original?: UrlPairRow): Record<string, unknown> {
  const orZero = (s: string): string | null => (s.trim().length > 0 ? s.trim() : null);
  const out: Record<string, unknown> = {};
  if (!original || state.url_a !== original.url_a) out.url_a = state.url_a.trim();
  if (!original || state.url_b !== original.url_b) out.url_b = state.url_b.trim();
  if (!original || state.label !== (original.label ?? '')) out.label = orZero(state.label);
  if (!original || state.language !== (original.language ?? '')) out.language = orZero(state.language);
  if (!original || state.category !== (original.category ?? '')) out.category = orZero(state.category);
  if (!original || state.subcategory !== (original.subcategory ?? '')) {
    out.subcategory = orZero(state.subcategory);
  }
  if (!original || state.path !== (original.path ?? '')) out.path = orZero(state.path);
  return out;
}

export function UrlPairsEditor({ sessionId, pairs, onChange }: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<PairEditState>(empty);
  const [adding, setAdding] = useState(false);
  const [addState, setAddState] = useState<PairEditState>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (p: UrlPairRow) => {
    setEditingId(p.id);
    setEditState(toEditState(p));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditState(empty);
    setError(null);
  };

  const saveEdit = async (original: UrlPairRow) => {
    const patch = toPatchBody(editState, original);
    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patchUrlPair(sessionId, original.id, patch);
      cancelEdit();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleDisabled = async (p: UrlPairRow) => {
    if (!p.disabled && !confirm(`Disable "${p.label ?? p.url_a}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchUrlPair(sessionId, p.id, { disabled: !p.disabled });
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addPair = async () => {
    if (!addState.url_a.trim() || !addState.url_b.trim()) {
      setError('Both URLs are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addUrlPairs(sessionId, [
        {
          url_a: addState.url_a.trim(),
          url_b: addState.url_b.trim(),
          label: addState.label.trim() || null,
          language: addState.language.trim() || null,
          category: addState.category.trim() || null,
          subcategory: addState.subcategory.trim() || null,
          path: addState.path.trim() || null,
        },
      ]);
      setAdding(false);
      setAddState(empty);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <div style={{ marginBottom: 8 }}>
        {adding ? (
          <div className="pair-edit">
            <PairFields state={addState} setState={setAddState} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => void addPair()} disabled={busy}>
                {busy ? 'Adding…' : 'Add pair'}
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  setAdding(false);
                  setAddState(empty);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn secondary"
            style={{ padding: '4px 10px', fontSize: 13 }}
            onClick={() => setAdding(true)}
          >
            + Add pair
          </button>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>URL A</th>
            <th>URL B</th>
            <th>Label</th>
            <th>Lang</th>
            <th>Category</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => {
            const isEditing = editingId === p.id;
            if (isEditing) {
              return (
                <tr key={p.id}>
                  <td colSpan={7}>
                    <PairFields state={editState} setState={setEditState} />
                    <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
                      Changing a URL creates a new pair and disables this one — old
                      captures stay attached for traceability.
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={() => void saveEdit(p)} disabled={busy}>
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      <button className="btn secondary" onClick={cancelEdit} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              );
            }
            const rowClass = p.disabled ? 'disabled-pair' : undefined;
            return (
              <tr key={p.id} className={rowClass}>
                <td>{p.row_index + 1}</td>
                <td>{p.url_a}</td>
                <td>{p.url_b}</td>
                <td>{p.label ?? ''}</td>
                <td className="muted">{p.language ?? ''}</td>
                <td className="muted">{p.category ?? ''}</td>
                <td>
                  {p.disabled ? (
                    <button
                      className="btn secondary"
                      style={{ padding: '2px 8px', fontSize: 12 }}
                      onClick={() => void toggleDisabled(p)}
                      disabled={busy}
                    >
                      Re-enable
                    </button>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        className="btn secondary"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        onClick={() => startEdit(p)}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      <button
                        className="btn secondary"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        onClick={() => void toggleDisabled(p)}
                        disabled={busy}
                      >
                        Disable
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PairFields({
  state,
  setState,
}: {
  state: PairEditState;
  setState: (s: PairEditState) => void;
}): JSX.Element {
  const upd = (k: keyof PairEditState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setState({ ...state, [k]: e.target.value });
  return (
    <div className="pair-fields">
      <label className="field"><span>URL A</span><input type="text" value={state.url_a} onChange={upd('url_a')} /></label>
      <label className="field"><span>URL B</span><input type="text" value={state.url_b} onChange={upd('url_b')} /></label>
      <label className="field"><span>Label</span><input type="text" value={state.label} onChange={upd('label')} /></label>
      <label className="field"><span>Language</span><input type="text" value={state.language} onChange={upd('language')} /></label>
      <label className="field"><span>Category</span><input type="text" value={state.category} onChange={upd('category')} /></label>
      <label className="field"><span>Subcategory</span><input type="text" value={state.subcategory} onChange={upd('subcategory')} /></label>
      <label className="field"><span>Path</span><input type="text" value={state.path} onChange={upd('path')} /></label>
    </div>
  );
}
