import type { EquivalenceLevelId } from '../types.js';

export interface EquivalenceLevelDef {
  id: EquivalenceLevelId;
  name: string;
  description: string;
  // Threshold expressed as percent (0-100). A comparison is equivalent when
  // changed_pixel_percentage <= max_changed_pixel_percentage.
  max_changed_pixel_percentage: number;
  // Ambiguity band (in percent points) around the threshold where LM Studio
  // would be invoked as a tiebreaker when LM is wired up. Stored here so the
  // pipeline can record the band even before LM integration ships.
  ambiguity_band_percentage: number;
  // Minimum SSIM (0-1) accepted as a perceptual signal for `tolerant`/`loose`
  // levels. `pixel-perfect` and `strict` ignore SSIM. `semantic` is decided by
  // LM, not pixel thresholds.
  min_ssim: number | null;
  // True if the level always defers to LM Studio for the final decision.
  semantic: boolean;
}

export const EQUIVALENCE_LEVELS: EquivalenceLevelDef[] = [
  {
    id: 'pixel-perfect',
    name: 'Pixel Perfect',
    description: 'Zero changed pixels.',
    max_changed_pixel_percentage: 0,
    ambiguity_band_percentage: 0,
    min_ssim: null,
    semantic: false,
  },
  {
    id: 'strict',
    name: 'Strict',
    description: 'Very small pixel difference allowed.',
    max_changed_pixel_percentage: 0.5,
    ambiguity_band_percentage: 0.25,
    min_ssim: null,
    semantic: false,
  },
  {
    id: 'tolerant',
    name: 'Tolerant',
    description: 'Moderate pixel/layout variance accepted.',
    max_changed_pixel_percentage: 5,
    ambiguity_band_percentage: 2,
    min_ssim: 0.95,
    semantic: false,
  },
  {
    id: 'loose',
    name: 'Loose',
    description: 'Broad visual similarity accepted.',
    max_changed_pixel_percentage: 15,
    ambiguity_band_percentage: 5,
    min_ssim: 0.85,
    semantic: false,
  },
  {
    id: 'semantic',
    name: 'Semantic',
    description: 'LM Studio decides content/purpose equivalence.',
    max_changed_pixel_percentage: 100,
    ambiguity_band_percentage: 0,
    min_ssim: null,
    semantic: true,
  },
];

export function getEquivalenceLevel(id: EquivalenceLevelId): EquivalenceLevelDef {
  const level = EQUIVALENCE_LEVELS.find((l) => l.id === id);
  if (!level) {
    throw new Error(`Unknown equivalence level: ${id}`);
  }
  return level;
}

export const DEFAULT_EQUIVALENCE_LEVEL: EquivalenceLevelId = 'tolerant';
