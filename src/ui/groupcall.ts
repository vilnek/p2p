// Group calls on screen (small mesh, src/net/groupCall.ts): the incoming card, the tile grid with
// each person's state, the active speaker ring, screen share as a big stage, one control bar.
// Same look as the 1:1 call (design P2 screens 5, 7 and 10).

import { PATH_TEXT } from '../core/path';
import type { GroupCallInfo, GroupCallManager, Participant } from '../net/groupCall';
import { maxPeople } from '../net/groupCall';
import { avatar, duration, h } from './dom';
import { icon, type IconName } from './icons';
import { NO_SCREEN_HERE, shareErrorText } from './shareError';
import { applySpeaker, listDevices, nextCamera, trackDevice } from '../core/mediaDevices';
import { devicesSheet } from './devicesSheet';

export interface GroupCallHost {
  myId: string;
  myName: string;
  note(text: string): void;
  /** The call ended and its screen closed by itself: back to the group's chat, with how it ended. */
  ended?(gid: string, text: string): void;
  /** Host mode (?embed=1&ui=1): Share screen shows even where the window can't capture (it then says so). */
  hosted?: boolean;
}

const isPhone = () => /Android|iPhone|iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
/** Flip on a phone: the camera facing the other way. */
let facing: 'user' | 'environment' = 'user';
/** Computers: is there a second camera (Flip shows only then)? Checked once per call. */
let manyCameras: boolean | null = null;

const STATE_LINE: Record<string, string> = {
  reaching: 'Reaching…',
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  left: 'Left the call',
};
const REASON_LINE: Record<string, string> = {
  offline: 'Not reachable now',
  'no-answer': 'Didn’t answer',
  declined: 'Declined',
  busy: 'On another call',
  media: 'Couldn’t connect sound and video',
  full: 'The call is full',
  removed: 'Removed from the group',
};

let layer: HTMLElement | null = null;
/** The call I am in (for the line in the group chat when it ends). */
let inCall: { gid: string; video: boolean } | null = null;
let started = 0;
let tick: ReturnType<typeof setInterval> | null = null;
/** Tiles kept by person, so video elements aren't re-made on every change (no flicker). */
const tiles = new Map<string, { el: HTMLElement; video: HTMLVideoElement }>();
const fading = new Map<string, number>();

function ensureLayer(): HTMLElement {
  if (!layer || !layer.isConnected) {
    layer = h('div', { id: 'gcall-layer', class: 'gcall', 'data-testid': 'gcall-screen', role: 'dialog', 'aria-label': 'Group call' });
    document.body.append(layer);
  }
  return layer;
}

export function closeGroupCall(): void {
  if (tick) clearInterval(tick);
  tick = null;
  tiles.clear();
  fading.clear();
  facing = 'user';
  manyCameras = null;
  layer?.remove();
  layer = null;
}

function roundBtn(name: IconName, label: string, testid: string, onclick: () => void, cls = ''): HTMLElement {
  return h('button', { class: `cb ${cls}`.trim(), 'aria-label': label, title: label, 'data-testid': testid, type: 'button', onclick }, icon(name, 24));
}

/** The incoming card: "Ravi is calling Seva team", Video / Voice call, Join and Decline. */
function incoming(gcm: GroupCallManager, c: GroupCallInfo): void {
  const l = ensureLayer();
  l.className = 'gcall incoming';
  l.dataset.state = 'incoming';
  l.replaceChildren(
    h('div', { class: 'chero' },
      h('div', { class: 'ring-av' }, avatar(c.groupName, c.gid, 120)),
      h('div', { class: 'n one-line', 'data-testid': 'gcall-title' }, `${c.byName || 'Someone'} is calling ${c.groupName}`),
      h('div', { class: 's' }, icon(c.video ? 'video' : 'phone', 17), h('span', {}, c.video ? 'Video call' : 'Voice call'))),
    h('div', { class: 'cbottom' },
      h('div', { class: 'answer' },
        h('div', { class: 'acol' }, roundBtn('hang-up', 'Decline', 'gcall-decline', () => void gcm.decline(c.callId), 'red big'), h('span', {}, 'Decline')),
        h('div', { class: 'acol' }, roundBtn(c.video ? 'video' : 'phone', 'Join', 'gcall-join', () => void gcm.join(c.callId).catch(() => undefined), 'green big'), h('span', {}, 'Join')))),
  );
}

