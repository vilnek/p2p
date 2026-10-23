import { describe, expect, it } from 'vitest';
import { ownBytes } from '../../src/core/sinks';

describe('ownBytes (file writes in Safari)', () => {
  it('copies a view into a bigger buffer, so only its own bytes are written', () => {
    const whole = new Uint8Array(40).map((_, i) => i);
    const view = whole.subarray(32);
    const out = ownBytes(view);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(8);
    expect([...out]).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
  });
  it('keeps an array that already owns its whole buffer', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(ownBytes(a)).toBe(a);
  });
});
