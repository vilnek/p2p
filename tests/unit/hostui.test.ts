import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_UI_FEATURE, hostEmit, hostOff, hostOn, isHostTab, isHostUi } from '../../src/hostui';
import { NO_SCREEN_HERE, shareErrorText } from '../../src/ui/shareError';

// Host mode (?embed=1&ui=1, design CN2): the switch and the event bus (the API itself is tested end to end).

describe('host mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is on only with embed=1 and ui=1', () => {
    expect(isHostUi(new URLSearchParams('embed=1&ui=1'))).toBe(true);
    expect(isHostUi(new URLSearchParams('ui=1&embed=1&relays=x'))).toBe(true);
    expect(isHostUi(new URLSearchParams('embed=1'))).toBe(false); // headless embed stays as it was
    expect(isHostUi(new URLSearchParams('ui=1'))).toBe(false);
    expect(isHostUi(new URLSearchParams('embed=1&ui=0'))).toBe(false);
    expect(isHostUi(new URLSearchParams(''))).toBe(false);
    expect(HOST_UI_FEATURE).toBe('hostui');
  });

  it('knows the five tabs only', () => {
    for (const t of ['chats', 'groups', 'calls', 'add', 'me']) expect(isHostTab(t)).toBe(true);
    for (const t of ['home', 'words', '', null, 3, 'Chats']) expect(isHostTab(t)).toBe(false);
  });

  it('sends events to in-page listeners (full data) and to the host (plain data)', () => {
    const posted: unknown[] = [];
    vi.stubGlobal('window', { webkit: { messageHandlers: { p2ptalk: { postMessage: (m: unknown) => posted.push(m) } } } });
    const seen: unknown[] = [];
    const off = hostOn('share', (d) => seen.push(d));
    hostEmit('share', { link: 'https://p2p.vilnek.in/#c=x', name: 'Dr Vijay' });
    hostEmit('stream', { kind: 'remote', stream: { big: true } }, { kind: 'remote', tracks: ['audio'] });
    expect(seen).toEqual([{ link: 'https://p2p.vilnek.in/#c=x', name: 'Dr Vijay' }]);
    expect(posted).toEqual([
      { event: 'share', data: { link: 'https://p2p.vilnek.in/#c=x', name: 'Dr Vijay' } },
      { event: 'stream', data: { kind: 'remote', tracks: ['audio'] } },
    ]);
    off();
    hostEmit('share', { link: 'y', name: '' });
    expect(seen).toHaveLength(1);
  });

  it('a failing listener or a missing host never stops the others', () => {
    vi.stubGlobal('window', {});
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const bad = () => {
      throw new Error('boom');
    };
    hostOn('groupMessage', bad);
    hostOn('groupMessage', (d) => seen.push(d));
    expect(() => hostEmit('groupMessage', { groupId: 'g', text: 'Hi' })).not.toThrow();
    expect(seen).toEqual([{ groupId: 'g', text: 'Hi' }]);
    hostOff('groupMessage', bad);
  });

  it('says plainly when the window has no screen capture', () => {
    expect(shareErrorText(new Error(NO_SCREEN_HERE), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('This window can’t share the screen.');
  });
});