function tileFor(id: string, name: string): { el: HTMLElement; video: HTMLVideoElement } {
  let t = tiles.get(id);
  if (!t) {
    const video = h('video', { class: 'nostream', autoplay: true, playsinline: true }) as HTMLVideoElement;
    t = { el: h('div', { class: 'gtile', 'data-testid': 'gcall-tile', 'data-id': id }, video), video };
    t.el.append(h('div', { class: 'gav' }, avatar(name, id, 72)), h('div', { class: 'gname' }), h('div', { class: 'gstate' }), h('div', { class: 'gpath' }));
    tiles.set(id, t);
  }
  return t;
}

function setStream(v: HTMLVideoElement, s: MediaStream | null, muted: boolean): void {
  if (v.srcObject !== s) v.srcObject = s;
  v.classList.toggle('nostream', !s); // an empty <video> is never drawn (Android: "Unable to play media")
  v.muted = muted; // my own tile is muted; everyone else's sound plays
  if (s) void v.play().catch(() => undefined);
  if (!muted) void applySpeaker(v); // the speaker picked in Devices (where the browser allows)
}

/** The call I'm in: pills on top, the tiles, the control bar. */
function joined(gcm: GroupCallManager, c: GroupCallInfo, host: GroupCallHost): void {
  const l = ensureLayer();
  if (l.dataset.state !== 'joined') {
    started = Date.now();
    l.dataset.state = 'joined';
    l.replaceChildren(
      h('div', { class: 'gtop' },
        h('span', { class: 'pill', 'data-testid': 'gcall-count' }, h('span', { class: 'dot on' }), h('span', {})),
        h('span', { class: 'pill' }, icon('lock', 15), 'Locked · direct'),
        h('span', { class: 'pill hidden', 'data-testid': 'gcall-screen-pill' })),
      h('div', { class: 'ggrid', 'data-testid': 'gcall-grid' }),
      h('div', { class: 'cbottom' }, h('div', { class: 'ctrl' })),
    );
    if (tick) clearInterval(tick);
    tick = setInterval(() => drawTop(gcm), 1000);
  }
  l.className = `gcall joined ${c.video ? 'video' : 'voice'}${gcm.screenBy ? ' sharing' : ''}`;
  drawTop(gcm);
  drawGrid(gcm, host);
  drawControls(gcm, host);
}

function drawTop(gcm: GroupCallManager): void {
  const count = layer?.querySelector('[data-testid=gcall-count] span:last-child');
  if (count) count.textContent = `${gcm.size} in call · ${duration(Date.now() - started)}`;
}

