import type { ViewportDef } from '../types.js';

export const DEFAULT_VIEWPORTS: ViewportDef[] = [
  {
    name: 'mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    orientation: 'portrait',
  },
  {
    name: 'tablet',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    orientation: 'portrait',
  },
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    orientation: 'landscape',
  },
];

export const DEFAULT_VIEWPORT_NAME = 'desktop';
