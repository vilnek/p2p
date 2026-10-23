// The call screen (design P2, screens 5, 6, 7 and 10). One fixed layout per call; parts are updated
// in place, so nothing jumps when the state changes.
//   Phone:  video fills the screen, my picture small in a corner, name + state on top, "i" for
//           details, one bar of round buttons at the bottom (fades after 4 s while connected).
//           Voice / ringing / incoming: a big avatar with rings, the name, the state, the buttons.
//   Wide:   the other video (or their shared screen) as a big stage, my tile on the right, small
//           status pills on top, one floating control bar.

import { emojiCode } from '../core/identity';
import { PATH_TEXT, type PathInfo } from '../core/path';
import type { CallRecord } from '../core/store';
import type { CallInfo, Peer } from '../net/peer';
import { avatar, duration, h, sheet, type Child } from './dom';
import { icon, PATH_ICON, type IconName } from './icons';
import { NO_SCREEN_HERE, shareErrorText } from './shareError';
import { applySpeaker, listDevices, nextCamera, trackDevice } from '../core/mediaDevices';
import { devicesSheet } from './devicesSheet';

export interface CallHost {
  myKey: Uint8Array;
  nameOf(p: Peer): string;
  pathOf(p: Peer): PathInfo;
  /** "Send a message" after a failed call, or the chat button on wide screens. */
  showChat(p: Peer): void;
  /** A call ended (for the Calls list). */
  logged(rec: CallRecord): void;
  /** A quiet one-line note (toast). */
  note?(text: string): void;
  /** A contact I have not talked with yet ("New contact" under the name on an incoming call). */
  isNew?(p: Peer): boolean;
  /**
   * The call is over and its screen closed by itself (no OK to press): back to their chat, with one
   * line saying how it ended (`again`: offer "Call again" there).
   */
  ended?(p: Peer, text: string, again: { video: boolean } | null): void;
  /**
   * Host mode (?embed=1&ui=1): Share screen shows even where the page can't capture the screen (it then
   * says so), and my own recording (by the host app) shows as "● Recording".
   */
  hosted?: boolean;
}

/** How long the end of a call stays on screen before it closes by itself (a reason to read stays longer). */
export const CALL_END_MS = 1500;
export const CALL_FAIL_MS = 3000;

const LIVE = ['reaching', 'ringing', 'connecting', 'connected', 'reconnecting'];
const isPhone = () => /Android|iPhone|iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

interface View {
  peer: Peer;
  host: CallHost;
  root: HTMLElement;
  status: HTMLElement;
  rec: HTMLElement;
  pillTime: HTMLElement;
  pillShare: HTMLElement;
  bottom: HTMLElement;
  big: HTMLVideoElement;
  pip: HTMLVideoElement;
  back: HTMLElement;
  mode: '' | 'incoming' | 'live' | 'over';
  video: boolean;
  swapped: boolean;
  micOn: boolean;
  camOn: boolean;
  facing: 'user' | 'environment';
  tick: ReturnType<typeof setInterval> | null;
  fade: ReturnType<typeof setTimeout> | null;
  closing: ReturnType<typeof setTimeout> | null;
  logged: boolean;
  noSoundSaid: boolean;
}

let v: View | null = null;

export const callPeer = () => v?.peer ?? null;

export function closeCallView(): void {
  if (!v) return;
  if (v.tick) clearInterval(v.tick);
  if (v.fade) clearTimeout(v.fade);
  if (v.closing) clearTimeout(v.closing);
  v.root.remove();
  v.back.remove();
  v = null;
  document.querySelector('[data-testid=call-info-sheet]')?.closest('.dim')?.remove();
}

/** Streams changed: put them on the right video elements. */
export function refreshCallVideos(p: Peer): void {
  if (!v || v.peer !== p) return;
  const live = LIVE.includes(p.call.state);
  const remote = live ? p.remoteStream : null;
  const local = live && v.video ? p.localStream : null;
  const [big, small] = v.swapped ? [local, remote] : [remote, local];
  for (const [el, s] of [[v.big, big], [v.pip, small]] as const) {
    if (el.srcObject !== s) el.srcObject = s;
    // No stream yet: not drawn at all (an empty <video> shows "Unable to play media" in Android's web view).
    el.classList.toggle('nostream', !s);
    if (s) void el.play().catch(() => undefined);
  }
  v.big.muted = v.swapped; // my own sound never plays back
  v.pip.muted = !v.swapped;
  void applySpeaker(v.swapped ? v.pip : v.big); // the speaker picked in Devices (where the browser allows)
}