function drawGrid(gcm: GroupCallManager, host: GroupCallHost): void {
  const grid = layer?.querySelector('.ggrid') as HTMLElement | null;
  if (!grid) return;
  const now = Date.now();
  const people = gcm.participants().filter((p) => {
    // Left and failed tiles fade out after a few seconds.
    if (p.state !== 'left' && p.state !== 'failed') {
      fading.delete(p.id);
      return true;
    }
    const since = fading.get(p.id) ?? now;
    fading.set(p.id, since);
    return now - since < (p.state === 'left' ? 3000 : 5000);
  });
  const shown: { id: string; el: HTMLElement }[] = [];
  // Me first.
  const mine = tileFor(host.myId, host.myName);
  setStream(mine.video, gcm.localStream, true);
  mine.el.classList.add('me');
  mine.el.classList.toggle('novideo', !(gcm.camera && gcm.localStream?.getVideoTracks().length));
  mine.el.classList.toggle('speaking', gcm.speaker === host.myId);
  (mine.el.querySelector('.gname') as HTMLElement).replaceChildren(h('span', {}, 'You'), gcm.mic ? '' : icon('mic-off', 14));
  shown.push({ id: host.myId, el: mine.el });
  for (const p of people) shown.push({ id: p.id, el: drawTile(p, gcm) });
  // Screen share: the sharer's tile is the stage.
  const stage = gcm.screenBy;
  for (const { id, el } of shown) el.classList.toggle('stage', id === stage);
  grid.dataset.n = String(shown.length);
  grid.replaceChildren(...shown.sort((a, b) => (a.id === stage ? -1 : b.id === stage ? 1 : 0)).map((x) => x.el));
  const pill = layer?.querySelector('[data-testid=gcall-screen-pill]') as HTMLElement | null;
  if (pill) {
    pill.classList.toggle('hidden', !stage);
    const who = stage === host.myId ? 'You are sharing your screen' : `${gcm.participants().find((p) => p.id === stage)?.name || 'Someone'} is sharing`;
    pill.replaceChildren(icon('screen-share', 15), h('span', {}, who));
  }
  for (const id of [...tiles.keys()]) if (!shown.some((x) => x.id === id)) tiles.delete(id);
}

function drawTile(p: Participant, gcm: GroupCallManager): HTMLElement {
  const t = tileFor(p.id, p.name);
  setStream(t.video, p.stream, false);
  const live = p.state === 'connected';
  t.el.dataset.state = p.state;
  t.el.classList.toggle('dim', !live);
  t.el.classList.toggle('novideo', !(live && p.hasVideo && (p.camera || p.screen)));
  t.el.classList.toggle('speaking', gcm.speaker === p.id && live);
  (t.el.querySelector('.gname') as HTMLElement).replaceChildren(h('span', {}, p.name || 'Someone'), p.mic ? '' : icon('mic-off', 14));
  const line = p.state === 'failed' ? REASON_LINE[p.reason ?? 'offline'] : STATE_LINE[p.state] ?? '';
  const st = t.el.querySelector('.gstate') as HTMLElement;
  st.textContent = line;
  st.dataset.testid = 'gcall-tile-state';
  (t.el.querySelector('.gpath') as HTMLElement).textContent = live && p.path ? PATH_TEXT[p.path.kind].short : '';
  return t.el;
}

function drawControls(gcm: GroupCallManager, host: GroupCallHost): void {
  const bar = layer?.querySelector('.ctrl') as HTMLElement | null;
  if (!bar) return;
  const btns: HTMLElement[] = [
    roundBtn(gcm.mic ? 'mic' : 'mic-off', gcm.mic ? 'Mute' : 'Unmute', 'gcall-mic', () => gcm.setMic(!gcm.mic), gcm.mic ? '' : 'off'),
    roundBtn(gcm.camera ? 'video' : 'video-off', gcm.camera ? 'Turn camera off' : 'Turn camera on', 'gcall-camera', () => void gcm.setCamera(!gcm.camera), gcm.camera ? '' : 'off'),
  ];
  if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
    const mine = !!gcm.screenBy && !gcm.participants().some((p) => p.id === gcm.screenBy);
    btns.push(roundBtn('screen-share', mine ? 'Stop sharing' : 'Share screen', 'gcall-share', () => {
      if (mine) void gcm.stopScreen();
      else void gcm.startScreen().catch((e: Error) => {
        const text = shareErrorText(e);
        if (layer && text) alertLine(text, 9000);
      });
    }, mine ? 'off' : ''));
  } else if (host.hosted) {
    btns.push(roundBtn('screen-share', 'Share screen', 'gcall-share', () => alertLine(NO_SCREEN_HERE, 9000)));
  }
  // Flip: front / back on a phone; the next camera on a computer with two or more.
  if (gcm.myTracks.cam && (isPhone() || manyCameras)) btns.push(roundBtn('switch-camera', 'Flip camera', 'gcall-flip', () => void flip(gcm)));
  if (manyCameras === null && !isPhone()) {
    manyCameras = false;
    void listDevices().then((d) => {
      manyCameras = d.cameras.length > 1;
      if (manyCameras) drawControls(gcm, host);
    });
  }
  btns.push(roundBtn('settings', 'Devices', 'gcall-devices', () => void devicesSheet({
    video: () => !!gcm.myTracks.cam,
    current: () => ({ cam: trackDevice(gcm.myTracks.cam), mic: trackDevice(gcm.myTracks.mic) }),
    camera: (id) => gcm.switchCamera({ id }).then(() => undefined),
    mic: (id) => gcm.switchMic(id).then(() => undefined),
    speaker: () => tiles.forEach((t) => !t.video.muted && void applySpeaker(t.video)),
  })));
  btns.push(roundBtn('hang-up', 'Leave the call', 'gcall-leave', () => void gcm.leave(), 'red'));
  bar.replaceChildren(...btns);
}

