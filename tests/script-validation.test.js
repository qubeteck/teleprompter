import { describe, expect, it } from 'vitest';
import { createBlankScript } from '../src/js/script-validation.js';

describe('script-validation', () => {
  it('creates blank script with defaults', () => {
    const script = createBlankScript({ title: 'Test' });
    expect(script.title).toBe('Test');
    expect(['markdown', 'plain', 'html']).toContain(script.contentFormat);
    expect(Array.isArray(script.tags)).toBe(true);
  });
});
