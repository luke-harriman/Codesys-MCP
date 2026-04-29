import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  formatStaleness,
  ResizeWarning,
  STALE_THRESHOLD_MS,
  MIN_COLUMNS,
  MIN_ROWS,
} from '../../src/tui/browser/Statusbar.tsx';

describe('formatStaleness', () => {
  it('returns null when mirror is fresh', () => {
    expect(formatStaleness(Date.now() - 1_000)).toBeNull();
    expect(formatStaleness(Date.now() - (STALE_THRESHOLD_MS - 1))).toBeNull();
  });

  it('returns "Xs" when mirror is between threshold and 60s old', () => {
    const ageMs = Math.max(STALE_THRESHOLD_MS, 30_000);
    const out = formatStaleness(Date.now() - ageMs);
    expect(out).toMatch(/\d+s/);
  });

  it('returns "Xm Ys" when mirror is minutes old', () => {
    const out = formatStaleness(Date.now() - 5 * 60_000 - 12_000);
    expect(out).toMatch(/5m/);
  });

  it('returns "Xh Ym" when mirror is hours old', () => {
    const out = formatStaleness(Date.now() - 2 * 3600_000 - 30 * 60_000);
    expect(out).toMatch(/2h/);
  });
});

describe('<ResizeWarning>', () => {
  it('renders nothing when terminal is large enough', () => {
    const { lastFrame } = render(<ResizeWarning columns={MIN_COLUMNS} rows={MIN_ROWS} />);
    expect(lastFrame()).toBe('');
  });

  it('warns when columns are below the minimum', () => {
    const { lastFrame } = render(<ResizeWarning columns={MIN_COLUMNS - 1} rows={MIN_ROWS} />);
    expect(lastFrame()).toMatch(/Terminal too narrow/);
  });

  it('warns when rows are below the minimum', () => {
    const { lastFrame } = render(<ResizeWarning columns={MIN_COLUMNS} rows={MIN_ROWS - 1} />);
    expect(lastFrame()).toMatch(/Terminal too short/);
  });
});
