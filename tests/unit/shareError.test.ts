import { describe, expect, it } from 'vitest';
import { browserName, shareErrorText } from '../../src/ui/shareError';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const err = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('Share screen: what the person is told when it does not start', () => {
  it('the Mac has not allowed the browser: the exact setting, with the browser name', () => {
    const t = shareErrorText(err('NotAllowedError', 'Permission denied by system'), MAC_CHROME);
    expect(t).toBe('Your Mac hasn’t allowed Google Chrome to share the screen. Open System Settings › Privacy & Security › Screen & System Audio Recording, turn on Google Chrome, then open it again.');
    expect(shareErrorText(err('NotReadableError', 'Could not start video source'), MAC_CHROME)).toBe(t);
  });

  it('closing the picker (or the phone sheet), or a second tap while starting: nothing is said', () => {
    expect(shareErrorText(err('NotAllowedError', 'Permission denied'), MAC_CHROME)).toBeNull();
    expect(shareErrorText(err('NotAllowedError', 'Screen sharing was cancelled.'), IPHONE)).toBeNull();
    expect(shareErrorText(err('AbortError', 'Screen sharing is already starting.'), IPHONE)).toBeNull();
  });

  it('other computers and other failures: plain sentences, never silent', () => {
    expect(shareErrorText(err('NotAllowedError', 'Permission denied by system'), WIN_EDGE)).toMatch(/hasn’t allowed the browser/);
    expect(shareErrorText(err('NotReadableError'), WIN_EDGE)).toMatch(/couldn’t be shared/);
    expect(shareErrorText(err('NotFoundError'), MAC_CHROME)).toBe('There’s no screen to share.');
    expect(shareErrorText(new Error('This browser can’t share the screen.'), IPHONE)).toBe('This browser can’t share the screen.');
    expect(shareErrorText(new Error('Asha is sharing their screen. One person at a time.'), MAC_CHROME)).toBe('Asha is sharing their screen. One person at a time.');
    expect(shareErrorText(err('AbortError', 'Screen sharing could not start.'), IPHONE)).toBe('Screen sharing couldn’t start. Please try again.');
    expect(shareErrorText(undefined, MAC_CHROME)).toBe('Screen sharing couldn’t start. Please try again.');
  });

  it('browser names', () => {
    expect(browserName(MAC_CHROME)).toBe('Google Chrome');
    expect(browserName(WIN_EDGE)).toBe('Microsoft Edge');
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox');
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari');
  });
});
