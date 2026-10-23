import { describe, expect, it } from 'vitest';
import { failedLine, saveActions, sendPicked } from '../../src/ui/fileActions';

describe('received file buttons', () => {
  it('app: Save to Photos only for photos/videos, then Save to Files, Share or open', () => {
    expect(saveActions(true, true).map((a) => a.label)).toEqual(['Save to Photos', 'Save to Files', 'Share or open']);
    expect(saveActions(true, false).map((a) => a.label)).toEqual(['Save to Files', 'Share or open']);
  });
  it('browser: Save and Share (no Photos)', () => {
    expect(saveActions(false, false).map((a) => a.label)).toEqual(['Save', 'Share']);
    expect(saveActions(false, false).map((a) => a.testid)).toEqual(['file-save-files', 'file-share']);
  });
});

describe('sending picked items', () => {
  it('every item is sent; one that fails is counted and released, never dropped silently', async () => {
    const released: string[] = [];
    const src = (name: string) => ({ name, release: async () => void released.push(name) });
    const sent: string[] = [];
    const failed = await sendPicked(
      [src('a.jpg'), src('broken.mov'), src('c.pdf')],
      async (s) => {
        if (s.name === 'broken.mov') throw new Error('The file could not be opened.');
        return `t-${s.name}`;
      },
      (id) => sent.push(id),
    );
    expect(sent).toEqual(['t-a.jpg', 't-c.pdf']);
    expect(failed).toBe(1);
    expect(released).toEqual(['broken.mov']);
    expect(failedLine(1)).toBe('1 item couldn’t be added');
    expect(failedLine(3)).toBe('3 items couldn’t be added');
  });
});
