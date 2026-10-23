import { describe, expect, it, vi } from 'vitest';
import { endable, installPhoneScreenShare, isSound, Ring, shareOptions, toFloat } from '../../src/native/androidScreen';

describe('Android screen sharing: constraints', () => {
  it('defaults: 10 frames a second, at most 1280 px each way, no sound', () => {
    expect(shareOptions()).toEqual({ fps: 10, maxWidth: 1280, maxHeight: 1280, audio: false });
    expect(shareOptions({ video: true, audio: false })).toEqual({ fps: 10, maxWidth: 1280, maxHeight: 1280, audio: false });
    expect(shareOptions({ video: true, audio: true }).audio).toBe(true);
    expect(shareOptions({ audio: {} }).audio).toBe(true);
  });

  it('reads numbers, max, exact and ideal', () => {
    expect(shareOptions({ video: { frameRate: 15, width: 960, height: 720 } })).toEqual({ fps: 15, maxWidth: 960, maxHeight: 720, audio: false });
    expect(shareOptions({ video: { frameRate: { max: 5 }, width: { ideal: 640 }, height: { exact: 480 } } })).toEqual({ fps: 5, maxWidth: 640, maxHeight: 480, audio: false });
  });

  it('keeps values within what a phone can do', () => {
    expect(shareOptions({ video: { frameRate: 120, width: 4000, height: 10 } })).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 160, audio: false });
    expect(shareOptions({ video: { frameRate: 0 } }).fps).toBe(1);
    expect(shareOptions({ video: { frameRate: 7.6 } }).fps).toBe(8);
  });

  it('video: false is refused, like browsers', () => {
    expect(() => shareOptions({ video: false })).toThrow(TypeError);
  });
});

/** A stand-in for a MediaStreamTrack: stop() never fires 'ended' (like real tracks). */
function fakeTrack() {
  const t = new EventTarget() as EventTarget & { stop: () => void; readyState: string };
  t.readyState = 'live';
  t.stop = () => void (t.readyState = 'ended');
  return t;
}