async function flip(gcm: GroupCallManager): Promise<void> {
  try {
    if (isPhone()) {
      const next = facing === 'user' ? 'environment' : 'user';
      await gcm.switchCamera({ facing: next });
      facing = next;
    } else {
      const next = nextCamera((await listDevices()).cameras, trackDevice(gcm.myTracks.cam));
      if (next) await gcm.switchCamera({ id: next.id });
    }
  } catch {
    alertLine('Couldn’t switch the camera.');
  }
}

function alertLine(text: string, ms = 2600): void {
  const t = h('div', { class: 'toast', role: 'status', 'data-testid': 'share-error' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** The call ended (or I was removed, or it was full): one plain line, then the screen closes. */
function endedScreen(c: GroupCallInfo, host: GroupCallHost): void {
  inCall = null;
  const l = ensureLayer();
  if (tick) clearInterval(tick);
  tick = null;
  l.dataset.state = 'ended';
  l.className = 'gcall ended';
  const text = c.reason === 'full' ? `This call is full (${maxPeople(true)} on video, ${maxPeople(false)} on voice)` : c.reason === 'removed' ? 'You were removed from the group' : 'Call ended';
  l.replaceChildren(h('div', { class: 'chero' }, h('div', { class: 'n one-line' }, c.groupName), h('div', { class: 's', 'data-testid': 'gcall-status' }, text)));
  // Closes by itself and goes back to the group's chat (nothing to press).
  setTimeout(() => {
    if (layer?.dataset.state !== 'ended') return;
    closeGroupCall();
    host.ended?.(c.gid, c.reason === 'full' || c.reason === 'removed' ? text : `Group ${c.video ? 'video' : 'voice'} call ended`);
  }, c.reason === 'full' || c.reason === 'removed' ? 3000 : 1500);
}

/** Draws whatever the group call is now (call it on every event). */
export function renderGroupCall(gcm: GroupCallManager, host: GroupCallHost, ended?: GroupCallInfo): void {
  const c = gcm.call ?? gcm.joinable().find((x) => x.state === 'incoming') ?? (ended?.state === 'ended' && layer?.dataset.state === 'joined' ? ended : null);
  if (!c) {
    if (layer?.dataset.state === 'ended') return;
    const was = layer?.dataset.state === 'joined' ? inCall : null;
    closeGroupCall();
    // I left, or the call ended: straight back to the group's chat, with one line about it (no OK).
    if (was) host.ended?.(was.gid, `Group ${was.video ? 'video' : 'voice'} call ended`);
    return;
  }
  if (c.state === 'joined') inCall = { gid: c.gid, video: c.video };
  if (c.state === 'incoming') return incoming(gcm, c);
  if (c.state === 'joined') return joined(gcm, c, host);
  if (c.state === 'ended') return endedScreen(c, host);
  closeGroupCall(); // missed / declined: the group chat shows "Call on · Join"
}
