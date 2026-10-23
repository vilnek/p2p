// Camera, microphone and speaker choice for calls (1:1 and group): the lists shown in the call's
// "Devices" sheet, the person's last choice (kept on this device only), and the constraints that
// open the chosen camera / microphone. Switching during a call is a replaceTrack (no renegotiation).

export interface DeviceOption {
  id: string;
  label: string;
}

export interface DeviceLists {
  cameras: DeviceOption[];
  mics: DeviceOption[];
  speakers: DeviceOption[];
}

/** What the person picked last (device ids from enumerateDevices). Missing: the system default. */
export interface DeviceChoice {
  cam?: string;
  mic?: string;
  out?: string;
}

type DeviceLike = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label' | 'groupId'>;

const KEY = 'p2p-call-devices';

/** A label without the USB id Chrome adds at the end ("FaceTime HD Camera (05ac:8514)"). */
export function cleanLabel(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
}

/**
 * Cameras, microphones and speakers from enumerateDevices(). Chrome lists the system default (and on
 * Windows the "communications" device) a second time under a pseudo id: those copies are left out
 * when the real device is also listed. Devices with no id (no permission yet) are left out. Missing
 * labels become "Camera 1", "Microphone 2"…
 */
export function groupDevices(list: readonly DeviceLike[]): DeviceLists {
  const out: DeviceLists = { cameras: [], mics: [], speakers: [] };
  const names = { videoinput: 'Camera', audioinput: 'Microphone', audiooutput: 'Speaker' } as const;
  const into = { videoinput: out.cameras, audioinput: out.mics, audiooutput: out.speakers } as const;
  for (const d of list) {
    const kind = d.kind as keyof typeof into;
    const bucket = into[kind];
    if (!bucket || !d.deviceId) continue;
    if (d.deviceId === 'communications') continue;
    if (d.deviceId === 'default' && list.some((x) => x !== d && x.kind === d.kind && x.deviceId !== 'default' && x.deviceId !== 'communications' && !!x.groupId && x.groupId === d.groupId)) continue;
    if (bucket.some((x) => x.id === d.deviceId)) continue;
    const label = cleanLabel(d.label.replace(/^Default\s*-\s*/i, '')) || `${names[kind]} ${bucket.length + 1}`;
    bucket.push({ id: d.deviceId, label });
  }
  return out;
}

/** The devices this browser can see now (labels need camera / microphone permission, given in a call). */
export async function listDevices(): Promise<DeviceLists> {
  try {
    return groupDevices(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return { cameras: [], mics: [], speakers: [] };
  }
}

export function loadChoice(): DeviceChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as DeviceChoice;
    const ok = (s: unknown) => (typeof s === 'string' && s.length > 0 && s.length < 300 ? s : undefined);
    return { cam: ok(v?.cam), mic: ok(v?.mic), out: ok(v?.out) };
  } catch {
    return {};
  }
}

export function saveChoice(c: DeviceChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private window: the choice lasts for this call only */
  }
}

export function remember(kind: keyof DeviceChoice, id: string | undefined): void {
  saveChoice({ ...loadChoice(), [kind]: id });
}

/** Microphone constraints: the chosen one (exactly; openChosen() falls back if it is gone). */
export function audioConstraints(base: MediaTrackConstraints | true = true, choice = loadChoice()): MediaTrackConstraints | true {
  if (!choice.mic) return base;
  return { ...(base === true ? {} : base), deviceId: { exact: choice.mic } };
}

/** Camera constraints: the chosen camera if there is one, else the front camera. */
export function videoConstraints(base: MediaTrackConstraints = {}, choice = loadChoice()): MediaTrackConstraints {
  if (!choice.cam) return { facingMode: 'user', ...base };
  return { ...base, deviceId: { exact: choice.cam } };
}

/**
 * Opens the camera / microphone for a call: the ones picked last time (Chrome ignores an "ideal"
 * device), and if one of them is gone (unplugged, another phone), the defaults instead. A refused
 * permission is not retried.
 */
export async function openChosen(
  gum: (c: MediaStreamConstraints) => Promise<MediaStream>,
  audio: MediaTrackConstraints | true | false,
  video: MediaTrackConstraints | false,
  choice = loadChoice(),
): Promise<MediaStream> {
  const a = audio === false ? false : audioConstraints(audio, choice);
  const v = video === false ? false : videoConstraints(video, choice);
  try {
    return await gum({ audio: a, video: v });
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    const gone = name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError';
    if (!gone || (!choice.cam && !choice.mic)) throw e;
    return gum({ audio: audio === false ? false : audioConstraints(audio, {}), video: video === false ? false : videoConstraints(video, {}) });
  }
}

/** Exactly this device (switching during a call: a wrong one must not be taken quietly). */
export const exactly = (id: string, base: MediaTrackConstraints = {}): MediaTrackConstraints => ({ ...base, deviceId: { exact: id } });

/** Speaker choice works only where the browser can send sound to another output (not on iPhone). */
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}

/** Sends this element's sound to the chosen speaker (no-op where that isn't possible). */
export async function applySpeaker(el: HTMLMediaElement, id = loadChoice().out): Promise<void> {
  const m = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
  if (!id || typeof m.setSinkId !== 'function' || m.sinkId === id) return;
  await m.setSinkId(id).catch(() => undefined);
}

/** The camera after this one in the list (Flip on a computer with two or more cameras). */
export function nextCamera(cameras: readonly DeviceOption[], current: string | undefined): DeviceOption | null {
  if (cameras.length < 2) return null;
  const i = cameras.findIndex((c) => c.id === current);
  return cameras[(i + 1) % cameras.length];
}

/** The id of the device a live track is using (for the tick in the sheet). */
export function trackDevice(t: MediaStreamTrack | null | undefined): string | undefined {
  try {
    return t?.getSettings?.().deviceId || undefined;
  } catch {
    return undefined;
  }
}
