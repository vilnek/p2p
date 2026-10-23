// The call's "Devices" sheet (1:1 and group calls): Camera, Microphone and, where the browser can
// send sound to another output, Speaker. Picking one switches it live (replaceTrack, the call stays
// up) and is remembered for the next calls on this device (core/mediaDevices.ts).

import { canPickSpeaker, listDevices, loadChoice, remember, type DeviceOption } from '../core/mediaDevices';
import { h, sheet } from './dom';
import { icon } from './icons';

export interface DevicesHost {
  /** Is my camera part of this call (video call, camera opened)? */
  video(): boolean;
  /** The devices my live tracks use now. */
  current(): { cam?: string; mic?: string };
  camera(id: string): Promise<void>;
  mic(id: string): Promise<void>;
  /** The speaker choice changed (saved already): send the call's sound there now. */
  speaker(id: string): void;
}

export async function devicesSheet(host: DevicesHost): Promise<void> {
  document.querySelector('[data-testid=devices-sheet]')?.closest('.dim')?.remove();
  const body = h('div', { class: 'dev-body' }, h('p', { class: 'muted small' }, 'Looking for devices…'));
  const error = h('p', { class: 'error small hidden', 'data-testid': 'devices-error', role: 'alert' });
  const s = sheet('devices-sheet', h('h2', {}, 'Devices'), body, error, h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Done'));
  const draw = async () => {
    const d = await listDevices();
    const now = host.current();
    const out = loadChoice().out ?? 'default';
    const section = (title: string, kind: 'camera' | 'mic' | 'speaker', list: DeviceOption[], on: string | undefined, pick: (id: string) => Promise<void>) => {
      if (!list.length) return null;
      // Nothing matched (e.g. the system default is used): the first one is the one in use.
      const sel = list.some((x) => x.id === on) ? on : list[0].id;
      return [
        h('div', { class: 'sec' }, title),
        h('div', { class: 'card', role: 'radiogroup', 'aria-label': title },
          ...list.map((x) => h('button', { class: 'kv tap dev', type: 'button', role: 'radio', 'aria-checked': String(x.id === sel), 'data-testid': `device-${kind}`, 'data-id': x.id, 'data-on': x.id === sel ? '1' : undefined, onclick: async (e: Event) => {
            if (x.id === sel) return;
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            error.classList.add('hidden');
            try {
              await pick(x.id);
              remember(kind === 'camera' ? 'cam' : kind === 'mic' ? 'mic' : 'out', x.id);
              if (kind === 'speaker') host.speaker(x.id);
            } catch (err) {
              const msg = String((err as Error)?.message ?? '');
              error.textContent = msg.startsWith('Stop sharing') ? msg : `Couldn’t use ${x.label}. It may be in use by another app.`;
              error.classList.remove('hidden');
            }
            await draw();
          } },
          h('div', { class: 'k one-line' }, x.label),
          x.id === sel ? icon('check', 20, 'ok') : null))),
      ];
    };
    const parts = [
      ...(host.video() ? section('CAMERA', 'camera', d.cameras, now.cam, host.camera) ?? [] : []),
      ...(section('MICROPHONE', 'mic', d.mics, now.mic, host.mic) ?? []),
      // Speaker: only where the browser can choose (not on iPhone, where the phone decides).
      ...(canPickSpeaker() ? section('SPEAKER', 'speaker', d.speakers, out, async () => undefined) ?? [] : []),
    ];
    if (!s.isConnected) return;
    body.replaceChildren(...(parts.length ? parts : [h('p', { class: 'muted small' }, 'No other devices found.')]));
  };
  await draw();
}