describe('Android screen sharing: ending the track', () => {
  it('the phone stopped it (notification): the track stops and fires ended once', () => {
    const t = fakeTrack();
    const appStop = vi.fn();
    const end = endable(t as unknown as MediaStreamTrack, appStop);
    const ended = vi.fn();
    t.addEventListener('ended', ended);
    end();
    end();
    expect(t.readyState).toBe('ended');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(appStop).not.toHaveBeenCalled();
    // The app then stops the track on 'ended' (peer.ts does): no second stop on the phone.
    t.stop();
    expect(appStop).not.toHaveBeenCalled();
  });

  it('the app stopped it: the phone stops once, no ended event', () => {
    const t = fakeTrack();
    const appStop = vi.fn();
    const end = endable(t as unknown as MediaStreamTrack, appStop);
    const ended = vi.fn();
    t.addEventListener('ended', ended);
    t.stop();
    t.stop();
    end(); // a late "stopped" from the phone
    expect(t.readyState).toBe('ended');
    expect(appStop).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('Phone screen sharing: install', () => {
  it('does nothing in browsers, other platforms, or without the plugin', () => {
    const md: { getDisplayMedia?: unknown } = {};
    vi.stubGlobal('navigator', { mediaDevices: md });
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'web', isPluginAvailable: () => true } });
    installPhoneScreenShare();
    expect(md.getDisplayMedia).toBeUndefined();
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios', isPluginAvailable: () => false } });
    installPhoneScreenShare();
    expect(md.getDisplayMedia).toBeUndefined();
    vi.stubGlobal('window', {});
    installPhoneScreenShare();
    expect(md.getDisplayMedia).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('in the Android app with the plugin: adds getDisplayMedia, keeps a real one', () => {
    const stop = vi.fn(async () => undefined);
    const plugin = { stop };
    const md: { getDisplayMedia?: unknown } = {};
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'android', isPluginAvailable: (n: string) => n === 'ScreenCapture', Plugins: { ScreenCapture: plugin } } });
    vi.stubGlobal('navigator', { mediaDevices: md });
    installPhoneScreenShare();
    expect(typeof md.getDisplayMedia).toBe('function');
    expect(stop).toHaveBeenCalledTimes(1); // a share left from before a reload is ended

    const real = () => undefined;
    const md2 = { getDisplayMedia: real };
    vi.stubGlobal('navigator', { mediaDevices: md2 });
    installPhoneScreenShare();
    expect(md2.getDisplayMedia).toBe(real);
    vi.unstubAllGlobals();
  });

  it('in the iPhone app with the plugin: adds getDisplayMedia, and replaces WebKit\'s own', () => {
    const stop = vi.fn(async () => undefined);
    const plugin = { stop };
    const webkits = () => undefined;
    const md: { getDisplayMedia?: unknown } = { getDisplayMedia: webkits };
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios', isPluginAvailable: (n: string) => n === 'ScreenCapture', Plugins: { ScreenCapture: plugin } } });
    vi.stubGlobal('navigator', { mediaDevices: md });
    installPhoneScreenShare();
    expect(typeof md.getDisplayMedia).toBe('function');
    expect(md.getDisplayMedia).not.toBe(webkits);
    expect(stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('in the iPhone app: keeps trying until WebKit has made MediaDevices', () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => undefined);
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios', isPluginAvailable: (n: string) => n === 'ScreenCapture', Plugins: { ScreenCapture: { stop } } } });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('MediaDevices', undefined);
    installPhoneScreenShare(500, 10);
    vi.advanceTimersByTime(1600);
    expect(stop).not.toHaveBeenCalled();
    const md: { getDisplayMedia?: unknown } = {};
    vi.stubGlobal('navigator', { mediaDevices: md }); // now it exists
    vi.advanceTimersByTime(600);
    expect(typeof md.getDisplayMedia).toBe('function');
    expect(stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(stop).toHaveBeenCalledTimes(1); // installed once, then stops trying
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('in the iPhone app: replaces it on MediaDevices itself, even before navigator.mediaDevices exists', () => {
    const stop = vi.fn(async () => undefined);
    const webkits = () => undefined;
    class FakeMediaDevices {}
    (FakeMediaDevices.prototype as unknown as { getDisplayMedia: unknown }).getDisplayMedia = webkits;
    vi.stubGlobal('MediaDevices', FakeMediaDevices);
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios', isPluginAvailable: (n: string) => n === 'ScreenCapture', Plugins: { ScreenCapture: { stop } } } });
    vi.stubGlobal('navigator', {}); // WebKit hasn't made navigator.mediaDevices yet
    installPhoneScreenShare();
    const later = new FakeMediaDevices() as { getDisplayMedia?: unknown };
    expect(typeof later.getDisplayMedia).toBe('function');
    expect(later.getDisplayMedia).not.toBe(webkits);
    expect(stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('Android screen sharing: sound', () => {
  const chunk = (frames: number, ch: number, v: (i: number) => number) => Float32Array.from({ length: frames * ch }, (_, i) => v(i));
  const block = (ch: number, n = 128) => Array.from({ length: ch }, () => new Float32Array(n).fill(9));

  it('waits for 60 ms, then plays the samples in order, channel by channel', () => {
    const r = new Ring(2);
    r.push(chunk(960, 2, (i) => i)); // 20 ms
    const out = block(2);
    r.pull(out);
    expect([...out[0].slice(0, 3), ...out[1].slice(0, 3)]).toEqual([0, 0, 0, 0, 0, 0]); // still waiting
    r.push(chunk(960, 2, (i) => 1920 + i));
    r.push(chunk(960, 2, (i) => 3840 + i)); // 60 ms now
    r.pull(out);
    expect(Array.from(out[0].slice(0, 3))).toEqual([0, 2, 4]); // left
    expect(Array.from(out[1].slice(0, 3))).toEqual([1, 3, 5]); // right
    r.pull(out);
    expect(out[0][0]).toBe(256); // the next block goes on where the last stopped
    expect(r.frames).toBe(2880 - 256);
  });

  it('runs dry: silence, then waits for 60 ms again', () => {
    const r = new Ring(1);
    r.push(chunk(2880, 1, () => 0.5));
    const out = block(1);
    for (let i = 0; i < 22; i++) r.pull(out); // 2816 samples
    r.pull(out); // 64 left, then dry
    expect(out[0][63]).toBe(0.5);
    expect(out[0][64]).toBe(0);
    expect(r.waiting).toBe(true);
    r.push(chunk(960, 1, () => 0.25));
    r.pull(out);
    expect(out[0][0]).toBe(0); // waiting for 60 ms again
  });

  it('keeps at most 300 ms (drops the oldest), so the delay stays small', () => {
    const r = new Ring(2);
    for (let i = 0; i < 30; i++) r.push(chunk(960, 2, () => i)); // 600 ms
    expect(r.frames).toBeLessThanOrEqual(14400);
    const out = block(2);
    r.pull(out);
    expect(out[0][0]).toBe(15); // the first 15 chunks were dropped
  });

  it('mono plays on every output channel', () => {
    const r = new Ring(1);
    r.push(chunk(2880, 1, (i) => i / 10000));
    const out = block(2);
    r.pull(out);
    expect(out[0][5]).toBe(out[1][5]);
  });

  it('PCM: 16-bit to -1…1, and sound messages are told apart from pictures', () => {
    expect(Array.from(toFloat(Int16Array.from([0, 16384, -32768])))).toEqual([0, 0.5, -1]);
    const pcm = new Uint8Array([0x50, 0x43, 0x4d, 2, 0, 0]).buffer;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
    expect(isSound(pcm)).toBe(true);
    expect(isSound(jpeg)).toBe(false);
    expect(isSound(new ArrayBuffer(2))).toBe(false);
  });

  it('the worklet copy of the ring is self-contained', () => {
    // The AudioWorklet gets Ring's source text; it must run without anything around it.
    const Copy = new Function(`return (${Ring.toString()});`)() as typeof Ring;
    const r = new Copy(1);
    r.push(chunk(2880, 1, () => 0.75));
    const out = block(1);
    r.pull(out);
    expect(out[0][0]).toBe(0.75);
  });
});
