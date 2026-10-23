// The 3-word check after "I've written them down" (ui/words.ts).
import { describe, expect, it } from 'vitest';
import { pickThree, wordsMatch } from '../../src/ui/words';

describe('24 words check', () => {
  it('asks three different positions between 1 and 24, in order', () => {
    for (let i = 0; i < 200; i++) {
      const ns = pickThree();
      expect(ns).toHaveLength(3);
      expect(new Set(ns).size).toBe(3);
      expect([...ns].sort((a, b) => a - b)).toEqual(ns);
      for (const n of ns) expect(n >= 1 && n <= 24).toBe(true);
    }
  });

  it('matches the paper (case and spaces don’t matter), and only the right positions', () => {
    const phrase = Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(' ');
    expect(wordsMatch(phrase, [[4, 'w4'], [11, ' W11 '], [19, 'w19']])).toBe(true);
    expect(wordsMatch(phrase, [[4, 'w4'], [11, 'w12'], [19, 'w19']])).toBe(false);
    expect(wordsMatch(phrase, [[4, ''], [11, 'w11'], [19, 'w19']])).toBe(false);
  });
});
