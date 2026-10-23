import { describe, expect, it } from 'vitest';
import { dammDigit, dammValid } from '../../src/core/damm';

function randomDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}

describe('Damm check digit', () => {
  it('matches the published example (572 -> 4)', () => {
    expect(dammDigit('572')).toBe('4');
    expect(dammValid('5724')).toBe(true);
  });

  it('catches every single wrong digit', () => {
    for (let trial = 0; trial < 200; trial++) {
      const body = randomDigits(23);
      const id = body + dammDigit(body);
      expect(dammValid(id)).toBe(true);
      for (let pos = 0; pos < id.length; pos++) {
        for (let d = 0; d <= 9; d++) {
          if (String(d) === id[pos]) continue;
          const bad = id.slice(0, pos) + d + id.slice(pos + 1);
          expect(dammValid(bad), `${id} -> ${bad}`).toBe(false);
        }
      }
    }
  });

  it('catches every swap of two neighbouring digits', () => {
    for (let trial = 0; trial < 200; trial++) {
      const body = randomDigits(23);
      const id = body + dammDigit(body);
      for (let pos = 0; pos < id.length - 1; pos++) {
        if (id[pos] === id[pos + 1]) continue;
        const bad = id.slice(0, pos) + id[pos + 1] + id[pos] + id.slice(pos + 2);
        expect(dammValid(bad), `${id} -> ${bad}`).toBe(false);
      }
    }
  });

  it('catches all adjacent swaps for every pair of digits', () => {
    for (let a = 0; a <= 9; a++)
      for (let b = 0; b <= 9; b++) {
        if (a === b) continue;
        const body = `12${a}${b}34`;
        const id = body + dammDigit(body);
        expect(dammValid(`12${b}${a}34${id.at(-1)}`)).toBe(false);
      }
  });
});