function roundBtn(name: IconName, label: string, testid: string, onclick: (e: Event) => void, cls = ''): HTMLElement {
  return h('button', { class: `cb ${cls}`.trim(), 'aria-label': label, title: label, 'data-testid': testid, type: 'button', onclick }, icon(name, 24));
}

function build(p: Peer, c: CallInfo, host: CallHost): View {
  const who = host.nameOf(p);
  const big = h('video', { class: 'remote nostream', autoplay: true, playsinline: true, 'data-testid': 'remote-video' }) as HTMLVideoElement;
  const pip = h('video', { class: 'pip nostream', autoplay: true, playsinline: true, muted: true, 'data-testid': 'local-video', 'aria-label': 'Swap pictures', role: 'button', tabindex: '0' }) as HTMLVideoElement;
  pip.muted = true;
  const status = h('div', { class: 's one-line', 'data-testid': 'call-status' });
  const rec = h('div', { class: 'rec one-line hidden', 'data-testid': 'call-rec' });
  const pillTime = h('span', { class: 'pill' }, h('span', { class: 'dot on' }), h('span', {}, 'In call'));
  const soundBtn = h('button', { class: 'pill-btn hidden', 'data-testid': 'screen-sound', type: 'button', 'aria-label': 'Device sound on', onclick: () => p.setScreenSound(!p.screenSound.on) });
  const pillShare = h('span', { class: 'pill share-pill hidden', 'data-testid': 'sharing-pill' }, icon('screen-share', 15), h('span', {}, 'You are sharing your screen'), soundBtn);
  const bottom = h('div', { class: 'cbottom' });
  const root = h(
    'div',
    { class: 'call', 'data-testid': 'call-screen', role: 'dialog', 'aria-label': `Call with ${who}` },
    big,
    h('div', { class: 'vshade' }),
    h('div', { class: 'chero' }, h('div', { class: 'ring-av' }, avatar(who, p.peer!.id, 120)), h('div', { class: 'n one-line' }, who), status, rec),
    h('div', { class: 'pills' }, pillTime, h('span', { class: 'pill' }, icon('lock', 15), 'Locked · direct')),
    pillShare,
    h('button', { class: 'cinfo', 'aria-label': 'Check who you are talking to', title: 'Check who you are talking to', 'data-testid': 'call-info', type: 'button', onclick: () => infoSheet(p, host) }, icon('info', 18)),
    h('div', { class: 'tiles' }, h('div', { class: 'tile' }, pip, h('span', {}, 'You'))),
    bottom,
  );
  const back = h('button', { class: 'back-to-call hidden', 'data-testid': 'back-to-call', type: 'button', onclick: () => {
    root.classList.remove('away');
    back.classList.add('hidden');
  } }, icon('phone', 16), h('span', {}, 'Back to call'));
  let layer = document.getElementById('call-layer');
  if (!layer) document.body.append((layer = h('div', { id: 'call-layer' })));
  layer.replaceChildren(root, back);
  const view: View = { peer: p, host, root, status, rec, pillTime, pillShare, bottom, big, pip, back, mode: '', video: c.video, swapped: false, micOn: true, camOn: true, facing: 'user', tick: null, fade: null, closing: null, logged: false, noSoundSaid: false };
  const swap = () => {
    view.swapped = !view.swapped;
    refreshCallVideos(p);
  };
  pip.addEventListener('click', swap);
  pip.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), swap())); // it is a button for the keyboard too
  root.addEventListener('pointerdown', () => armFade());
  return view;
}

function armFade(): void {
  if (!v) return;
  const view = v;
  view.root.classList.remove('calm');
  if (view.fade) clearTimeout(view.fade);
  view.fade = null;
  if (view.peer.call.state === 'connected') view.fade = setTimeout(() => view.root.classList.add('calm'), 4000);
}

