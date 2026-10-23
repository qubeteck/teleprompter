import { describe, expect, it } from 'vitest';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/js/settings.js';

describe('settings', () => {
  it('sanitizes settings', () => {
    const settings = sanitizeSettings({ reader: { speed: -1, mirror: 'both' } });
    expect(settings.reader.speed).toBeGreaterThanOrEqual(10);
    expect(settings.reader.mirror).toBe('both');
    expect(settings.version).toBe(DEFAULT_SETTINGS.version);
  });
});
