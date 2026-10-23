// Call › Devices: the camera / microphone / speaker lists, the remembered choice, Flip on computers.
import { afterEach, describe, expect, it } from 'vitest';
import { audioConstraints, canPickSpeaker, cleanLabel, exactly, groupDevices, loadChoice, nextCamera, openChosen, remember, saveChoice, videoConstraints } from '../../src/core/mediaDevices';

const d = (kind: MediaDeviceKind, deviceId: string, label = '', groupId = '') => ({ kind, deviceId, label, groupId });

describe('device lists', () => {
  it('groups cameras, microphones and speakers; drops Chrome’s "default" and "communications" copies', () => {
    const l = groupDevices([
      d('audioinput', 'default', 'Default - MacBook Pro Microphone (Built-in)', 'g1'),
      d('audioinput', 'communications', 'Communications - MacBook Pro Microphone (Built-in)', 'g1'),
      d('audioinput', 'mic1', 'MacBook Pro Microphone (Built-in)', 'g1'),
      d('audioinput', 'mic2', 'AirPods Pro', 'g2'),
      d('videoinput', 'cam1', 'FaceTime HD Camera (05ac:8514)', 'g3'),
      d('videoinput', 'cam2', 'Logitech C920 (046d:082d)', 'g4'),
      d('audiooutput', 'default', 'Default - AirPods Pro', 'g2'),
      d('audiooutput', 'spk1', 'MacBook Pro Speakers', 'g5'),
      d('audiooutput', 'spk2', 'AirPods Pro', 'g2'),
    ]);
    expect(l.mics).toEqual([{ id: 'mic1', label: 'MacBook Pro Microphone (Built-in)' }, { id: 'mic2', label: 'AirPods Pro' }]);
    expect(l.cameras).toEqual([{ id: 'cam1', label: 'FaceTime HD Camera' }, { id: 'cam2', label: 'Logitech C920' }]);
    expect(l.speakers.map((x) => x.id)).toEqual(['spk1', 'spk2']);
  });

  it('keeps "default" when it is the only entry (e.g. iPhone), names unlabeled devices, skips devices with no id', () => {
    const l = groupDevices([d('audioinput', 'default', ''), d('videoinput', 'a', ''), d('videoinput', 'b', ''), d('videoinput', '', 'no permission'), d('audioinput', 'a', 'dupe id')]);
    expect(l.mics).toEqual([{ id: 'default', label: 'Microphone 1' }, { id: 'a', label: 'dupe id' }]);
    expect(l.cameras).toEqual([{ id: 'a', label: 'Camera 1' }, { id: 'b', label: 'Camera 2' }]);
  });

  it('cleans labels', () => {
    expect(cleanLabel('HD Pro Webcam C920 (046d:082d)')).toBe('HD Pro Webcam C920');
    expect(cleanLabel('Front Camera')).toBe('Front Camera');
  });

  it('Flip on a computer: the next camera, round; none with one camera', () => {
    const cams = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
    expect(nextCamera(cams, 'a')?.id).toBe('b');
    expect(nextCamera(cams, 'c')?.id).toBe('a');
    expect(nextCamera(cams, undefined)?.id).toBe('a');
    expect(nextCamera([cams[0]], 'a')).toBeNull();
  });
});

describe('the remembered choice', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  afterEach(() => mem.clear());

  it('is kept and read back; bad values are ignored', () => {
    expect(loadChoice()).toEqual({});
    remember('cam', 'cam2');
    remember('mic', 'mic2');
    expect(loadChoice()).toEqual({ cam: 'cam2', mic: 'mic2', out: undefined });
    saveChoice({ cam: 5 as unknown as string });
    expect(loadChoice().cam).toBeUndefined();
    mem.set('p2p-call-devices', '{not json');
    expect(loadChoice()).toEqual({});
  });

  it('opens the chosen devices; the front camera otherwise', () => {
    expect(videoConstraints({ width: { ideal: 640 } }, {})).toEqual({ facingMode: 'user', width: { ideal: 640 } });
    expect(videoConstraints({ width: { ideal: 640 } }, { cam: 'c1' })).toEqual({ width: { ideal: 640 }, deviceId: { exact: 'c1' } });
    expect(audioConstraints(true, {})).toBe(true);
    expect(audioConstraints(true, { mic: 'm1' })).toEqual({ deviceId: { exact: 'm1' } });
    expect(audioConstraints({ echoCancellation: true }, { mic: 'm1' })).toEqual({ echoCancellation: true, deviceId: { exact: 'm1' } });
    expect(exactly('m2', { noiseSuppression: true })).toEqual({ noiseSuppression: true, deviceId: { exact: 'm2' } });
  });

  it('a chosen device that is gone falls back to the defaults; a refused permission is not retried', async () => {
    const asked: MediaStreamConstraints[] = [];
    const err = (name: string) => Object.assign(new Error(name), { name });
    const stream = {} as MediaStream;
    const gone = async (c: MediaStreamConstraints) => {
      asked.push(c);
      if (JSON.stringify(c).includes('exact')) throw err('OverconstrainedError');
      return stream;
    };
    expect(await openChosen(gone, true, {}, { cam: 'old-cam', mic: 'old-mic' })).toBe(stream);
    expect(asked).toEqual([
      { audio: { deviceId: { exact: 'old-mic' } }, video: { deviceId: { exact: 'old-cam' } } },
      { audio: true, video: { facingMode: 'user' } },
    ]);
    const refused = async () => {
      throw err('NotAllowedError');
    };
    await expect(openChosen(refused, true, false, { mic: 'm' })).rejects.toThrow('NotAllowedError');
    asked.length = 0;
    await openChosen(gone, { echoCancellation: true }, false, {});
    expect(asked).toEqual([{ audio: { echoCancellation: true }, video: false }]);
  });

  it('no speaker choice where the browser can’t (no setSinkId, e.g. iPhone)', () => {
    expect(canPickSpeaker()).toBe(false);
  });
});
