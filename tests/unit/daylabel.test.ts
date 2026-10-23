// Day headings in a chat: Today / Yesterday / weekday (this week) / date.
import { describe, expect, it } from 'vitest';
import { dayLabel } from '../../src/ui/dom';

describe('day headings', () => {
  it('Today, Yesterday, a weekday within the week, then a date (with the year when it differs)', () => {
    const now = new Date(2026, 9, 23, 10, 0).getTime(); // Fri 23 Oct 2026
    expect(dayLabel(new Date(2026, 9, 23, 0, 5).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 22, 23, 50).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 19, 9).getTime(), now)).toBe(new Date(2026, 9, 19).toLocaleDateString([], { weekday: 'long' }));
    expect(dayLabel(new Date(2026, 9, 2).getTime(), now)).toBe(new Date(2026, 9, 2).toLocaleDateString([], { day: 'numeric', month: 'short' }));
    expect(dayLabel(new Date(2025, 11, 31).getTime(), now)).toMatch(/2025/);
  });
});