function liveControls(p: Peer, view: View): HTMLElement {
  const bar = h('div', { class: 'ctrl' });
  const mic = roundBtn('mic', 'Mute', 'mute', () => {
    view.micOn = !view.micOn;
    p.setMicOn(view.micOn);
    mic.replaceChildren(icon(view.micOn ? 'mic' : 'mic-off', 24));
    mic.setAttribute('aria-label', view.micOn ? 'Mute' : 'Unmute');
    mic.setAttribute('aria-pressed', String(!view.micOn));
    mic.classList.toggle('off', !view.micOn);
  });
  mic.setAttribute('aria-pressed', 'false');
  bar.append(mic);
  if (view.video) {
    const cam = roundBtn('video', 'Turn camera off', 'camera', () => {
      view.camOn = !view.camOn;
      p.setCameraOn(view.camOn);
      cam.replaceChildren(icon(view.camOn ? 'video' : 'video-off', 24));
      cam.setAttribute('aria-label', view.camOn ? 'Turn camera off' : 'Turn camera on');
      cam.setAttribute('aria-pressed', String(!view.camOn));
      cam.classList.toggle('off', !view.camOn);
    });
    cam.setAttribute('aria-pressed', 'false');
    bar.append(cam);
    if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
      // Phone browsers have no screen sharing; the native apps add it later.
      bar.append(roundBtn('screen-share', 'Share screen', 'screen-share', () => void (p.sharingScreen ? p.stopScreenShare() : p.startScreenShare().catch(shareFailed))));
    } else if (view.host.hosted) {
      // Host mode: the button stays and says plainly why it can't share here.
      bar.append(roundBtn('screen-share', 'Share screen', 'screen-share', () => shareFailed(new Error(NO_SCREEN_HERE))));
    }
    // Flip: front / back on a phone; the next camera on a computer with two or more.
    const flip = roundBtn('switch-camera', 'Flip camera', 'switch-camera', () => void switchCamera(p, view), isPhone() ? '' : 'hidden');
    bar.append(flip);
    if (!isPhone()) void listDevices().then((d) => d.cameras.length > 1 && flip.classList.remove('hidden'));
  }
  // Devices: choose the camera, microphone and (where the browser allows) the speaker.
  bar.append(roundBtn('settings', 'Devices', 'call-devices', () => devicesSheet({
    video: () => view.video && !!p.localStream?.getVideoTracks().length,
    current: () => ({ cam: trackDevice(p.localStream?.getVideoTracks()[0]), mic: trackDevice(p.localStream?.getAudioTracks()[0]) }),
    camera: async (id) => {
      await p.switchCamera({ id });
      refreshCallVideos(p);
    },
    mic: (id) => p.switchMic(id).then(() => undefined),
    speaker: () => refreshCallVideos(p),
  })));
  // Wide screens: go to the chat while the call goes on.
  bar.append(roundBtn('chat', 'Chat', 'call-chat', () => {
    view.root.classList.add('away');
    view.back.classList.remove('hidden');
    view.host.showChat(p);
  }, 'wide-only'));
  bar.append(roundBtn('hang-up', 'Hang up', 'hang-up', () => void p.hangUp(), 'red'));
  return bar;
}

/** Share screen didn't start: say why (never silently), unless the person closed the picker. */
function shareFailed(e: unknown): void {
  const text = shareErrorText(e);
  if (!text) return;
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', 'data-testid': 'share-error' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 9000);
}

/** Flip: the other camera (phones: front / back; computers: the next one). The call stays up. */
async function switchCamera(p: Peer, view: View): Promise<void> {
  if (!p.localStream) return;
  try {
    if (isPhone()) {
      const facing = view.facing === 'user' ? 'environment' : 'user';
      await p.switchCamera({ facing });
      view.facing = facing;
    } else {
      const next = nextCamera((await listDevices()).cameras, trackDevice(p.localStream.getVideoTracks()[0]));
      if (!next) return;
      await p.switchCamera({ id: next.id });
    }
    p.localStream?.getVideoTracks().forEach((t) => (t.enabled = view.camOn));
    view.pip.srcObject = null;
    refreshCallVideos(p);
  } catch {
    view.host.note?.('Couldn’t switch the camera.');
  }
}

/** One line about how a call ended, for the chat ("Video call · 4 min", "Missed voice call", "Ravi declined"). */
export function endText(who: string, c: Pick<CallInfo, 'state' | 'video' | 'outgoing' | 'failure' | 'connectedAt'>, now = Date.now()): string {
  const kind = c.video ? 'video call' : 'voice call';
  const Kind = c.video ? 'Video call' : 'Voice call';
  if (c.state === 'missed') return `Missed ${kind}`;
  if (c.state === 'failed') return `${Kind} · ${failureText(who, c.failure)}`;
  if (c.connectedAt) return `${Kind} · ${Math.max(1, Math.round((now - c.connectedAt) / 60000))} min`;
  return c.outgoing ? `${Kind} · no answer` : `${Kind} · declined`;
}

