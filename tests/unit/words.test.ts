// The 24 words: Copy gives them numbered; restore reads that back (ui/words.ts, core/identity.ts).
import { describe, expect, it } from 'vitest';
import { numberedWords } from '../../src/ui/words';
import { newPhrase, normalisePhrase, phraseIsValid } from '../../src/core/identity';

describe('24 words: numbered Copy and restore', () => {
  const phrase = newPhrase();
  const words = phrase.split(' ');

  it('Copy gives a heading, then one numbered word per line', () => {
    const text = numberedWords(words);
    const lines = text.split('\n');
    expect(lines).toHaveLength(25);
    expect(lines[0]).toBe('P2P Talk: my 24 words');
    expect(lines[1]).toBe(`1. ${words[0]}`);
    expect(lines[24]).toBe(`24. ${words[23]}`);
  });

  it('restore reads the copied text, numbered pastes and plain words alike', () => {
    expect(normalisePhrase(numberedWords(words))).toBe(phrase);
    expect(normalisePhrase(words.map((w, i) => `${i + 1}. ${w}`).join(' '))).toBe(phrase);
    expect(normalisePhrase(words.map((w, i) => `${i + 1}) ${w.toUpperCase()}`).join('\r\n'))).toBe(phrase);
    expect(normalisePhrase(words.map((w, i) => `${i + 1}.${w}`).join('  '))).toBe(phrase);
    expect(normalisePhrase(`  ${phrase}  `)).toBe(phrase);
    expect(phraseIsValid(numberedWords(words))).toBe(true);
  });

  it('a wrong word is still refused', () => {
    const bad = [...words];
    bad[5] = 'notaword';
    expect(phraseIsValid(numberedWords(bad))).toBe(false);
  });
});
