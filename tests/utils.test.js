import { describe, expect, it } from 'vitest';
import { clamp, countWords, formatDuration } from '../src/js/utils.js';

describe('utils', () => {
  it('clamp bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it('countWords counts tokens', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('')).toBe(0);
  });
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(3661)).toBe('1h 1m 1s');
  });
});
