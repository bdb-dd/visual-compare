import { useCallback, useEffect, useState, type JSX } from 'react';

export type FitMode = 'width' | 'height';

const STORAGE_KEY = 'vc:fit-mode';
const DEFAULT: FitMode = 'height';

function readStored(): FitMode {
  if (typeof window === 'undefined') return DEFAULT;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'width' || v === 'height' ? v : DEFAULT;
}

/**
 * localStorage-backed fit mode. Shared across ComparisonDetail and
 * ClusterDetailPanel so a user's choice persists between the surfaces.
 * The `storage` event listener keeps multiple open tabs in sync.
 */
export function useFitMode(): [FitMode, (next: FitMode) => void] {
  const [mode, setMode] = useState<FitMode>(readStored);

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY) return;
      setMode(e.newValue === 'width' || e.newValue === 'height' ? e.newValue : DEFAULT);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((next: FitMode): void => {
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [mode, update];
}

export function FitModeToggle({
  mode,
  onChange,
}: {
  mode: FitMode;
  onChange: (next: FitMode) => void;
}): JSX.Element {
  return (
    <div className="view-toggle" role="group" aria-label="Image fit mode">
      <button
        type="button"
        aria-pressed={mode === 'width'}
        className={`view-toggle__btn${mode === 'width' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('width')}
        title="Scale images to fill the available width"
      >
        Fit width
      </button>
      <button
        type="button"
        aria-pressed={mode === 'height'}
        className={`view-toggle__btn${mode === 'height' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('height')}
        title="Scale images to fit the viewport height; scroll horizontally if needed"
      >
        Fit height
      </button>
    </div>
  );
}