function failureText(who: string, failure?: string): string {
  const reasons: Record<string, string> = {
    offline: `${who} is offline`,
    'no-answer': `${who} didn’t answer`,
    declined: `${who} declined`,
    busy: `${who} is on another call`,
    media: 'Can’t connect directly right now',
    'my-media': "Your camera or microphone isn't available",
    'their-media': `${who}'s camera or microphone isn't available`,
  };
  return reasons[failure ?? 'media'];
}

export function renderCall(p: Peer, c: CallInfo, host: CallHost): void {
  if (!p.peer) return;
  if (c.state === 'idle') {
    if (v?.peer === p) closeCallView();
    return;
  }
  if (v && v.peer !== p) {
    if (LIVE.includes(v.peer.call.state) || v.peer.call.state === 'incoming') return; // one call at a time
    closeCallView();
  }
  if (v && !v.root.isConnected) closeCallView();
  v ??= build(p, c, host);
  const view = v;
  const who = host.nameOf(p);
  view.video = c.video;
  const mode = c.state === 'incoming' ? 'incoming' : LIVE.includes(c.state) ? 'live' : 'over';
  const calm = view.root.classList.contains('calm') && c.state === 'connected';
  const away = view.root.classList.contains('away') && mode === 'live';
  view.root.className = `call ${c.video ? 'video' : 'voice'} ${c.state} m-${mode}${calm ? ' calm' : ''}${away ? ' away' : ''}`;
  if (!away) view.back.classList.add('hidden');
  view.root.dataset.state = c.state;
  if (view.tick) clearInterval(view.tick);
  view.tick = null;

  switch (c.state) {
    case 'incoming':
      view.status.replaceChildren(icon(c.video ? 'video' : 'phone', 17), h('span', {}, c.video ? 'Video call' : 'Voice call'));
      if (host.isNew?.(p) && !view.rec.previousElementSibling?.matches('[data-testid=call-new]'))
        view.rec.before(h('div', { class: 'newc', 'data-testid': 'call-new' }, 'New contact'));
      break;
    case 'reaching':
      view.status.textContent = 'Reaching…';
      break;
    case 'ringing':
      view.status.textContent = 'Ringing…';
      break;
    case 'connecting':
      view.status.textContent = 'Connecting…';
      break;
    case 'reconnecting':
      view.status.textContent = 'Reconnecting…';
      break;
    case 'connected': {
      const tick = () => {
        const t = duration(Date.now() - (c.connectedAt ?? Date.now()));
        view.status.textContent = t;
        view.pillTime.lastChild!.textContent = `In call · ${t}`;
        const b = view.back.querySelector('span');
        if (b) b.textContent = `Back to call · ${t}`;
      };
      tick();
      view.tick = setInterval(tick, 1000);
      break;
    }
    case 'failed':
      view.status.textContent = failureText(who, c.failure);
      break;
    case 'ended':
    case 'missed':
      view.status.textContent = c.state === 'missed' ? `Missed call from ${who}` : 'Call ended';
      break;
  }
  // Screen sharing: my pill and button; their screen is shown whole (not cropped).
  const share = view.root.querySelector('[data-testid=screen-share]');
  share?.classList.toggle('off', p.sharingScreen);
  share?.setAttribute('aria-label', p.sharingScreen ? 'Stop sharing' : 'Share screen');
  view.pillShare.classList.toggle('hidden', !(p.sharingScreen && LIVE.includes(c.state)));
  // Device sound with the screen: a speaker toggle on the pill (or one quiet line if none was captured).
  const snd = p.screenSound;
  const sb = view.pillShare.querySelector('[data-testid=screen-sound]') as HTMLElement;
  sb.classList.toggle('hidden', !snd.captured);
  sb.replaceChildren(icon(snd.on ? 'speaker' : 'speaker-off', 15), h('span', {}, snd.on ? 'Device sound on' : 'Device sound off'));
  sb.setAttribute('aria-label', snd.on ? 'Device sound on: tap to turn off' : 'Device sound off: tap to turn on');
  sb.setAttribute('aria-pressed', String(snd.on));
  if (p.sharingScreen && !snd.captured && !view.noSoundSaid) {
    view.noSoundSaid = true;
    host.note?.('Sound not shared on this device');
  }
  view.root.classList.toggle('their-screen', p.theyShare);
  // "● Ravi is recording" (they record); in host mode also "● Recording" while the host app records this call.
  const live = LIVE.includes(c.state);
  const mine = !!host.hosted && p.recording && live;
  const theirs = p.theyRecord && live;
  view.rec.classList.toggle('hidden', !(mine || theirs));
  view.rec.replaceChildren(h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', {}, [mine ? 'Recording' : '', theirs ? `${who} is recording` : ''].filter(Boolean).join(' · ')));

  if (mode !== view.mode || mode === 'over') {
    view.mode = mode;
    let body: Child;
    if (mode === 'incoming') {
      body = h('div', { class: 'answer' },
        h('div', { class: 'acol' }, roundBtn('hang-up', 'Decline', 'decline', () => void p.declineCall(), 'red big'), h('span', {}, 'Decline')),
        h('div', { class: 'acol' }, roundBtn('phone', 'Answer', 'accept', () => void p.acceptCall(), 'green big'), h('span', {}, 'Answer')));
    } else if (mode === 'live') {
      body = liveControls(p, view);
    } else {
      // Over: the reason shows for a moment, then the screen closes by itself and their chat opens
      // with one line about the call (nothing to press; Dr Vijay, 23 Oct 2026).
      body = null;
      const text = endText(who, c);
      const again = c.state === 'missed' || c.state === 'failed' ? { video: c.video } : null;
      view.closing ??= setTimeout(() => {
        view.closing = null;
        if (v !== view || p.inCallNow) return; // a new call started meanwhile
        p.resetCall();
        if (v === view) closeCallView();
        host.ended ? host.ended(p, text, again) : host.showChat(p);
      }, c.state === 'failed' ? CALL_FAIL_MS : CALL_END_MS);
    }
    view.bottom.replaceChildren(body ?? '');
  }
  if (mode === 'over' && !view.logged) {
    view.logged = true;
    const seconds = c.connectedAt ? Math.round((Date.now() - c.connectedAt) / 1000) : 0;
    const result: CallRecord['result'] = c.state === 'missed' ? 'missed' : c.state === 'failed' ? (c.failure === 'declined' ? 'declined' : 'failed') : seconds ? 'ended' : c.outgoing ? 'ended' : 'declined';
    host.logged({ peer: p.peer.id, name: who, video: c.video, outgoing: c.outgoing, result, ts: Date.now(), seconds });
  }
  if (mode !== 'over') {
    view.logged = false;
    if (view.closing) clearTimeout(view.closing);
    view.closing = null;
  }
  if (c.state === 'connected') armFade();
  refreshCallVideos(p);
}

/** The call's "i": both safety pictures, the path, the locks. */
function infoSheet(p: Peer, host: CallHost): void {
  if (!p.peer) return;
  const info = host.pathOf(p);
  const t = PATH_TEXT[info.kind];
  const s = sheet('call-info-sheet',
    h('h2', {}, 'Check who you are talking to'),
    h('div', { class: 'sec' }, 'SAFETY PICTURES'),
    h('div', { class: 'card' },
      h('div', { class: 'kv', 'data-testid': 'call-emoji' },
        h('div', { class: 'k' }, h('div', { class: 'lbl' }, 'Them'), h('div', { class: 'pics' }, emojiCode(p.peer.publicKey))),
        h('div', { class: 'k' }, h('div', { class: 'lbl' }, 'You'), h('div', { class: 'pics' }, emojiCode(host.myKey))))),
    h('p', { class: 'muted small' }, 'Ask them to read their pictures. If they match, nobody is in the middle.'),
    h('div', { class: 'sec' }, 'THIS CONNECTION'),
    h('div', { class: 'card', 'data-testid': 'call-path' },
      h('div', { class: 'kv' }, icon(PATH_ICON[info.kind], 22, 'ok'), h('div', { class: 'k' }, t.short)),
      h('div', { class: 'kv' }, icon('lock', 22, 'ok'), h('div', { class: 'k' }, 'Locked end to end'))),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'OK'));
}
