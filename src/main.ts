// P2P Talk, Phase 0: the screens, laid out as design P2.
//   Phone (< 900 px): five tabs, Chats · Groups · Calls · Add · Me; a chat or a step (show my code, scan…)
//   opens full screen over them.
//   Wide (≥ 900 px): icon rail · list (the tab) · conversation or step · details panel (≥ 1200 px).
// Plain words on screen; no technical terms (they live behind "Show code as text").
// With ?embed=1 there are no screens at all: the host app drives the page through window.P2PTalk (embed.ts).
// With ?embed=1&ui=1 (host mode, design CN2) these screens show inside the host app, signed in by it (hostui.ts).

import './style.css';
import { fromB64url, toB64url, toHex } from './core/bytes';
import { cardTextFrom, decodeCard, DEFAULT_RELAYS, INVITE_USED_TEXT, newCard, type Card } from './core/card';
import { cleanDeviceName, deviceCode, renameDevice, type StoredDevice } from './core/device';
import { emojiCode, formatId, idIsValid, identityFromPhrase, newGuestIdentity, newPhrase, p2pId, phraseIsValid } from './core/identity';
import { PATH_TEXT } from './core/path';
import {
  addCall,
  addMessage,
  clearCalls,
  deleteChatMessages,
  deleteContact,
  deletePic,
  loadMuted,
  removeCall,
  setMuted,
  type CallRecord,
  loadBlocked,
  addPublished,
  loadPublished,
  loadGroupsState,
  saveGroupsState,
  clearUnsavedWords,
  loadUnsavedWords,
  saveUnsavedWords,
  loadCalls,
  loadContact,
  loadContacts,
  loadInvites,
  loadMe,
  loadMessages,
  loadMyDevices,
  loadReadMarks,
  markCardUsed,
  commitChatLock,
  loadChatLock,
  loadLockSecret,
  loadLockTries,
  loadMessagesWithBlobs,
  loadMyPhoto,
  loadReadReceipts,
  saveReadReceipts,
  loadReceiptOutbox,
  saveReceiptOutbox,
  findStoredMessage,
  loadPhotoVisibility,
  loadPics,
  saveMyPhoto,
  savePhotoVisibility,
  savePics,
  loadStoredMessages,
  putMessage,
  saveLockSecret,
  saveLockTries,
  markRead,
  saveContact,
  saveDevice,
  saveInvite,
  saveMe,
  saveRelayChoice,
  wasCardUsed,
  type ChatMessage,
  type Contact,
  type StoredMe,
  databaseExists,
  loadFlag,
  readOtherChats,
  saveFlag,
  useDatabase,
} from './core/store';
import { dbFor, startEmbed } from './embed';
import { HOST_UI_FEATURE, hostEmit, hostOff, hostOn, isHostTab, isHostUi, type HostEventName, type HostTab } from './hostui';
import { codeProblem } from './core/chatlock';
import { ChatLocks } from './core/locks';
import { blobToOpfs, opfsFile, opfsSupported, removeOpfsFile } from './core/sinks';
import { clearChatData, filesOf, type ChatFiles } from './core/forget';
import { closeSwiped, listBusy, menuItem, withActions } from './ui/rowActions';
import { isMedia, isVideoType, makeThumb, openViewer, thumbView } from './ui/media';
import { PhotoLink, PIC_FEATURE, PIC_KINDS, type PhotoHost } from './net/photos';
import { groupStatus, parseReceipt, ReceiptOutbox, RCPT_FEATURE, shownStatus, upgrade, type TickStatus } from './net/receipts';
import type { StoredPhoto } from './core/photo';
import { cropPhoto, photoUrl } from './ui/photo';
import { wordsCheck, wordsPanel } from './ui/words';
import { homePage } from './ui/home';
import { allowedRelays, myRelays, testInviteTtl, testRelays } from './net/config';
import { Hub, joinInvite, type ContactRequest } from './net/hub';
import { hostCard, joinCard, RelaysUnreachable, type HostedCard } from './net/oneScan';
import { lastAttempt, onlyLocal, report, type Attempt } from './net/diag';
import { decodeCode } from './core/signal';
import { RelayPool } from './net/relay';
import { extractId, shareIdText, type IdCard } from './core/idcard';
import { REPORT_DONE_TEXT, reportMailto } from './core/report';
import { testFlag } from './core/testmode';
import { deleteAccount, DELETE_BUTTON, DELETE_TEXT, DELETE_TITLE } from './core/wipe';
import { FILE_FEATURE, FileTransfers, type TransferInfo } from './net/files';
import { GROUP_FEATURE, GroupManager, type GroupInfo, type GroupMember, type GroupMessage, type GroupsState } from './net/groups';
import {
  canSaveToPhotos,
  cleanupNativeFiles,
  isNativeApp,
  nativeFileOf,
  NativeFilesError,
  pickOriginals,
  receiveSink,
  removeReceivedFile,
  saveToFiles,
  saveToPhotos,
  receivedThumb,
  shareOrOpen,
  type PickedSource,
  type PickKind,
} from './native/nativeFiles';
import type { SinkResult } from './core/sinks';
import { failedLine, saveActions, sendPicked, type SaveKind } from './ui/fileActions';
import { installPhoneScreenShare } from './native/androidScreen';
import { GROUP_CALL_FEATURE, GROUP_CALL_KINDS, GroupCallManager, type GroupCallInfo } from './net/groupCall';
import { closeGroupCall, renderGroupCall } from './ui/groupcall';
import { searchRelays } from './net/config';
import { CONNECT_WAIT_MS, ConnectFailed, FEATURES, ICE_SERVERS, Peer, PROTOCOL_VERSION, type CallInfo, type PeerInfo } from './net/peer';
import { ensureDevice, KeyChanged, learnMyDevices, meWithDevice, platformDeviceName, rememberContact } from './net/session';
import { callPeer, closeCallView, refreshCallVideos, renderCall, type CallHost } from './ui/call';
import type { GroupCallHost } from './ui/groupcall';
import { avatar, avatarPhoto, bytes, closeSheets, dayLabel, h, iconBtn, setAvatarPhoto, sheet, shortWhen, time, when, type Child } from './ui/dom';
import { icon, PATH_ICON, type IconName } from './ui/icons';
import { qrCanvas, scanQr } from './ui/qr';

// ---- state -----------------------------------------------------------------------------------------

type Tab = 'chats' | 'groups' | 'calls' | 'add' | 'me';

let me: StoredMe | null = null;
let device: StoredDevice | null = null;
let hub: Hub | null = null;
/** Open connections, by contact (24-digit ID). Several chats can be open at once; one call at a time. */
const peers = new Map<string, Peer>();
/** The last connection per contact, even once closed (for "last seen" and a failed call screen). */
const lastPeer = new Map<string, Peer>();
/** A line for a chat when its connection opens (e.g. "Ravi joined from your invite"). */
const notes = new WeakMap<Peer, string>();
let tab: Tab = 'chats';
/** What the main pane shows: a conversation, a step (flow), or nothing. */
let main: { kind: 'none' } | { kind: 'chat'; id: string } | { kind: 'flow'; name: string } = { kind: 'none' };
/** A step that started a connection: when it opens, show its chat even though a step is on screen. */
let expecting = false;
let scanAbort: AbortController | null = null;
let hosted: HostedCard | null = null;
let screenGen = 0; // bumps on every step started by the user, to drop late async results
/** The invite we opened (their P2P ID), to update its status line in place. */
let inviteScreenFor: string | null = null;

/** Chat lock: which chats are locked, and whether the code was typed (core/locks.ts). */
const locks = new ChatLocks({
  loadLock: loadChatLock,
  loadSecret: loadLockSecret,
  saveSecret: saveLockSecret,
  loadTries: loadLockTries,
  saveTries: async (t) => void (await saveLockTries(t)),
  messages: loadStoredMessages,
  add: addMessage,
  commit: commitChatLock,
});
/** When a peer's connection opened (for the "Connected" note's place in the chat). */
const readyAt = new WeakMap<Peer, number>();
/** Muted chats (a contact's P2P ID, or "g:<group id>"): no "New message" alert, not counted on the tab. */
let muted = new Set<string>();
/**
 * People I deleted (Delete chat) in the last minutes, by identity key: a connection that was already on
 * its way when I deleted them is not taken as that contact (it would add them back by itself). Cleared
 * when I start adding someone (show my code, open a link…), and after FORGET_MS.
 */
const forgotten = new Map<string, number>();
const FORGET_MS = 3 * 60_000;
const wasForgotten = (key: string) => (forgotten.get(key) ?? 0) > Date.now() - FORGET_MS;

const meForPeer = () => meWithDevice(me!, device);
const myId = () => p2pId(me!.publicKey);
const shortId = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;
const nameOf = (p: PeerInfo) => p.name || shortId(p.id);
const wideSide = matchMedia('(min-width: 1200px)');
const query = new URLSearchParams(location.search);
/** Host mode (?embed=1&ui=1): the identity comes from the host app; no account screens (see "host mode" below). */
const hostMode = isHostUi(query);
/** An event for the host app (host mode only). */
const toHost = (event: HostEventName, data: unknown, forHost: unknown = data): void => {
  if (hostMode) hostEmit(event, data, forHost);
};

// ---- first run (centred cards, no tabs) -------------------------------------------------------------

const app = document.getElementById('app')!;

function brand(): HTMLElement {
  return h('header', { class: 'brand' }, h('span', { class: 'mark' }, icon('chat', 20)), h('span', {}, 'P2P Talk'), h('span', { class: 'tag' }, 'by Vilnek'));
}

function firstRun(...nodes: Child[]): void {
  closeSheets();
  document.body.classList.remove('shelled');
  app.replaceChildren(h('div', { class: 'first-run' }, h('div', { class: 'screen' }, ...nodes)));
  window.scrollTo(0, 0);
}

function errorBox(): { el: HTMLElement; set(msg: string): void } {
  const el = h('p', { class: 'error', role: 'alert', 'data-testid': 'error' });
  return { el, set: (m) => (el.textContent = m) };
}

// ---- a link opened on this device: kept until its join is done (even across a reload) --------------

const LINK_KEY = 'p2p-pending-link';
let pendingLink: string | null = null;

function rememberLink(link: string): void {
  pendingLink = link;
  try {
    sessionStorage.setItem(LINK_KEY, link);
  } catch {
    /* private mode */
  }
}

function takeLink(): string | null {
  if (pendingLink) return pendingLink;
  try {
    return sessionStorage.getItem(LINK_KEY);
  } catch {
    return null;
  }
}

/** The link has done its job (connected, request sent, refused or failed for good). */
function linkDone(): void {
  pendingLink = null;
  linkOk = false;
  try {
    sessionStorage.removeItem(LINK_KEY);
    sessionStorage.removeItem(LINK_OK_KEY);
  } catch {
    /* private mode */
  }
}

/** The person already said yes to this link (Join on the join screen, or Connect on the question). */
const LINK_OK_KEY = 'p2p-pending-link-ok';
let linkOk = false;
function confirmLinkNow(): void {
  linkOk = true;
  try {
    sessionStorage.setItem(LINK_OK_KEY, '1');
  } catch {
    /* private mode */
  }
}
function linkConfirmed(): boolean {
  try {
    return linkOk || sessionStorage.getItem(LINK_OK_KEY) === '1';
  } catch {
    return linkOk;
  }
}

/** Who a link is from, read locally (nothing is sent): name, 24-digit ID, safety pictures. */
async function linkOwner(link: string): Promise<{ name: string; id: string; key: Uint8Array; invite: boolean } | null> {
  try {
    if (/P2P1\./.test(link)) {
      const code = await decodeCode(link);
      const key = fromB64url(code.k);
      return { name: code.n, id: p2pId(key), key, invite: false };
    }
    const text = cardTextFrom(link);
    if (!text) return null;
    const c = decodeCard(text);
    return { name: c.name, id: p2pId(c.identityKey), key: c.identityKey, invite: c.kind === 'invite' };
  } catch {
    return null;
  }
}

/**
 * A link opened while I have an account: ask first. No network action happens before Connect, so a
 * link posted anywhere can't connect me (and show my address) to whoever made it.
 */
async function askAboutLink(link: string): Promise<void> {
  const who = await linkOwner(link);
  if (!who) return useTheirCode(link); // damaged or expired: useTheirCode says so (nothing is sent)
  if (who.id === myId()) {
    linkDone();
    return couldNot('This is your own code.');
  }
  const contact = await loadContact(who.id);
  const name = who.name || contact?.name || shortId(who.id);
  flow('link-confirm', 'Connect?',
    h('section', { class: 'card pad center', 'data-testid': 'link-confirm' },
      avatar(name, who.id, 64),
      h('div', { class: 'big', 'data-testid': 'link-name' }, who.invite ? `${name} invited you` : `Connect with ${name}?`),
      h('div', { class: 'idt', 'data-testid': 'link-id' }, formatId(who.id)),
      h('div', { class: 'pics', 'data-testid': 'link-emoji' }, emojiCode(who.key)),
      h('p', { class: 'muted small' }, contact ? 'Already in your contacts.' : 'Only connect if you know who sent this link. They will see your name and your internet address.'),
      h('div', { class: 'row2' },
        h('button', { class: 'btn pri', 'data-testid': 'link-connect', type: 'button', onclick: () => {
          confirmLinkNow();
          void useTheirCode(link);
        } }, 'Connect'),
        h('button', { class: 'btn sec2', 'data-testid': 'link-cancel', type: 'button', onclick: () => {
          linkDone();
          leaveFlow();
        } }, 'Cancel'))));
}

/** Someone's link, no account yet: one screen, one button. The account is made at once; the words come later. */
function joinScreen(link: string): void {
  if (hostMode) return hostWaiting(); // host mode: links go through the host (P2PTalk.openLink)
  let title = 'Join P2P Talk';
  let sub = 'Talk directly, device to device. No phone number, no server.';
  try {
    const text = cardTextFrom(link);
    if (text) {
      const c = decodeCard(text);
      title = c.kind === 'invite' ? `${c.name || 'Someone'} invited you` : 'Connect on P2P Talk';
      sub = c.kind === 'invite' ? `Join to talk with ${c.name || 'them'} directly, device to device.` : 'Someone shared their code with you. Join to connect directly.';
    }
  } catch {
    /* expired or damaged: the join will say so */
  }
  const name = h('input', { class: 'field', placeholder: 'Your name', maxlength: '40', 'data-testid': 'name', 'aria-label': 'Your name', autocomplete: 'name' }) as HTMLInputElement;
  try {
    name.value = localStorage.getItem('p2p-last-name') ?? '';
  } catch {
    /* no storage */
  }
  const go = () => {
    try {
      localStorage.setItem('p2p-last-name', name.value.trim());
    } catch {
      /* no storage */
    }
    void instantJoin(name.value.trim());
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  firstRun(
    brand(),
    h('section', { class: 'card pad hero', 'data-testid': 'join-screen' },
      h('h1', { 'data-testid': 'join-title' }, title),
      h('p', { class: 'muted' }, sub),
      name,
      h('button', { class: 'btn pri', 'data-testid': 'join', type: 'button', onclick: go }, 'Join'),
      h('div', { class: 'guest' },
        h('button', { class: 'link small', 'data-testid': 'join-guest', type: 'button', onclick: () => void joinAsGuest(name.value.trim(), platformDeviceName()) }, 'Join as guest (this browser only)'),
        h('p', { class: 'muted small', 'data-testid': 'guest-note' }, 'Guest on this browser only. If you clear the browser, this account is gone.'),
        h('button', { class: 'link small', 'data-testid': 'join-restore', type: 'button', onclick: () => restore(name.value.trim(), platformDeviceName()) }, 'I already have 24 words')),
      termsLine()),
  );
  name.focus();
}

/** Join: real keys from fresh 24 words, made now; the words are offered afterwards (a banner in Chats and Me). */
async function instantJoin(name: string): Promise<void> {
  confirmLinkNow(); // Join was the yes: carry on without asking again
  const phrase = newPhrase();
  await setUp(await identityFromPhrase(phrase), name, platformDeviceName());
  await saveUnsavedWords(phrase);
  unsavedWords = true;
  start();
}
let unsavedWords = false;

/** No account on this device: the home page (design P3). Links (#c=…) go to the join screen instead. */
function welcome(): void {
  if (hostMode) return hostWaiting(); // host mode: never the home page; the host signs in
  closeSheets();
  document.body.classList.remove('shelled');
  const name = h('input', { class: 'field', placeholder: 'Your name, e.g. Kavya Reddy', maxlength: '40', 'data-testid': 'name', 'aria-label': 'Your name', autocomplete: 'name' }) as HTMLInputElement;
  app.replaceChildren(homePage({
    name,
    onMake: () => void makeAccount(name.value.trim(), platformDeviceName()),
    onRestore: () => restore(name.value.trim(), platformDeviceName()),
    terms: termsLine(' You’ll get 24 secret words to keep your account safe.'),
    termsUrl: TERMS,
    privacyUrl: PRIVACY,
  }));
  window.scrollTo(0, 0);
}

async function setUp(id: { secretKey: Uint8Array; publicKey: Uint8Array }, name: string, deviceName: string, guest = false): Promise<void> {
  me = { secretKey: id.secretKey, publicKey: id.publicKey, name, created: Date.now(), ...(guest ? { guest: true } : {}) };
  await saveMe(me);
  device = await ensureDevice(me, cleanDeviceName(deviceName) || platformDeviceName());
}

async function makeAccount(name: string, deviceName: string): Promise<void> {
  const phrase = newPhrase();
  await setUp(await identityFromPhrase(phrase), name, deviceName);
  // The account exists now. If the page closes before the check passes, the words are offered again
  // (the "Save your 24 words" banner, as after Join), instead of being lost for good.
  await saveUnsavedWords(phrase);
  unsavedWords = true;
  const checked = async () => {
    await clearUnsavedWords();
    unsavedWords = false;
    start();
  };
  const showWords = () =>
    firstRun(
      brand(),
      h('section', { class: 'card pad' },
        h('h2', {}, 'Your 24 secret words'),
        h('p', { class: 'warn' }, 'Write these 24 words on paper, in order. Anyone with them can be you. We can’t recover them for you, and this is the only time they are shown.'),
        h('p', { class: 'muted small' }, 'Type the same 24 words on your other phone or computer to use this account there too.'),
        wordsPanel(phrase),
        myIdBlock(),
        h('button', { class: 'btn pri', 'data-testid': 'phrase-done', type: 'button', onclick: () => firstRun(brand(), wordsCheck(phrase, () => void checked(), showWords)) }, 'I’ve written them down')),
    );
  showWords();
}

/** No 24 words: a key kept in this browser only (plan §5.2 "this phone only"). */
async function joinAsGuest(name: string, deviceName: string): Promise<void> {
  if (takeLink()) confirmLinkNow();
  await setUp(newGuestIdentity(), name, deviceName, true);
  start();
}

function restore(name: string, deviceName: string): void {
  // Typed words are masked (dots) unless "Hold to check" is held.
  const box = h('textarea', { class: 'field secret-words', rows: '5', placeholder: 'Type your 24 words, with spaces between them', 'data-testid': 'restore-words', 'aria-label': 'Your 24 words', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  const peek = h('button', { class: 'link small', type: 'button', 'data-testid': 'restore-peek', onpointerdown: () => box.classList.remove('secret-words'),
    onpointerup: () => box.classList.add('secret-words'), onpointerleave: () => box.classList.add('secret-words') }, 'Hold to check what you typed');
  const who = h('input', { class: 'field', placeholder: 'Your name (optional)', maxlength: '40', 'data-testid': 'name', 'aria-label': 'Your name', autocomplete: 'name' }) as HTMLInputElement;
  who.value = name;
  const dev = h('input', { class: 'field', id: 'device-name', maxlength: '32', 'data-testid': 'device-name', 'aria-label': 'This device’s name' }) as HTMLInputElement;
  dev.value = deviceName;
  const err = errorBox();
  firstRun(
    brand(),
    h('section', { class: 'card pad' },
      h('h2', {}, 'Restore from 24 words'),
      h('p', { class: 'muted' }, 'You get back the same account and the same P2P ID. This also adds the account to this device if you use it on another one.'),
      box,
      peek,
      who,
      h('label', { class: 'muted small', for: 'device-name' }, 'This device’s name (your contacts see it)'),
      dev,
      err.el,
      h('button', { class: 'btn pri', 'data-testid': 'restore-go', type: 'button', onclick: async () => {
        if (!phraseIsValid(box.value)) return err.set('These 24 words are not right. Check each word and its spelling.');
        await setUp(await identityFromPhrase(box.value), who.value.trim(), dev.value);
        start();
      } }, 'Restore'),
      h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'restore-back', onclick: () => (takeLink() ? joinScreen(takeLink()!) : welcome()) }, 'Back')),
  );
  box.focus();
}

// ---- small things used on several screens -------------------------------------------------------

function toast(text: string): void {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

const TERMS = 'https://p2p.vilnek.in/terms/';
const PRIVACY = 'https://p2p.vilnek.in/privacy/';

function termsLine(more = ''): HTMLElement {
  return h('p', { class: 'muted small terms', 'data-testid': 'terms' }, 'By continuing you agree to the ',
    h('a', { href: TERMS, target: '_blank', rel: 'noopener noreferrer' }, 'Terms'), ' and the ',
    h('a', { href: PRIVACY, target: '_blank', rel: 'noopener noreferrer' }, 'Privacy policy'), '.', more);
}

/** Copying or sharing my ID turns "Findable by my ID" on (once), and says so. */
let findableWanted = false;
async function makeFindable(): Promise<void> {
  if (!hub) {
    findableWanted = true; // before the app starts (first screen): turned on in start()
    return;
  }
  if (await hub.findable()) return;
  await hub.setFindable(true);
  const note = document.querySelector('[data-testid=findable-note]');
  if (note) note.classList.remove('hidden');
  toast('People who have your ID can now send you a request. You choose who to accept.');
}

async function copyMyId(): Promise<void> {
  const ok = await navigator.clipboard?.writeText(myId()).then(() => true, () => false);
  toast(ok ? 'Copied' : 'Couldn’t copy. Select the ID and copy it.');
  await makeFindable();
}

async function shareMyId(): Promise<void> {
  const text = shareIdText(formatId(myId()));
  if (typeof navigator.share === 'function') {
    const shared = await navigator.share({ text }).then(() => true, () => false);
    if (shared) return makeFindable();
  }
  await copyMyId();
}

/** My ID with Copy and Share (Me card, first screen). */
function myIdBlock(findable = false): HTMLElement {
  return h('div', { class: 'my-id-block' },
    h('div', { class: 'lbl' }, 'MY P2P ID'),
    h('div', { class: 'idrow' },
      // Two halves of three 4-digit blocks: one line when it fits, else two balanced lines (never 5 + 1).
      h('button', { class: 'idt idbtn', 'data-testid': 'my-id', type: 'button', title: 'Copy', onclick: () => void copyMyId() },
        h('span', { class: 'idh' }, formatId(myId()).slice(0, 14)), ' ', h('span', { class: 'idh' }, formatId(myId()).slice(15))),
      iconBtn('copy', 'Copy my ID', { 'data-testid': 'copy-my-id', onclick: () => void copyMyId() })),
    iconBtn('share', 'Share my ID', { class: 'btn sec2 small with-icon', 'data-testid': 'share-my-id', onclick: () => void shareMyId() }, 'Share my ID'),
    h('p', { class: `muted small${findable ? '' : ' hidden'}`, 'data-testid': 'findable-note' }, 'People who have your ID can now send you a request. You choose who to accept.'));
}

/** Report: block them, then open my own email app with the details (nothing is sent by the app). */
async function reportPerson(name: string, id: string, block: () => Promise<void>, group?: string): Promise<void> {
  if (!confirm(`Report ${name}? They will be blocked. You can then email us the details.`)) return;
  await block();
  const href = reportMailto({ theirId: id, theirName: name, myId: myId(), group });
  const s = sheet('report-sheet',
    h('h2', {}, 'Blocked'),
    h('p', {}, REPORT_DONE_TEXT),
    h('a', { class: 'btn pri', href, 'data-testid': 'report-email' }, 'Email us'),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Close'));
  const a = h('a', { href, class: 'hidden' });
  document.body.append(a);
  try {
    if (!navigator.webdriver) a.click(); // opens the person's own email app
  } finally {
    a.remove();
  }
}

/** Delete my account and data: ask the relays to delete what I put there (NIP-09), then wipe this device. */
function deleteAccountSheet(): void {
  if (hostMode) return; // the host app manages the account
  const s = sheet('delete-sheet',
    h('h2', {}, DELETE_TITLE),
    h('p', {}, DELETE_TEXT),
    me?.guest ? h('p', { class: 'warn small' }, 'This guest account can’t be brought back.') : null,
    h('button', { class: 'btn dang-fill', 'data-testid': 'delete-confirm', type: 'button', onclick: async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      await deleteEverything();
      s.remove();
    } }, DELETE_BUTTON),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Cancel'));
}

async function deleteEverything(): Promise<void> {
  dropConnections();
  const published = await loadPublished().catch(() => []);
  // Relays first (all at once, about 3 s at most), then every database, the file area and our storage keys.
  await deleteAccount(published, { allowed: allowedRelays() });
  forgetSession();
  linkDone();
  welcome();
}

/** Closes every connection, call and engine of this account (Delete my account; P2PTalk.stop() in host mode). */
function dropConnections(): void {
  hosted?.close();
  hosted = null;
  for (const p of peers.values()) p.close();
  peers.clear();
  hub?.stop();
  hub = null;
  if (groupsSaveTimer) clearTimeout(groupsSaveTimer);
  groupsSaveTimer = null;
  gcm?.destroy();
  gcm = null;
  closeGroupCall();
  groups = null;
  files.clear();
}

/** Nothing of the old account stays in memory for the next one made (or started) on this page. */
function forgetSession(): void {
  me = null;
  device = null;
  shell = null;
  unsavedWords = false;
  locks.close();
  myPhoto = null;
  photoVis = 'contacts';
  pics = {};
  photoLinks.clear();
  // Nothing of the old account stays in memory for a new one made on this page (M-6-style leaks:
  // receipts owed, "last seen", trusted contacts, half-done transfers, a pending link).
  lastPeer.clear();
  trusted.clear();
  forgotten.clear();
  muted = new Set();
  contactKeys.clear();
  connectingTo.clear();
  picks.clear();
  thumbs.clear();
  fileStats.clear();
  rcptOut = newReceiptOutbox();
  readReceipts = true;
  unreadOnScreen.chat = '';
  unreadOnScreen.mids = [];
  away = false;
}

// ---- the shell: rail / tab bar, list, main, details ---------------------------------------------------

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'groups', label: 'Groups', icon: 'users' },
  { id: 'calls', label: 'Calls', icon: 'phone' },
  { id: 'add', label: 'Add', icon: 'user-add' },
  { id: 'me', label: 'Me', icon: 'user' },
];

let shell: { nav: HTMLElement; list: HTMLElement; main: HTMLElement; side: HTMLElement } | null = null;

function buildShell(): void {
  closeSheets();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' },
    h('span', { class: 'lens', 'aria-hidden': 'true' }),
    h('div', { class: 'mark rail-only', 'aria-hidden': 'true' }, icon('chat', 22)),
    ...TABS.map((t) => h('button', { class: `tabb t-${t.id}`, 'data-testid': `tab-${t.id}`, 'aria-label': t.label, type: 'button', onclick: () => setTab(t.id) },
      h('span', { class: 'ti' }, icon(t.icon, 22), h('span', { class: 'tbadge hidden', 'data-testid': `tab-${t.id}-unread`, 'aria-hidden': 'true' })), h('span', { class: 'tl' }, t.label))));
  const list = h('section', { class: 'pane list-pane', 'aria-label': 'List' });
  const mainEl = h('section', { class: 'pane main-pane', 'aria-label': 'Conversation' });
  const side = h('aside', { class: 'pane side-pane', 'aria-label': 'Details' });
  shell = { nav, list, main: mainEl, side };
  // The lens follows the active tab; the bar's size changes when it shows again or the layout switches.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => placeLens(false)).observe(nav);
  document.body.classList.add('shelled');
  app.replaceChildren(h('div', { class: 'shell' }, nav, list, mainEl, side));
  clearMain();
}

/** At start (apps): delete received files that no chat shows any more (and old temporary copies). */
async function cleanupFiles(): Promise<void> {
  if (!isNativeApp()) return;
  let keep: string[];
  try {
    keep = [];
    const chats = [...(await loadContacts()).map((c) => c.id), ...(groups?.list() ?? []).map((g) => `g:${g.id}`)];
    // Locked chats' messages are sealed: their file's opaque name is kept outside the seal (keepRef).
    for (const id of chats) for (const m of await loadMessages(id)) if (m.native || m.keepRef) keep.push(m.native?.ref ?? m.keepRef!);
  } catch {
    // The history didn't load: never pass a (wrong, empty) keep list; only temporary files go.
    return cleanupNativeFiles();
  }
  await cleanupNativeFiles(keep);
}

function start(): void {
  locks.onChange = () => void renderList();
  void locks.load().then(() => renderList());
  void loadTrusted();
  void moveOldFiles();
  void loadPictures();
  void loadTicks();
  void loadMuted().then((l) => {
    muted = new Set(l);
    if (l.length) void renderList();
  });
  void cleanupFiles();
  startGroups();
  startHub();
  buildShell();
  setTab('chats');
  void loadUnsavedWords().then((w) => {
    unsavedWords = !!w;
    if (unsavedWords) void renderList();
  });
  if (findableWanted) {
    findableWanted = false;
    void hub?.setFindable(true);
  }
  // A link opened before (or during) making the account: carry on with it, no second opening needed.
  const link = takeLink();
  if (link) void (linkConfirmed() ? useTheirCode(link) : askAboutLink(link));
}

function setTab(t: Tab): void {
  tab = t;
  if (!shell) return;
  for (const b of shell.nav.querySelectorAll('.tabb')) {
    b.classList.toggle('a', b.classList.contains(`t-${t}`));
    if (b.classList.contains(`t-${t}`)) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  placeLens(true);
  // On a phone, choosing a tab leaves the open chat or step.
  if (!isWide() && main.kind !== 'none') clearMain();
  void renderList();
}

const isWide = () => matchMedia('(min-width: 900px)').matches;

/** Puts the glass lens behind the active tab: slides there (`animate`), or jumps (first draw, resize). */
function placeLens(animate: boolean): void {
  const nav = shell?.nav;
  const b = nav?.querySelector<HTMLElement>('.tabb.a');
  if (!nav || !b || !b.offsetWidth) return;
  nav.classList.toggle('lens-move', animate && nav.classList.contains('lens-on'));
  nav.style.setProperty('--lx', `${b.offsetLeft}px`);
  nav.style.setProperty('--ly', `${b.offsetTop}px`);
  nav.style.setProperty('--lw', `${b.offsetWidth}px`);
  nav.style.setProperty('--lh', `${b.offsetHeight}px`);
  nav.classList.add('lens-on');
}

/** The main pane shows nothing (phone: back to the list; wide: an empty state). */
function clearMain(): void {
  if (!shell) return;
  stopScan();
  screenGen++;
  inviteScreenFor = null;
  expecting = false;
  main = { kind: 'none' };
  conv = null;
  gconv = null;
  shell.main.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'mark big' }, icon('chat', 30)), h('p', {}, 'Choose a chat, or add someone.')));
  shell.side.replaceChildren();
  document.body.classList.remove('has-main');
  relockIfLeft();
  void renderList();
}

/** A step (show my code, scan, invite…) in the main pane, with a header and a back button. */
function flow(name: string, title: string, ...nodes: Child[]): void {
  if (!shell) buildShell();
  closeSheets();
  main = { kind: 'flow', name };
  conv = null;
  gconv = null; // a step on screen: no chat is open (read receipts, ticks)
  shell!.main.replaceChildren(
    h('header', { class: 'hd' }, iconBtn('back', 'Back', { 'data-testid': 'back', onclick: () => leaveFlow() }), h('div', { class: 't one-line' }, title)),
    h('div', { class: 'flow' }, ...nodes),
  );
  shell!.side.replaceChildren();
  document.body.classList.add('has-main');
  window.scrollTo(0, 0);
  relockIfLeft();
}

function leaveFlow(): void {
  hosted?.close();
  hosted = null;
  clearMain();
}

function waiting(msg: string, testid?: string): HTMLElement {
  return h('section', { class: 'card pad center', 'data-testid': testid }, h('div', { class: 'spinner' }), h('p', {}, msg));
}

// ---- connections --------------------------------------------------------------------------------

function startHub(): void {
  hub?.stop();
  hub = new Hub(
    meForPeer(),
    myRelays,
    allowedRelays,
    {
      peer: (p, note) => adopt(p, note),
      request: (inv, req) => {
        void renderList();
        toHost('request', { requestId: `${inv.id}:${req.k}`, inviteId: inv.id, id: p2pId(fromB64url(req.k)), name: req.n, note: req.note });
      },
      accepted: (c) => {
        toHost('contact', hostContact(c));
        void connectAfterAccept(c);
      },
      refused: (pnd) => {
        toHost('invite', { state: 'refused', id: pnd.id });
        if (inviteScreenFor === pnd.id) inviteMessage(INVITE_USED_TEXT, true);
      },
      changed: () => void renderList(),
    },
    // Many chats at once: a contact's reconnect is ignored only while I'm in a call with them.
    (id) => !peers.get(id)?.inCallNow,
  );
  // The groups I'm in (signed member lists): members who aren't contacts can still connect (group-member links).
  hub.groupMembers = () => (groups?.list() ?? []).filter((x) => x.status === 'joined').map((x) => ({ gid: x.id, members: x.members }));
  hub.start();
}

const callHost: CallHost = {
  get myKey() {
    return me!.publicKey;
  },
  nameOf: (p) => nameOf(p.peer!),
  pathOf: (p) => p.path,
  showChat: (p) => p.peer && void openConversation(p.peer.id),
  note: (text) => toast(text),
  isNew: (p) => !!p.peer && !trusted.has(p.peer.id),
  logged: (rec) => void addCall(rec).then(() => {
    if (tab === 'calls') void renderList();
  }),
  ended: (p, text, again) => void callEnded(p.peer?.id ?? '', text, again),
  hosted: hostMode,
};

/**
 * A 1:1 call is over and its screen closed by itself: back to their chat, with one line saying how it
 * ended (and "Call again" / "Call back" when it didn't connect). A locked chat stays closed (a toast).
 */
async function callEnded(id: string, text: string, again: { video: boolean } | null): Promise<void> {
  if (!me) return; // signed out (host mode: P2PTalk.stop()) while the call screen closed
  const c = id ? await loadContact(id) : undefined;
  if (!c || (locks.isLocked(id) && !locks.isOpen)) return toast(text);
  if (!(conv?.id === id && main.kind === 'chat')) await openConversation(id);
  if (conv?.id !== id) return toast(text);
  const label = text.startsWith('Missed') ? 'Call back' : 'Call again';
  const at = Date.now();
  conv.list.append(h('div', { class: 'note plain call-note', 'data-testid': 'call-end-note', 'data-ts': String(at) },
    icon(again?.video ? 'video' : 'phone', 14), h('span', {}, `${text} · ${time(at)}`),
    again ? h('button', { class: 'chip', type: 'button', 'data-testid': 'call-again', onclick: () => void callContact(id, again.video) }, label) : null));
  conv.list.scrollTop = conv.list.scrollHeight;
}

/** Take a connection in: wire its events; when it opens, it becomes that contact's connection. */
function adopt(p: Peer, note = ''): void {
  if (note) notes.set(p, note);
  if ((p as unknown as { adopted?: boolean }).adopted) return;
  (p as unknown as { adopted?: boolean }).adopted = true;
  p.otherCallBusy = () => [...peers.values()].some((q) => q !== p && q.inCallNow) || !!gcm?.inCall;
  let id = '';
  const onReady = async () => {
    if (id || !p.peer) return;
    // A known ID with another key is never taken as that contact (no chat, no files, no groups) until
    // the person accepts the new safety code (keyChanged → readyAgain). Checked before anything else.
    const knownKey = contactKeys.get(p.peer.id);
    if (knownKey && knownKey !== toB64url(p.peer.publicKey)) {
      const known = await loadContact(p.peer.id);
      if (known && known.publicKey !== toB64url(p.peer.publicKey)) return keyChanged(p, known);
    }
    // Someone I just deleted, on a connection that was already on its way: not taken back as a contact.
    if (!p.memberOf && wasForgotten(toB64url(p.peer.publicKey)) && !(await loadContact(p.peer.id))) return p.close();
    id = p.peer.id;
    const old = peers.get(id);
    if (old && old !== p) old.close();
    peers.set(id, p);
    lastPeer.set(id, p);
    readyAt.set(p, Date.now());
    attachEngines(id, p); // before any await: no file or group frame is missed
    if (p.memberOf && !(await loadContact(id))) {
      // A group-member link (not a contact): groups, group calls and files only; no chat in Chats.
      void renderList();
      return;
    }
    try {
      contactKeys.set(id, (await rememberContact(p, await myRelays())).publicKey);
    } catch (e) {
      if (e instanceof KeyChanged) {
        // (The cache missed it.) Not this contact: taken out again; Accept reconnects.
        peers.delete(id);
        files.get(id)?.detach();
        p.close();
        return keyChanged(p, e.old);
      }
      throw e;
    }
    toHost('contact', hostPeerContact(p));
    void hub?.refresh();
    inviteScreenFor = null;
    // Host mode: a connection the host asked for (P2PTalk.connect, for online dots) never opens a chat by itself.
    const quiet = hostQuiet.delete(id) && !expecting && !(main.kind === 'chat' && main.id === id);
    // Open its chat if nothing else is on screen, or if a step of mine was waiting for it.
    // Someone joined from my invite while I'm on a step (not in another chat): show them too.
    // A locked chat never opens by itself (it needs the code); it stays in Locked chats.
    if (locks.isLocked(id) && !locks.isOpen) {
      expecting = false;
      void renderList();
    } else if (!quiet && (main.kind === 'none' || expecting || (main.kind === 'chat' && main.id === id) || (notes.get(p) && main.kind !== 'chat'))) {
      expecting = false;
      await openConversation(id);
    } else void renderList();
  };
  readyAgain.set(p, onReady);
  p.on('ready', () => void onReady())
    .on('message', (m) => {
      if (!p.peer) return;
      const from = p.peer.id;
      const key = toB64url(p.peer.publicKey);
      void loadContact(from).then((c) => {
        if (c && c.publicKey !== key) return; // a changed key: nothing until the person accepts it
        if (p.memberOf && !trusted.has(from) && !c) return; // a group-member link: 1:1 text only from a contact
        if (!c && wasForgotten(key)) return; // someone I deleted: their chat doesn't come back by itself
        storeIncoming();
      });
      function storeIncoming(): void {
        void findStoredMessage(from, m.mid).then((dup) => {
          if (dup) return owe(from, [m.mid], 'd'); // a copy sent again after a broken link: kept once
          return locks.store({ peer: from, from: 'them', text: m.text, ts: m.ts, mid: m.mid }).then((key) => {
          owe(from, [m.mid], 'd'); // their device: two grey ticks
          toHost('message', hostMessage(from, 'them', m.mid, m.text, m.ts));
          if (conv?.id === from) {
            appendMessage({ from: 'them', text: m.text, ts: m.ts, mid: m.mid, peer: from });
            void markRead(from, key);
            seenOnScreen(from, m.mid);
          } else if (locks.isLocked(from) && !muted.has(from)) toast('New message'); // a locked chat: no name, no text
          refreshListSoon();
          });
        });
      }
    })
    .on('presence', () => {
      if (id) toHost('contact', hostPeerContact(p));
      if (p.peer && p.isOnline) void flushWaiting(p.peer.id); // they are back: what waited goes now
      if (conv?.id === p.peer?.id) renderPresence();
      if (gconv && groups?.get(gconv.gid)?.members.some((m) => m.p2pId === p.peer?.id)) renderGroupSide(); // online dots
      if (tab === 'chats') void renderList();
    })
    .on('path', () => {
      if (id) toHost('contact', hostPeerContact(p));
      if (conv?.id === p.peer?.id) renderInfo();
    })
    .on('call', (c) => {
      // Accepting their call makes them a known contact (no more "New contact").
      if (!c.outgoing && c.state === 'connecting' && p.peer) void markTrusted(p.peer.id);
      renderCall(p, c, callHost);
      toHost('call', hostCallData(p, c));
    })
    .on('recording', (on) => {
      renderCall(p, p.call, callHost);
      toHost('recording', { contactId: p.peer?.id, on });
    })
    .on('screen', (x) => {
      renderCall(p, p.call, callHost);
      toHost('screen', { contactId: p.peer?.id, ...x });
    })
    // Host mode: the streams (for the host's recording); the host gets only their track kinds.
    .on('localStream', (st) => {
      refreshCallVideos(p);
      toHost('stream', { contactId: p.peer?.id, kind: 'local', stream: st }, { contactId: p.peer?.id, kind: 'local', tracks: st?.getTracks().map((t) => t.kind) ?? [] });
    })
    .on('remoteStream', (st) => {
      refreshCallVideos(p);
      toHost('stream', { contactId: p.peer?.id, kind: 'remote', stream: st }, { contactId: p.peer?.id, kind: 'remote', tracks: st?.getTracks().map((t) => t.kind) ?? [] });
    })
    .on('devices', (l) => {
      if (me && device) void learnMyDevices(me, toB64url(device.publicKey), l).then((list) => toHost('devices', list.map(hostDeviceRow)));
    })
    .on('closed', () => {
      if (id && peers.get(id) === p) {
        peers.delete(id);
        toHost('contact', { ...hostPeerContact(p), online: false, path: { kind: 'offline', label: PATH_TEXT.offline.label } });
        files.get(id)?.detach(); // transfers wait, and resume on the next connection
        if (conv?.id === id) {
          renderPresence();
          renderInfo();
        }
        void renderList();
      }
    });
  if (p.ready && p.peer) void onReady();
}

/** Contacts' keys, for the check on "ready" without waiting for the database (filled at start). */
const contactKeys = new Map<string, string>();
/** Runs a connection's "ready" step again once a changed key was accepted. */
const readyAgain = new WeakMap<Peer, () => Promise<void>>();

/** A known ID came with another key: stop, show both safety codes, and let the person decide. */
function keyChanged(p: Peer, old: Contact): void {
  const info = p.peer!;
  const name = old.name || shortId(old.id);
  flow('key-changed', 'Safety code changed',
    h('section', { class: 'card pad center', 'data-testid': 'key-changed' },
      h('p', { class: 'big' }, `${name}’s safety code changed`),
      h('p', { class: 'muted small' }, 'This P2P ID now comes with a different key. It may be someone else. Check the safety pictures with them before you go on.'),
      h('div', { class: 'lbl' }, 'BEFORE'), h('div', { class: 'pics' }, emojiCode(fromB64url(old.publicKey))),
      h('div', { class: 'lbl' }, 'NOW'), h('div', { class: 'pics', 'data-testid': 'key-changed-new' }, emojiCode(info.publicKey)),
      h('div', { class: 'row2' },
        h('button', { class: 'btn sec2', 'data-testid': 'key-accept', type: 'button', onclick: async () => {
          const c = await rememberContact(p, await myRelays(), true);
          contactKeys.set(c.id, c.publicKey);
          await readyAgain.get(p)?.(); // now taken as that contact (engines, chat)
          await openConversation(info.id);
        } }, 'Accept the new code'),
        h('button', { class: 'btn dang-line', 'data-testid': 'key-block', type: 'button', onclick: async () => {
          p.close();
          await hub?.blockKey(toB64url(info.publicKey));
          leaveFlow();
        } }, 'Block'))));
}

/** They accepted my request: connect now (they are online, they just accepted). */
async function connectAfterAccept(c: Contact): Promise<void> {
  void renderList();
  for (let i = 0; i < 3 && !peers.get(c.id)?.ready; i++) {
    try {
      await reach(c);
      return;
    } catch {
      /* try again */
    }
  }
}

const connectingTo = new Map<string, Promise<Peer>>();

/** Reach a contact through the relays (8 s). Shared by the chat, Call and Calls › call back. */
function reach(c: Contact): Promise<Peer> {
  let job = connectingTo.get(c.id);
  if (!job) {
    if (!hub) return Promise.reject(new Error('offline'));
    job = hub.connectTo(c).then((p) => {
      adopt(p);
      return p;
    });
    connectingTo.set(c.id, job);
    void job.catch(() => undefined).finally(() => connectingTo.delete(c.id));
    if (conv?.id === c.id) renderPresence();
  }
  return job;
}

// ---- lists (the tabs) ------------------------------------------------------------------------------

let listWait: ReturnType<typeof setTimeout> | null = null;
async function renderList(): Promise<void> {
  if (!shell || !me) return;
  // A row is being held or is swiped open: redraw a moment later (now it would undo the gesture).
  if (listBusy()) {
    listWait ??= setTimeout(() => {
      listWait = null;
      void renderList();
    }, 400);
    return;
  }
  const gen = ++listGen;
  const body = await ({ chats: chatsTab, groups: groupsTab, calls: callsTab, add: addTab, me: meTab } as const)[tab]();
  if (gen !== listGen || !shell) return;
  shell.list.replaceChildren(...(body.filter(Boolean) as Node[]));
  void tabBadges();
}

/** Unread counts on the Chats and Groups tab icons (Groups also counts group invites waiting). */
async function tabBadges(): Promise<void> {
  if (!shell || !me) return;
  const [contacts, marks] = await Promise.all([loadContacts(), loadReadMarks()]);
  let chats = 0;
  let gs = 0;
  // Muted chats are not counted on the tab (their own row still shows its count, in grey).
  for (const c of contacts) if (!muted.has(c.id)) chats += unreadIn(await loadStoredMessages(c.id), marks[c.id]);
  for (const g of groups?.list() ?? []) {
    if (g.status === 'invited') gs++;
    else if (g.status === 'joined' && !muted.has(`g:${g.id}`)) gs += unreadIn(await loadStoredMessages(`g:${g.id}`), marks[`g:${g.id}`]);
  }
  const set = (t: Tab, n: number) => {
    const b = shell?.nav.querySelector<HTMLElement>(`.t-${t} .tbadge`);
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
    shell!.nav.querySelector(`.t-${t}`)?.setAttribute('aria-label', n ? `${t === 'chats' ? 'Chats' : 'Groups'}, ${n} unread` : t === 'chats' ? 'Chats' : 'Groups');
  };
  set('chats', chats);
  set('groups', gs);
}
let listGen = 0;

function listHead(title: string, ...right: Child[]): HTMLElement {
  return h('header', { class: 'hd' }, h('div', { class: 't one-line' }, title), ...right);
}

/** Redraws the list soon (once for many events): keeps the previews current, also beside an open chat. */
let listTimer: ReturnType<typeof setTimeout> | null = null;
function refreshListSoon(): void {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void renderList();
  }, 250);
}

/** One line under a chat's name: the last message (or file), from me or them. */
function previewOf(last: ChatMessage | undefined, group: boolean): string {
  if (!last) return '';
  if (last.locked) return 'Locked message';
  if (last.note) return last.text;
  const who = last.from === 'me' ? 'You: ' : group ? `${last.fromName || 'Someone'}: ` : '';
  return `${who}${last.file ? last.file.name : last.text}`;
}

const unreadIn = (msgs: ChatMessage[], mark = 0) => msgs.filter((m) => m.from === 'them' && !m.note && (m.key ?? 0) > mark).length;

async function chatsTab(): Promise<Child[]> {
  await locks.ready;
  const [contacts, marks] = await Promise.all([loadContacts(), loadReadMarks()]);
  const requests = [...(hub?.requests ?? new Map<string, { req: ContactRequest }>())];
  const rows: Node[] = [];
  for (const [key, { req, invite }] of requests as [string, { req: ContactRequest; invite?: { kind?: string } }][]) {
    const id = p2pId(fromB64url(req.k));
    rows.push(h('div', { class: 'row req', 'data-testid': 'request' },
      avatar(req.n || '?', id),
      h('div', { class: 'b' },
        h('div', { class: 'n', 'data-testid': 'request-text' }, invite?.kind === 'id' ? `${req.n || 'Someone'} wants to talk` : `${req.n || 'Someone'} joined from your invite`),
        h('div', { class: 'm' }, req.note ? `“${req.note}”` : formatId(id))),
      h('div', { class: 'acts' },
        h('button', { class: 'chip ok', 'data-testid': 'accept-request', type: 'button', onclick: async () => {
          const c = await hub?.accept(key);
          if (c) toHost('contact', hostContact(c));
          void renderList();
        } }, 'Accept'),
        h('button', { class: 'chip', 'data-testid': 'block-request', type: 'button', onclick: async () => {
          await hub?.block(key);
          void renderList();
        } }, 'Block'),
        h('button', { class: 'chip', 'data-testid': 'report-request', type: 'button', onclick: () => void reportPerson(req.n || 'this person', id, async () => {
          await hub?.block(key);
          await hub?.blockKey(req.k);
          void renderList();
        }) }, 'Report'))));
  }
  // Someone I deleted (Delete chat) tried to reconnect: asked like any new request, never taken back by itself.
  for (const d of hub?.againRequests.values() ?? []) {
    if (contacts.some((c) => c.publicKey === d.publicKey)) continue;
    rows.push(h('div', { class: 'row req', 'data-testid': 'again-request' },
      avatar(d.name || '?', d.id),
      h('div', { class: 'b' },
        h('div', { class: 'n', 'data-testid': 'request-text' }, `${d.name || 'Someone'} wants to talk again`),
        h('div', { class: 'm' }, 'You deleted this chat. Accept to talk again.')),
      h('div', { class: 'acts' },
        h('button', { class: 'chip ok', 'data-testid': 'accept-again', type: 'button', onclick: async () => {
          forgotten.delete(d.publicKey);
          const c = await hub?.acceptAgain(d.publicKey);
          if (c) {
            contactKeys.set(c.id, c.publicKey);
            void connectAfterAccept(c);
          }
          void renderList();
        } }, 'Accept'),
        h('button', { class: 'chip', 'data-testid': 'block-again', type: 'button', onclick: async () => {
          await hub?.blockAgain(d.publicKey);
          void renderList();
        } }, 'Block'))));
  }
  // Locked chats are not listed here: one "Locked chats" row at the top, opened with the secret code.
  // Locked groups stay in Groups (as "Locked"); this row is for locked 1:1 chats.
  const locked = locks.chats.filter((id) => !id.startsWith('g:') && contacts.some((c) => c.id === id));
  if (locked.length) {
    let unread = 0;
    for (const id of locked) unread += unreadIn(await loadStoredMessages(id), marks[id]);
    rows.unshift(h('button', { class: 'row locked-row', 'data-testid': 'locked-chats', type: 'button', onclick: () => openLockedChats() },
      h('div', { class: 'av lock-av', 'aria-hidden': 'true' }, icon('lock', 20)),
      h('div', { class: 'b' }, h('div', { class: 'n' }, 'Locked chats'), h('div', { class: 'm' }, locks.isOpen ? 'Open · locks when you leave' : `${locked.length} ${locked.length === 1 ? 'chat' : 'chats'} · secret code`)),
      h('div', { class: 'r' }, unread ? h('span', { class: 'badge', 'data-testid': 'locked-unread' }, String(unread)) : icon('right', 20, 'chev'))));
  }
  rows.push(...(await chatRows(contacts.filter((c) => !locks.isLocked(c.id)), [], marks)));
  if (!rows.length) {
    rows.push(h('div', { class: 'empty small-empty' },
      h('p', {}, 'No chats yet.'),
      h('button', { class: 'btn pri', type: 'button', onclick: () => setTab('add') }, 'Add someone')));
  }
  return [listHead('Chats', iconBtn('plus', 'Add someone', { class: 'ib soft', 'data-testid': 'chats-add', onclick: () => setTab('add') })), wordsBanner(), h('div', { class: 'list' }, ...rows)];
}

/** Groups: invites waiting, then every group, newest first. Locked groups show "Locked" and open with the code. */
async function groupsTab(): Promise<Child[]> {
  await locks.ready;
  const marks = await loadReadMarks();
  const rows: Node[] = [];
  for (const g of groups?.list() ?? []) {
    if (g.status !== 'invited') continue;
    rows.push(h('div', { class: 'row req', 'data-testid': 'group-invite' },
      avatar(g.name, g.id),
      h('div', { class: 'b' }, h('div', { class: 'n', 'data-testid': 'group-invite-text' }, `${memberName(g, g.createdBy)} added you to ${g.name}`), h('div', { class: 'm' }, `${g.members.length} members`)),
      h('div', { class: 'acts' },
        h('button', { class: 'chip ok', 'data-testid': 'group-join', type: 'button', onclick: async () => {
          await groups?.acceptInvite(g.id);
          await saveGroupsNow();
          void openGroup(g.id);
        } }, 'Join'),
        h('button', { class: 'chip', 'data-testid': 'group-decline', type: 'button', onclick: async () => {
          await groups?.declineInvite(g.id);
          await saveGroupsNow();
          void renderList();
        } }, 'Decline'))));
  }
  // Groups I left (or was removed from) stay listed with their history, until Delete group.
  rows.push(...(await chatRows([], (groups?.list() ?? []).filter((g) => g.status === 'joined' || g.status === 'left' || g.status === 'removed'), marks)));
  const newGroup = () => void newGroupScreen();
  if (!rows.length) {
    rows.push(h('div', { class: 'empty small-empty', 'data-testid': 'groups-empty' },
      h('div', { class: 'oi grad big-oi', 'aria-hidden': 'true' }, icon('users', 28)),
      h('p', { class: 'big' }, 'Start your first group'),
      h('p', { class: 'muted small' }, 'Family, friends or a team: talk and call together, straight between your devices.'),
      iconBtn('users-plus', 'New group', { class: 'btn pri with-icon', 'data-testid': 'groups-empty-new', onclick: newGroup }, 'New group')));
  }
  return [listHead('Groups', iconBtn('users-plus', 'New group', { class: 'ib soft', 'data-testid': 'groups-new', onclick: newGroup })), h('div', { class: 'list' }, ...rows)];
}

/** The rows of these chats (contacts and joined groups), newest first, with their last message. */
async function chatRows(contacts: Contact[], gs: GroupInfo[], marks: Record<string, number>): Promise<Node[]> {
  const items: { at: number; row: Node }[] = [];
  for (const g of gs) {
    const gid = `g:${g.id}`;
    // A locked group (code not typed): its name and time only, never a preview.
    const closed = locks.isLocked(gid) && !locks.isOpen;
    const msgs = closed ? await loadStoredMessages(gid) : ((await locks.read(gid)) ?? []);
    const last = msgs.reduce<ChatMessage | undefined>((a, m) => (!a || m.ts >= a.ts ? m : a), undefined);
    const unread = unreadIn(msgs, marks[gid]);
    const isIn = g.status === 'joined';
    const callOn = isIn && !!gcm?.joinable(g.id).length;
    const line = callOn
      ? h('div', { class: 'm callon', 'data-testid': 'group-call-on' }, icon('phone', 14), h('span', {}, 'Call on · Join'))
      : closed
        ? h('div', { class: 'm with-icon', 'data-testid': 'chat-preview' }, icon('lock', 14), h('span', {}, 'Locked'))
        : !isIn
          ? h('div', { class: 'm', 'data-testid': 'chat-preview' }, g.status === 'removed' ? 'You were removed' : 'You left')
          : h('div', { class: 'm', 'data-testid': 'chat-preview' }, previewOf(last, true) || `${g.members.length} members`);
    const row = h('button', { class: `row${gconv?.gid === g.id ? ' sel' : ''}`, 'data-testid': 'group', 'data-locked': locks.isLocked(gid) ? '1' : undefined, 'data-left': isIn ? undefined : '1', type: 'button', onclick: () => void openGroup(g.id) },
      avatar(g.name, g.id),
      h('div', { class: 'b' }, rowName(g.name, 'group-name', gid), line),
      h('div', { class: 'r' }, last ? shortWhen(last.ts) : '', unread ? h('span', { class: `badge${muted.has(gid) ? ' muted' : ''}`, 'data-testid': 'unread' }, String(unread)) : null));
    items.push({ at: last?.ts ?? 0, row: withActions(row, {
      menu: () => groupMenu(g.id),
      swipe: isIn
        ? { label: 'Leave group', icon: 'log-out', testid: 'swipe-leave', act: () => leaveGroupAsk(g.id) }
        : { label: 'Delete group', icon: 'trash', testid: 'swipe-delete', act: () => deleteGroupAsk(g.id) },
    }) });
  }
  for (const c of contacts) {
    const msgs = (await locks.read(c.id)) ?? [];
    const last = msgs.at(-1);
    const unread = unreadIn(msgs, marks[c.id]);
    const online = !!peers.get(c.id)?.isOnline;
    const at = Math.max(last?.ts ?? 0, c.lastSeen);
    const row = h('button', { class: `row${conv?.id === c.id ? ' sel' : ''}`, 'data-testid': 'contact', type: 'button', onclick: () => void openConversation(c.id) },
      avatar(c.name || '?', c.id, 44, online),
      h('div', { class: 'b' }, rowName(c.name || shortId(c.id), 'contact-name', c.id), h('div', { class: 'm', 'data-testid': 'chat-preview' }, previewOf(last, false) || (online ? 'Online' : 'No messages yet'))),
      h('div', { class: 'r' }, shortWhen(at), unread ? h('span', { class: `badge${muted.has(c.id) ? ' muted' : ''}`, 'data-testid': 'unread' }, String(unread)) : null));
    items.push({ at, row: withActions(row, { menu: () => chatMenu(c), swipe: { label: 'Delete chat', icon: 'trash', testid: 'swipe-delete', act: () => deleteChatAsk(c) } }) });
  }
  return items.sort((a, b) => b.at - a.at).map((i) => i.row);
}

/** One tap: read the clipboard (only now, never by itself) and use a copied ID or link. */
async function smartPaste(): Promise<void> {
  let text = '';
  try {
    text = (await navigator.clipboard?.readText()) ?? '';
  } catch {
    /* not allowed: paste by hand */
  }
  if (cardTextFrom(text) || /P2P1\./.test(text)) return useTheirCode(text);
  if (extractId(text)) return typeIdScreen(text, true);
  if (!text) return typeIdScreen('', false);
  toast('No P2P ID or link copied. Copy their ID or link first.');
}

async function callsTab(): Promise<Child[]> {
  const calls = await loadCalls();
  const rows = calls.slice(0, 60).map((c) => {
    const missed = c.result === 'missed' || (!c.outgoing && c.result === 'declined');
    const what = c.result === 'missed' ? 'Missed' : c.result === 'failed' ? 'Didn’t connect' : c.result === 'declined' ? (c.outgoing ? 'Declined' : 'You declined') : c.outgoing ? 'Outgoing' : 'Incoming';
    // How long it lasted sits on the right under the time, so the line never cuts it off on a phone.
    const mins = c.result === 'ended' ? `${Math.max(1, Math.round(c.seconds / 60))} min` : '';
    const row = h('div', { class: 'row', 'data-testid': 'call-row', 'data-ts': String(c.ts), tabindex: '0', role: 'group', 'aria-label': `${c.name || shortId(c.peer)}, ${c.video ? 'video' : 'voice'} call, ${what}` },
      avatar(c.name || '?', c.peer),
      h('div', { class: 'b' },
        h('div', { class: `n${missed ? ' missed' : ''}` }, c.name || shortId(c.peer)),
        h('div', { class: 'm with-icon' }, icon(c.outgoing ? 'call-out' : 'call-in', 14), h('span', { class: 'one-line' }, `${c.video ? 'Video' : 'Voice'} · ${what}`))),
      h('div', { class: 'r' }, shortWhen(c.ts), mins ? h('span', { class: 'dur', 'data-testid': 'call-minutes' }, mins) : null),
      iconBtn(c.video ? 'video' : 'phone', c.video ? 'Video call' : 'Voice call', { 'data-testid': 'call-back', onclick: () => void callContact(c.peer, c.video) }));
    return withActions(row, { menu: () => callMenu(c), swipe: { label: 'Remove', icon: 'trash', testid: 'swipe-remove', act: () => removeCallAsk(c) } });
  });
  const clearAll = calls.length ? h('button', { class: 'chip clear-all', type: 'button', 'data-testid': 'calls-clear', onclick: () => clearCallsAsk() }, 'Clear all') : null;
  return [listHead('Calls', clearAll), h('div', { class: 'list' }, ...(rows.length ? rows : [h('div', { class: 'empty small-empty' }, h('p', { class: 'big' }, 'No calls yet'), h('p', { class: 'muted small' }, 'Open a chat and tap the phone or camera.'))]))];
}

// ---- list row options: hold / right-click / swipe (design approved 23 Oct 2026) --------------------
// Everything here happens on this device only (there is no server): the other person's copy is theirs.

/** A row's name, with a small bell-off icon when the chat is muted. */
function rowName(name: string, testid: string, chat: string): HTMLElement {
  if (!muted.has(chat)) return h('div', { class: 'n', 'data-testid': testid }, name);
  return h('div', { class: 'n with-mute' }, h('span', { 'data-testid': testid }, name),
    h('span', { class: 'mute-ic', 'data-testid': 'muted-icon', title: 'Muted', role: 'img', 'aria-label': 'Muted' }, icon('bell-off', 14)));
}

/** Asks once before something that can't be undone: a red button, and Cancel. */
function confirmSheet(action: string, title: string, text: string, button: string, act: () => Promise<void>): void {
  closeSheets();
  const err = errorBox();
  const s = sheet('confirm-sheet',
    h('h2', {}, title),
    h('p', { class: 'muted' }, text),
    err.el,
    h('button', { class: 'btn dang-fill', type: 'button', 'data-testid': 'confirm-yes', 'data-action': action, onclick: async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      try {
        await act();
        s.remove();
      } catch (x) {
        b.disabled = false;
        err.set((x as Error)?.message || 'That didn’t work. Please try again.');
      }
    } }, button),
    h('button', { class: 'btn sec2', type: 'button', 'data-testid': 'confirm-cancel', onclick: () => s.remove() }, 'Cancel'));
  s.querySelector('.sheet')?.classList.add('confirm-sheet');
}

/** The options sheet's top: who or which group it is about. */
function menuHead(name: string, id: string, sub: string): HTMLElement {
  return h('div', { class: 'menu-head' }, avatar(name, id, 44), h('div', { class: 'wt', style: 'min-width:0' }, h('h2', { class: 'n' }, name), sub ? h('div', { class: 's' }, sub) : null));
}

function menuSheet(testid: string, head: HTMLElement, ...items: Child[]): void {
  closeSwiped();
  closeSheets();
  const s = sheet(testid, head, h('div', { class: 'card' }, ...items), h('button', { class: 'btn sec2', type: 'button', 'data-testid': 'menu-cancel', onclick: () => s.remove() }, 'Cancel'));
  s.querySelector<HTMLElement>('.menu-item')?.focus();
}

/** Chats › hold a chat: Mute · Clear chat · Delete chat · Block. */
function chatMenu(c: Contact): void {
  const name = c.name || shortId(c.id);
  const isMuted = muted.has(c.id);
  menuSheet('chat-menu', menuHead(name, c.id, locks.isLocked(c.id) ? 'Locked chat' : ''),
    menuItem(isMuted ? 'bell' : 'bell-off', isMuted ? 'Unmute' : 'Mute', 'menu-mute', () => void toggleMute(c.id)),
    menuItem('eraser', 'Clear chat', 'menu-clear', () => clearChatAsk(c.id, name)),
    menuItem('trash', 'Delete chat', 'menu-delete', () => deleteChatAsk(c), true),
    menuItem('block', 'Block', 'menu-block', () => blockAsk(c), true));
}

/** Groups › hold a group: Mute · Clear chat · Leave group (or Delete group once I'm not in it). */
function groupMenu(gid: string): void {
  const g = groups?.get(gid);
  if (!g) return;
  const chat = `g:${gid}`;
  const isIn = g.status === 'joined';
  const isMuted = muted.has(chat);
  menuSheet('group-menu', menuHead(g.name, gid, isIn ? `${g.members.length} members` : g.status === 'removed' ? 'You were removed' : 'You left'),
    menuItem(isMuted ? 'bell' : 'bell-off', isMuted ? 'Unmute' : 'Mute', 'menu-mute', () => void toggleMute(chat)),
    menuItem('eraser', 'Clear chat', 'menu-clear', () => clearChatAsk(chat, g.name)),
    isIn
      ? menuItem('log-out', 'Leave group', 'menu-leave', () => leaveGroupAsk(gid), true)
      : menuItem('trash', 'Delete group', 'menu-delete-group', () => deleteGroupAsk(gid), true));
}

/** Calls › hold a call: Call again · Remove from list. */
function callMenu(c: CallRecord): void {
  const name = c.name || shortId(c.peer);
  menuSheet('call-menu', menuHead(name, c.peer, `${c.video ? 'Video' : 'Voice'} call · ${when(c.ts)}`),
    menuItem(c.video ? 'video' : 'phone', 'Call again', 'menu-call', () => {
      closeSheets();
      void callContact(c.peer, c.video);
    }),
    menuItem('trash', 'Remove from list', 'menu-remove', () => removeCallAsk(c), true));
}

async function toggleMute(chat: string): Promise<void> {
  const on = !muted.has(chat);
  await setMuted(chat, on);
  if (on) muted.add(chat);
  else muted.delete(chat);
  closeSheets();
  toast(on ? 'Muted. You won’t get alerts for this chat.' : 'Unmuted');
  void renderList();
}

/** A locked chat's data is only touched with the code typed (its files' names are sealed). */
function withCode(chat: string, then: () => void): void {
  if (locks.isLocked(chat) && !locks.isOpen) {
    closeSheets();
    return askCode(then);
  }
  then();
}

/** The received files the other chats still show (a file in two chats stays for the other one). */
async function filesElsewhere(chat: string): Promise<ChatFiles> {
  const out: ChatFiles = { native: [], opfs: [] };
  const chats = [...(await loadContacts()).map((c) => c.id), ...(groups?.list() ?? []).map((g) => `g:${g.id}`)].filter((x) => x !== chat);
  for (const id of chats) {
    const f = filesOf(await loadStoredMessages(id), locks.isLocked(id) && locks.isOpen ? await locks.read(id).catch(() => null) : null);
    out.native.push(...f.native);
    out.opfs.push(...f.opfs);
  }
  return out;
}

/** Deletes a chat's messages and the received files they keep on this device. */
function wipeChat(chat: string): Promise<number> {
  return clearChatData(chat, {
    stored: loadStoredMessages,
    opened: (id) => locks.read(id),
    deleteMessages: deleteChatMessages,
    removeNative: removeReceivedFile,
    removeOpfs: removeOpfsFile,
    inUseElsewhere: filesElsewhere,
  });
}

function clearChatAsk(chat: string, name: string): void {
  withCode(chat, () => confirmSheet('clear', `Clear chat with ${name}?`,
    `This deletes the messages and the files you received in this chat from this device. ${chat.startsWith('g:') ? 'You stay in the group.' : `${name} stays in your chats.`}`,
    'Clear chat', async () => {
      await wipeChat(chat);
      // The open chat shows it at once (its messages are gone).
      if (conv?.id === chat) {
        conv.list.replaceChildren();
        await openConversation(chat).catch(() => undefined);
      } else if (gconv && `g:${gconv.gid}` === chat) {
        const gid = gconv.gid;
        gconv = null;
        await openGroup(gid);
      }
      toast('Chat cleared');
      afterListChange();
    }));
}

function deleteChatAsk(c: Contact): void {
  const name = c.name || shortId(c.id);
  const first = name.split(' ')[0];
  withCode(c.id, () => confirmSheet('delete', `Delete chat with ${name}?`,
    `This removes the chat and its messages from this device. ${first} can add you again.`,
    'Delete chat', async () => {
      await deleteChat(c);
      toast('Chat deleted');
    }));
}

/** Delete chat: the person, their messages and received files go from this device; not blocked. */
async function deleteChat(c: Contact): Promise<void> {
  const id = c.id;
  forgotten.set(c.publicKey, Date.now());
  const p = peers.get(id);
  peers.delete(id);
  p?.close();
  lastPeer.delete(id);
  files.get(id)?.detach();
  files.delete(id);
  photoLinks.delete(id);
  trusted.delete(id);
  contactKeys.delete(id);
  await wipeChat(id);
  await locks.dropChat(id);
  if (hub) await hub.forgetContact(c);
  else await deleteContact(id);
  if (muted.delete(id)) await setMuted(id, false);
  delete pics[id];
  await deletePic(id);
  setAvatarPhoto(id, null);
  if (conv?.id === id || (main.kind === 'chat' && main.id === id)) clearMain();
  afterListChange();
}

/** The lists changed: redraw them (and the Locked chats screen, if that is where the person is). */
function afterListChange(): void {
  void renderList();
  if (main.kind === 'flow' && main.name === 'locked-chats') void lockedChatsScreen();
}

function blockAsk(c: Contact): void {
  const name = c.name || shortId(c.id);
  confirmSheet('block', `Block ${name}?`, 'They can’t reach you any more, and they are removed from your contacts.', 'Block', async () => {
    peers.get(c.id)?.close();
    await hub?.blockContact(c);
    if (conv?.id === c.id) clearMain();
    void renderList();
  });
}

function leaveGroupAsk(gid: string): void {
  const g = groups?.get(gid);
  if (!g) return;
  confirmSheet('leave', `Leave ${g.name}?`, 'You won’t get new messages from this group. Its chat stays on this device until you delete it.', 'Leave group', async () => {
    await groups?.leave(gid);
    await saveGroupsNow();
    if (gconv?.gid === gid) {
      gconv = null;
      await openGroup(gid); // the chat stays open, saying "You left this group"
    }
    void renderList();
  });
}

function deleteGroupAsk(gid: string): void {
  const g = groups?.get(gid);
  if (!g) return;
  withCode(`g:${gid}`, () => confirmSheet('delete-group', `Delete ${g.name}?`, 'This removes the group and its messages from this device. If someone adds you again, you can join again.', 'Delete group', async () => {
    const chat = `g:${gid}`;
    if (!(await groups?.forget(gid))) throw new Error('Leave the group first.');
    await saveGroupsNow();
    await wipeChat(chat);
    await locks.dropChat(chat);
    if (muted.delete(chat)) await setMuted(chat, false);
    delete pics[chat];
    await deletePic(chat);
    if (gconv?.gid === gid || (main.kind === 'chat' && main.id === chat)) clearMain();
    toast('Group deleted');
    void renderList();
  }));
}

function removeCallAsk(c: CallRecord): void {
  const name = c.name || shortId(c.peer);
  confirmSheet('remove-call', 'Remove this call from the list?', `The ${c.video ? 'video' : 'voice'} call with ${name} on ${when(c.ts)} is removed from this device.`, 'Remove', async () => {
    await removeCall(c);
    void renderList();
  });
}

function clearCallsAsk(): void {
  confirmSheet('clear-calls', 'Clear all calls?', 'This removes every call from the Calls list on this device. Your chats stay.', 'Clear all', async () => {
    await clearCalls();
    void renderList();
  });
}

function opt(iconName: IconName, title: string, sub: string, testid: string, onclick: () => void, grad = false): HTMLElement {
  return h('button', { class: 'opt', 'data-testid': testid, type: 'button', onclick },
    h('div', { class: `oi${grad ? ' grad' : ''}` }, icon(iconName)),
    h('div', { class: 'b' }, h('div', { class: 'n' }, title), h('div', { class: 'm' }, sub)),
    icon('right', 22, 'chev'));
}

async function addTab(): Promise<Child[]> {
  const invites = await loadInvites();
  const now = Date.now();
  const waitingN = invites.filter((i) => i.status === 'waiting' && i.expires > now).length;
  const usedN = invites.filter((i) => i.status === 'used').length;
  return [
    listHead('Add someone'),
    h('div', { class: 'stack' },
      h('div', { class: 'card' },
        opt('scan', 'Scan their code', 'When you’re together', 'scan-their-code', () => scanScreen('Scan their code', (t) => void useTheirCode(t)), true),
        opt('qr', 'Show my code', 'They scan it once', 'show-my-code', () => void showCard()),
        opt('link', 'Send an invite link', 'By message or email · 24 h', 'share-invite', () => inviteScreen()),
        opt('hash', 'Type their P2P ID', '24 digits · paste their ID', 'type-id', () => typeIdScreen()),
        opt('users-plus', 'New group', 'From your contacts', 'new-group', () => void newGroupScreen())),
      h('button', { class: 'card opt-row', 'data-testid': 'my-invites', type: 'button', onclick: () => void invitesScreen() },
        icon('link', 22, 'soft'),
        h('div', { class: 'b' }, 'My invites', h('div', { class: 'm' }, invites.length ? `${waitingN} waiting · ${usedN} used` : 'None yet')),
        icon('right', 22, 'chev')),
      iconBtn('copy', 'Paste a copied ID or link', { class: 'chipbig', 'data-testid': 'smart-paste', onclick: () => void smartPaste() }, 'Paste a copied ID or link'),
      h('div', { class: 'links' },
        h('button', { class: 'link', 'data-testid': 'paste-their-code', type: 'button', onclick: () => pasteScreen('Paste their code', (t) => useTheirCode(t)) }, 'Paste a code or link'),
        h('button', { class: 'link', 'data-testid': 'two-step', type: 'button', onclick: () => void showMyCode() }, 'No internet? Use two-step codes'))),
  ];
}

function wordsBanner(): Child {
  if (!unsavedWords) return null;
  return h('button', { class: 'banner', 'data-testid': 'save-words-banner', type: 'button', onclick: () => void wordsScreen() },
    icon('key', 20), h('span', { class: 'b' }, 'Save your 24 words to keep this account'), icon('right', 20, 'chev'));
}

function kvRow(iconName: IconName, label: string, value: string, testid: string, onclick?: () => void): HTMLElement {
  return h(onclick ? 'button' : 'div', { class: `kv${onclick ? ' tap' : ' soon'}`, 'data-testid': testid, type: onclick ? 'button' : undefined, onclick },
    icon(iconName), h('div', { class: 'k' }, label), value ? h('div', { class: 'v one-line' }, value) : null, onclick ? icon('right', 22, 'chev') : null);
}

async function meTab(): Promise<Child[]> {
  const [others, findable] = await Promise.all([loadMyDevices(), hub?.findable() ?? false]);
  const deviceNames = [device?.name ?? '', ...others.map((d) => d.cert.dn)].filter(Boolean).join(', ');
  return [
    listHead('Me'),
    wordsBanner(),
    h('div', { class: 'stack' },
      h('div', { class: 'idcard' },
        h('div', { class: 'idtop' },
          h('button', { class: 'av-btn', type: 'button', 'data-testid': 'me-photo', 'aria-label': 'Profile photo', title: 'Profile photo', onclick: () => photoMenu(null) },
            avatar(me!.name || 'Me', myId(), 48), h('span', { class: 'av-edit', 'aria-hidden': 'true' }, icon('camera', 13))),
          h('div', { class: 'b' },
            h('div', { class: 'n one-line', 'data-testid': 'my-name' }, me!.name || 'No name'),
            h('div', { class: 'm one-line', 'data-testid': 'my-device-line' }, `This device: ${device?.name ?? ''}`)),
          iconBtn('qr', 'Show my code', { class: 'ib soft', 'data-testid': 'me-qr', onclick: () => void showCard() })),
        myIdBlock(findable),
        h('div', { class: 'pics', 'data-testid': 'my-emoji', title: 'Your safety pictures' }, emojiCode(me!.publicKey)),
        me!.guest ? h('p', { class: 'notice small', 'data-testid': 'guest-badge' }, 'Guest on this browser only. If you clear the browser, this account is gone.') : null),
      h('div', { class: 'card' },
        kvRow('mobile', 'My devices', deviceNames, 'me-devices', () => devicesScreen()),
        kvRow('lock', 'Chat lock', locks.isSet ? `On · ${locks.chats.length} ${locks.chats.length === 1 ? 'chat' : 'chats'}` : 'Off', 'me-chat-lock', () => chatLockScreen()),
        kvRow('eye', 'Privacy', findable ? 'Findable by ID' : '', 'me-privacy', () => void privacyScreen()),
        // Host mode: the 24 words, signing out and deleting the account are the host app's (Vilnek OS).
        hostMode ? null : kvRow('key', 'My 24 words', me!.guest ? 'Guest' : '', 'me-words', () => wordsScreen()),
        kvRow('globe', 'Network & relays', '', 'me-network', () => void networkScreen())),
      hostMode
        ? h('p', { class: 'notice small center', 'data-testid': 'host-managed' }, 'Account managed by Vilnek OS')
        : h('button', { class: 'btn dang-line', 'data-testid': 'delete-account', type: 'button', onclick: () => deleteAccountSheet() }, 'Delete my account and data'),
      termsLine()),
  ];
}

// ---- Me: devices, privacy, words, network ---------------------------------------------------------

async function devicesScreen(): Promise<void> {
  const others = await loadMyDevices();
  const devName = h('input', { class: 'field', maxlength: '32', 'data-testid': 'my-device-name', 'aria-label': 'This device’s name' }) as HTMLInputElement;
  devName.value = device?.name ?? '';
  const saved = h('span', { class: 'muted small', 'data-testid': 'device-saved' });
  flow('devices', 'My devices',
    h('div', { class: 'sec' }, 'THIS DEVICE'),
    h('div', { class: 'card pad', 'data-testid': 'my-devices' },
      h('div', { class: 'row tight' }, devName,
        h('button', { class: 'btn sec2 small', 'data-testid': 'save-device-name', type: 'button', onclick: async () => {
          const n = cleanDeviceName(devName.value);
          if (!n || !me || !device) return;
          device = renameDevice(me.secretKey, me.publicKey, device, n);
          await saveDevice(device);
          startHub(); // new certificate for the next connections
          saved.textContent = 'Saved';
        } }, 'Save')),
      h('div', { class: 'muted small' }, 'Device code ', h('span', { class: 'mono', 'data-testid': 'my-device-code' }, device ? deviceCode(device.publicKey) : ''), ' ', saved)),
    others.length ? h('div', { class: 'sec' }, 'YOUR OTHER DEVICES (SEEN BY YOUR CONTACTS)') : null,
    others.length
      ? h('div', { class: 'card' }, ...others.map((d) => h('div', { class: 'kv', 'data-testid': 'other-device' },
          icon('laptop'), h('div', { class: 'k' }, d.cert.dn || 'Device', h('div', { class: 'muted small mono' }, deviceCode(d.cert.dk))), h('div', { class: 'v' }, shortWhen(d.seen)))))
      : null,
    hostMode
      ? h('p', { class: 'muted small', 'data-testid': 'host-managed-devices' }, 'Account managed by Vilnek OS. Each device keeps its own name and key; your P2P ID stays the same. Contacts see which device they are talking to.')
      : me?.guest
      ? h('p', { class: 'notice small' }, 'Guest on this browser only. If you clear the browser, this account is gone. (Turning a guest into a 24-word account is planned.)')
      : h('p', { class: 'muted small' }, 'Use your 24 words to add this account to another device. Each device keeps its own name and key; your P2P ID stays the same. Contacts see which device they are talking to.'));
}

async function privacyScreen(): Promise<void> {
  const on = !!(await hub?.findable());
  const box = h('input', { type: 'checkbox', checked: on, 'data-testid': 'findable-toggle', onchange: async () => {
    await hub?.setFindable(box.checked);
    toast(box.checked ? 'People who have your ID can now send you a request.' : 'Not findable by ID any more.');
  } }) as HTMLInputElement;
  flow('privacy', 'Privacy',
    h('div', { class: 'card' },
      h('label', { class: 'kv tap' }, icon('hash'), h('div', { class: 'k' }, 'Findable by my ID', h('div', { class: 'muted small' }, 'People who have your 24-digit ID can send you a request. You choose who to accept.')), box)),
    h('div', { class: 'card pad' },
      h('p', {}, 'Only people you accept can reach you: someone who scanned your code, or whose invite request you accepted.'),
      h('p', { class: 'muted small' }, 'Chats and calls go straight between the two devices, locked. Public relays only help two devices find each other: they see locked notes and your internet address, never what you say.')),
    h('div', { class: 'card' },
      h('label', { class: 'kv tap' }, icon('image'), h('div', { class: 'k' }, 'Who can see my photo', h('div', { class: 'muted small' }, 'Sent only straight to the people you talk with, never to the relays.')),
        (() => {
          const sel = h('select', { class: 'field small-select', 'data-testid': 'photo-visibility', 'aria-label': 'Who can see my photo', onchange: async () => {
            photoVis = sel.value === 'nobody' ? 'nobody' : 'contacts';
            await savePhotoVisibility(photoVis);
            announcePicture();
          } }, h('option', { value: 'contacts' }, 'My contacts'), h('option', { value: 'nobody' }, 'Nobody')) as HTMLSelectElement;
          sel.value = photoVis;
          return sel;
        })())),
    h('div', { class: 'card' },
      h('label', { class: 'kv tap' }, icon('ticks'), h('div', { class: 'k' }, 'Read receipts', h('div', { class: 'muted small' }, 'Off: you don’t send blue ticks, and you don’t see others’ either. Delivered ticks always go.')),
        (() => {
          const box = h('input', { type: 'checkbox', checked: readReceipts, 'data-testid': 'read-receipts', onchange: async () => {
            readReceipts = box.checked;
            await saveReadReceipts(readReceipts);
          } }) as HTMLInputElement;
          return box;
        })())),
    h('div', { class: 'sec' }, 'CHAT LOCK'),
    h('div', { class: 'card' },
      locks.isSet
        ? kvRow('key', 'Change secret code', '', 'change-code', () => changeCodeSheet())
        : kvRow('lock', 'Chat lock', 'Off', 'privacy-chat-lock', () => chatLockScreen())));
}

// ---- chat lock (plan §8.7): one secret code for all locked chats on this device ---------------------

/** A code box: digits or a passphrase, hidden while typed. */
function codeField(testid: string, placeholder: string): HTMLInputElement {
  return h('input', { class: 'field code-field', type: 'password', placeholder, 'data-testid': testid, 'aria-label': placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '64' }) as HTMLInputElement;
}

/** First time: set the secret code (twice), then `then` (e.g. lock the chat). */
function setCodeSheet(then: () => Promise<void> | void): void {
  const a = codeField('code-new', 'Secret code');
  const b = codeField('code-again', 'Same code again');
  const err = errorBox();
  const go = async (e: Event) => {
    const problem = codeProblem(a.value);
    if (problem) return err.set(problem);
    if (a.value !== b.value) return err.set('The two codes are not the same.');
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      await locks.setCode(a.value);
    } catch (x) {
      btn.disabled = false;
      return err.set((x as Error).message);
    }
    s.remove();
    await then();
  };
  b.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector<HTMLButtonElement>('[data-testid=code-set]')?.click());
  const s = sheet('set-code-sheet',
    h('h2', {}, 'Set a secret code'),
    h('p', { class: 'muted small' }, 'Locked chats open only with this code. Use at least 4 digits, or a longer passphrase. It is not your phone’s PIN.'),
    a, b, err.el,
    h('p', { class: 'warn small' }, 'Nobody can bring back a forgotten code, not even Vilnek. If you forget it, the locked chats’ messages on this device must be deleted.'),
    h('button', { class: 'btn pri', 'data-testid': 'code-set', type: 'button', onclick: (e) => void go(e) }, 'Set code'),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Cancel'));
  a.focus();
}

/** Ask for the code; `then` runs once the locked chats are open. Wrong codes wait longer each time. */
function askCode(then: () => Promise<void> | void): void {
  closeSheets();
  const box = codeField('code-input', 'Secret code');
  const err = errorBox();
  const btn = h('button', { class: 'btn pri', 'data-testid': 'code-go', type: 'button' }, 'Open') as HTMLButtonElement;
  let timer: ReturnType<typeof setInterval> | null = null;
  const waitFor = (sec: number) => {
    if (timer) clearInterval(timer);
    let left = sec;
    const tick = () => {
      if (left <= 0) {
        if (timer) clearInterval(timer);
        timer = null;
        btn.disabled = false;
        box.disabled = false;
        err.set('Wrong code.');
        box.focus();
        return;
      }
      btn.disabled = true;
      box.disabled = true;
      err.set(`Wrong code. Try again in ${left} s.`);
      left--;
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  const go = async () => {
    if (!box.value || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const r = await locks.unlock(box.value);
    btn.textContent = 'Open';
    btn.disabled = false;
    box.value = '';
    if (!r.ok) return waitFor(r.wait);
    if (timer) clearInterval(timer);
    s.remove();
    await then();
  };
  btn.addEventListener('click', () => void go());
  box.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
  const s = sheet('code-sheet',
    h('div', { class: 'lock-head' }, h('div', { class: 'oi grad' }, icon('lock')), h('h2', {}, 'Locked chats')),
    h('p', { class: 'muted small' }, 'Type your secret code.'),
    box, err.el, btn,
    h('button', { class: 'link small', 'data-testid': 'forgot-code', type: 'button', onclick: () => forgotCodeSheet() }, 'Forgot code?'));
  void locks.waitLeft().then((w) => w > 0 && waitFor(w));
  box.focus();
}

/** "Forgot code": the only way out deletes the locked chats' messages here (nobody can open them). */
function forgotCodeSheet(): void {
  closeSheets();
  const s = sheet('forgot-sheet',
    h('h2', {}, 'Forgot your secret code?'),
    h('p', {}, 'Locked chats can’t be opened without the code, not by anyone, not even Vilnek.'),
    h('p', { class: 'muted small' }, 'You can remove the lock. This deletes the locked chats’ messages on this device. Your contacts and groups stay; their messages on other devices are not touched.'),
    h('button', { class: 'btn dang-fill', 'data-testid': 'forgot-confirm', type: 'button', onclick: async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      await locks.forget();
      s.remove();
      if (main.kind === 'chat' || (main.kind === 'flow' && main.name === 'locked-chats')) clearMain();
      toast('Chat lock removed. The locked chats’ messages were deleted on this device.');
    } }, 'Remove lock and delete the locked chats’ messages on this device'),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Cancel'));
}

/** Me › Privacy › Change secret code: the old code, then the new one twice. Re-seals every locked chat. */
function changeCodeSheet(): void {
  closeSheets();
  const old = codeField('code-old', 'Current code');
  const a = codeField('code-new', 'New code');
  const b = codeField('code-again', 'New code again');
  const err = errorBox();
  const s = sheet('change-code-sheet',
    h('h2', {}, 'Change secret code'),
    old, a, b, err.el,
    h('button', { class: 'btn pri', 'data-testid': 'code-change', type: 'button', onclick: async (e) => {
      const problem = codeProblem(a.value);
      if (problem) return err.set(problem);
      if (a.value !== b.value) return err.set('The two new codes are not the same.');
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      const r = await locks.changeCode(old.value, a.value);
      btn.disabled = false;
      if (!r.ok) return err.set(`Wrong current code. Try again in ${r.wait} s.`);
      s.remove();
      toast('Secret code changed');
    } }, 'Change code'),
    h('button', { class: 'link small', type: 'button', onclick: () => forgotCodeSheet() }, 'Forgot code?'),
    h('button', { class: 'btn sec2', type: 'button', onclick: () => s.remove() }, 'Cancel'));
  old.focus();
}

/** Me › Chat lock: what it does, and its settings. */
function chatLockScreen(): void {
  const n = locks.chats.length;
  flow('chat-lock', 'Chat lock',
    h('div', { class: 'card pad' },
      h('p', {}, 'Lock any chat or group with a secret code. Locked chats move out of your Chats list into “Locked chats”, and their messages are stored sealed with your code, so a copy of this device can’t read them.'),
      h('p', { class: 'muted small' }, 'To lock a chat: open it, tap its name, then “Lock this chat”. New messages in a locked chat show only “New message”.'),
      h('p', { class: 'muted small' }, 'Unlocking uses your secret code. The chats lock again when you leave them, or after 1 minute in the background.')),
    locks.isSet
      ? h('div', { class: 'card' },
          kvRow('lock', 'Locked chats', `${n}`, 'open-locked', () => openLockedChats()),
          kvRow('key', 'Change secret code', '', 'change-code', () => changeCodeSheet()),
          kvRow('alert', 'Forgot code?', '', 'forgot-code-row', () => forgotCodeSheet()))
      : h('p', { class: 'muted small', 'data-testid': 'chat-lock-off' }, 'No secret code yet. It is set the first time you lock a chat.'));
}

/** The Locked chats row: ask for the code (unless open), then list them. */
function openLockedChats(): void {
  if (locks.isOpen) return void lockedChatsScreen();
  askCode(() => lockedChatsScreen());
}

async function lockedChatsScreen(): Promise<void> {
  if (!locks.isOpen) return openLockedChats();
  const [contacts, marks] = await Promise.all([loadContacts(), loadReadMarks()]);
  // 1:1 chats only: locked groups stay in Groups (shown as "Locked", opened with the code).
  const rows = await chatRows(contacts.filter((c) => locks.isLocked(c.id)), [], marks);
  flow('locked-chats', 'Locked chats',
    h('div', { class: 'card list', 'data-testid': 'locked-list' }, ...(rows.length ? rows : [h('p', { class: 'muted pad1' }, 'No locked chats.')])),
    h('p', { class: 'muted small center' }, 'These chats lock again when you leave this screen.'));
}

/** Lock a chat (from its details). The first time, the code is set first. */
async function lockThisChat(id: string): Promise<void> {
  const doLock = async () => {
    await locks.lock(id);
    closeSheets();
    clearMain();
    toast('Chat locked. Find it in “Locked chats” at the top of Chats.');
  };
  if (!locks.isSet) {
    closeSheets(); // one sheet at a time: the code sheet replaces the details
    return setCodeSheet(doLock);
  }
  await doLock();
}

/** Remove the lock from the open (unlocked) chat. */
async function unlockThisChat(id: string): Promise<void> {
  if (!locks.isOpen) return;
  await locks.unlockChat(id);
  closeSheets();
  toast('Chat lock removed for this chat');
  if (id.startsWith('g:')) await openGroup(id.slice(2));
  else await openConversation(id);
}

/** The "Lock this chat" row in a chat's or group's details. */
function lockRow(id: string): HTMLElement {
  return locks.isLocked(id)
    ? kvRow('unlock', 'Remove chat lock', 'Locked', 'unlock-chat', () => void unlockThisChat(id))
    : kvRow('lock', 'Lock this chat', '', 'lock-chat', () => void lockThisChat(id));
}

/**
 * Locked chats close again when the person leaves them (anything but a locked chat or the Locked chats
 * list on screen), and after 1 minute in the background.
 */
function relockIfLeft(): void {
  if (!locks.isOpen) return;
  const inLocked = (main.kind === 'chat' && locks.isLocked(main.id)) || (main.kind === 'flow' && main.name === 'locked-chats');
  if (!inLocked) locks.close();
}

let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
function lockInBackground(hidden: boolean): void {
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  if (!hidden || !locks.isOpen) return;
  backgroundTimer = setTimeout(() => {
    backgroundTimer = null;
    if (!locks.isOpen) return;
    const showing = (main.kind === 'chat' && locks.isLocked(main.id)) || (main.kind === 'flow' && main.name === 'locked-chats');
    locks.close();
    if (showing) clearMain();
  }, Number(testFlag('lockAfterMs')) || 60_000);
}

async function wordsScreen(): Promise<void> {
  if (hostMode) return; // the host app keeps the 24 words
  const words = await loadUnsavedWords();
  if (words) {
    flow('words', 'My 24 words',
      h('div', { class: 'card pad' },
        h('p', { class: 'warn' }, 'Write these 24 words on paper, in order. Anyone with them can be you. We can’t recover them for you.'),
        h('p', { class: 'muted small' }, 'Type the same 24 words on your other phone or computer to use this account there too.'),
        wordsPanel(words),
        h('button', { class: 'btn pri', 'data-testid': 'phrase-done', type: 'button', onclick: () =>
          flow('words', 'Check your paper', wordsCheck(words, async () => {
            await clearUnsavedWords();
            unsavedWords = false;
            clearMain();
          }, () => void wordsScreen())) }, 'I’ve written them down')));
    return;
  }
  flow('words', 'My 24 words',
    h('div', { class: 'card pad' },
      me?.guest
        ? h('p', {}, 'This is a guest account: it has no 24 words and lives in this browser only. (Turning it into a 24-word account is planned.)')
        : h('p', {}, 'Your 24 words are not kept on this device, to keep them safe. They are on the paper you wrote them on.'),
      h('p', { class: 'muted small' }, 'Type the same 24 words on another phone or computer to use this account there too, or to get it back on a new device.')));
}

async function networkScreen(): Promise<void> {
  const chosen = await myRelays();
  const note = h('p', { class: 'error' });
  const list = testRelays
    ? h('p', { class: 'muted', 'data-testid': 'test-relays' }, `Test relays: ${testRelays.join(', ')}`)
    : h('div', { class: 'checks' }, ...DEFAULT_RELAYS.map((r) => {
        const box = h('input', { type: 'checkbox', checked: chosen.includes(r), onchange: async () => {
          const on = [...list.querySelectorAll('input:checked')].map((i) => (i as HTMLInputElement).value);
          if (!on.length) { (box as HTMLInputElement).checked = true; note.textContent = 'Keep at least one.'; return; }
          note.textContent = '';
          await saveRelayChoice(on);
        } }) as HTMLInputElement;
        box.value = r;
        return h('label', { class: 'check' }, box, ' ', r.replace('wss://', ''));
      }));
  flow('network', 'Network & relays',
    h('div', { class: 'sec' }, 'PUBLIC RELAYS FOR CONNECTING'),
    h('div', { class: 'card pad' },
      h('p', { class: 'muted small' }, 'Relays only see locked messages and your internet address. Invite requests wait on relays for up to 24 hours, then are deleted. Relays can’t read anything.'),
      list, note),
    h('div', { class: 'card' }, kvRow('info', 'Connection details', '', 'open-details', () => detailsScreen())));
}

const inIosApp = () => (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'ios';

/** Connection details: the last attempt, as text (addresses masked), with Copy. */
function detailsScreen(): void {
  const text = () =>
    report(lastAttempt(), [`Running in: ${inIosApp() ? 'the iPhone app' : 'a browser'} · ${navigator.userAgent.replace(/\s+/g, ' ').slice(0, 160)}`]);
  const pre = h('pre', { class: 'details', 'data-testid': 'conn-details' }, text());
  flow('details', 'Connection details',
    h('p', { class: 'muted small' }, 'What the last connection attempt did. Network addresses are cut short. Share this with whoever helps you.'),
    pre,
    iconBtn('copy', 'Copy', { class: 'btn sec2 with-icon', 'data-testid': 'copy-details', onclick: async (e) => {
      const label = (e.currentTarget as HTMLElement).querySelector('span') as HTMLElement; // read before the await (then it is gone)
      await navigator.clipboard?.writeText(text()).catch(() => undefined);
      label.textContent = 'Copied';
    } }, 'Copy'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => (pre.textContent = text()) }, 'Refresh'));
}

// ---- when a direct connection doesn't open --------------------------------------------------------

const GENERAL_FAIL = 'Can’t connect directly. If you’re on the same Wi-Fi, allow P2P Talk to use the local network in Settings, then try again.';
const IOS_FAIL = 'Can’t connect on this Wi-Fi. Allow P2P Talk to use the local network: Settings › Privacy & Security › Local Network › P2P Talk.';

function sameNetworkLikely(a: Attempt | null): boolean {
  const local = (c?: Attempt['local']) => !!c && c.host + c.mdns > 0;
  return onlyLocal(a) || (local(a?.local) && local(a?.remote));
}

/** The one plain sentence for a failed direct connection (the iPhone app names its Local Network setting). */
export function failText(a = lastAttempt()): string {
  return inIosApp() && sameNetworkLikely(a) ? IOS_FAIL : GENERAL_FAIL;
}

/** Stop and say so: one sentence, Try again, Back, Connection details. Never loops silently. */
function connectFailed(retry: () => void): void {
  linkDone();
  flow('connect-failed', 'Can’t connect',
    h('section', { class: 'card pad center', 'data-testid': 'connect-failed' },
      h('p', { class: 'big', 'data-testid': 'fail-text' }, failText()),
      h('div', { class: 'row2' },
        h('button', { class: 'btn pri', 'data-testid': 'try-again-connect', type: 'button', onclick: retry }, 'Try again'),
        h('button', { class: 'btn sec2', type: 'button', onclick: () => leaveFlow() }, 'Back')),
      h('button', { class: 'link small', 'data-testid': 'open-details', type: 'button', onclick: () => detailsScreen() }, 'Connection details')));
}

/**
 * Make a connection and watch it open: if it isn't open within 20 s (or fails), one automatic retry
 * (a fresh offer the same way); then ConnectFailed.
 */
async function watched(attempt: () => Promise<Peer>, retries = 1): Promise<Peer> {
  for (let i = 0; ; i++) {
    const p = await attempt();
    adopt(p);
    try {
      await p.whenReady();
      return p;
    } catch (e) {
      p.close();
      if (!(e instanceof ConnectFailed) || i >= retries) throw e;
    }
  }
}

// ---- Add: codes, invites, typing an ID ----------------------------------------------------------

function codeBlock(code: string): HTMLElement {
  const text = h('textarea', { class: 'field code-text', rows: '6', readonly: true, 'data-testid': 'code-text', 'aria-label': 'Your code as text' }, code) as HTMLTextAreaElement;
  const wrap = h('div', { class: 'code-text-wrap hidden' }, text,
    iconBtn('copy', 'Copy', { class: 'btn sec2 small with-icon', onclick: async (e) => {
      const label = (e.currentTarget as HTMLElement).querySelector('span') as HTMLElement; // read before the await (then it is gone)
      await navigator.clipboard?.writeText(code).catch(() => undefined);
      label.textContent = 'Copied';
      if (/^https:\/\//.test(code)) shareToHost(code, 'card');
    } }, 'Copy'));
  return h('div', { class: 'code-block' },
    h('div', { class: 'qr-wrap', 'data-testid': 'qr' }, qrCanvas(code)),
    h('button', { class: 'link', 'data-testid': 'toggle-text', type: 'button', onclick: (e) => {
      const hidden = wrap.classList.toggle('hidden');
      (e.target as HTMLElement).textContent = hidden ? 'Show code as text' : 'Hide text';
    } }, 'Show code as text'),
    wrap);
}

async function showMyCode(note = ''): Promise<void> {
  forgotten.clear(); // I'm adding someone: whoever it is may be someone I deleted before
  hosted?.close();
  hosted = null;
  flow('two-step', 'Two-step codes', waiting('Making your code…'));
  const gen = screenGen;
  const { peer: p, code } = await Peer.start(meForPeer());
  if (gen !== screenGen || main.kind !== 'flow') return p.close();
  adopt(p);
  expecting = true;
  const err = errorBox();
  const finish = async (reply: string) => {
    try {
      await p.finish(reply);
    } catch (e) {
      render();
      err.set((e as Error).message);
      return;
    }
    flow('two-step', 'Two-step codes', waiting('Connecting…'));
    expecting = true;
    try {
      await p.whenReady();
    } catch {
      if (main.kind === 'flow') connectFailed(() => void showMyCode());
    }
  };
  const render = () => {
    flow('two-step', 'Two-step codes',
      note && h('p', { class: 'notice', 'data-testid': 'fallback-note' }, note),
      h('section', { class: 'card pad' },
        h('h2', {}, 'Step 1 · Show my code'),
        h('p', { class: 'muted' }, 'Let them scan this, or send it to them as text.'),
        codeBlock(code)),
      h('section', { class: 'card pad' },
        h('h2', {}, 'Step 2 · Their reply'),
        h('p', { class: 'muted' }, 'They will show you a reply code.'),
        err.el,
        h('div', { class: 'row2' },
          iconBtn('scan', 'Scan their reply', { class: 'btn pri with-icon', 'data-testid': 'scan-reply', onclick: () => scanScreen('Scan their reply', (t) => void finish(t), render) }, 'Scan reply'),
          h('button', { class: 'btn sec2', 'data-testid': 'paste-reply', type: 'button', onclick: () => pasteScreen('Paste their reply', finish, render) }, 'Paste reply'))));
    expecting = true;
  };
  render();
}

async function invitesScreen(): Promise<void> {
  const invites = await loadInvites();
  const now = Date.now();
  const label = (i: (typeof invites)[number]) =>
    i.status === 'used' ? `Used by ${i.usedBy}` : i.status === 'cancelled' ? 'Cancelled' : i.expires < now ? 'Expired' : 'Waiting';
  flow('invites', 'My invites',
    invites.length
      ? h('div', { class: 'card' }, ...invites.slice(0, 20).map((i) => h('div', { class: 'kv', 'data-testid': 'invite' },
          icon('link'),
          h('div', { class: 'k' }, h('div', { 'data-testid': 'invite-state' }, label(i)), h('div', { class: 'muted small' }, `Made ${when(i.created)} · ends ${when(i.expires)}`)),
          label(i) === 'Waiting' && h('button', { class: 'chip', 'data-testid': 'cancel-invite', type: 'button', onclick: async () => {
            await hub?.cancelInvite(i.id);
            void invitesScreen();
          } }, 'Cancel'))))
      : h('p', { class: 'muted' }, 'No invites yet.'),
    h('button', { class: 'btn pri', type: 'button', onclick: () => inviteScreen() }, 'Make an invite link'));
}

function inviteScreen(): void {
  const choice = h('select', { class: 'field', 'data-testid': 'invite-ttl', 'aria-label': 'Link works for' },
    h('option', { value: '3600' }, '1 hour'),
    h('option', { value: '86400', selected: true }, '24 hours'),
    h('option', { value: '604800' }, '7 days')) as HTMLSelectElement;
  const out = h('div', { class: 'stack0' });
  flow('invite', 'Send an invite link',
    h('section', { class: 'card pad' },
      h('p', { class: 'muted' }, 'The link works once. If you are offline when they open it, you will see their request next time you open P2P Talk.'),
      h('label', { class: 'muted small' }, 'Link works for'), choice,
      h('button', { class: 'btn pri', 'data-testid': 'make-invite', type: 'button', onclick: () => void makeInvite(Number(choice.value) * 1000, out) }, 'Make link'),
      out));
}

async function makeInvite(ttlMs: number, out: HTMLElement): Promise<void> {
  const relays = await myRelays();
  const { card, boxSecret, link } = newCard(me!.secretKey, me!.publicKey, relays, Date.now(), {
    invite: true,
    ttlMs: testInviteTtl ? testInviteTtl * 1000 : ttlMs,
    name: me!.name,
  });
  await saveInvite({ id: toHex(card.boxId), link, boxSecret, created: Date.now(), expires: card.expires, relays, status: 'waiting', blocked: [] });
  void hub?.refresh();
  const text = h('textarea', { class: 'field code-text', rows: '4', readonly: true, 'data-testid': 'invite-link', 'aria-label': 'Invite link' }, link) as HTMLTextAreaElement;
  out.replaceChildren(
    text,
    h('div', { class: 'row2' },
      iconBtn('copy', 'Copy', { class: 'btn sec2 with-icon', 'data-testid': 'copy-invite', onclick: async (e) => {
        const label = (e.currentTarget as HTMLElement).querySelector('span') as HTMLElement; // read before the await (then it is gone)
        await navigator.clipboard?.writeText(link).catch(() => undefined);
        label.textContent = 'Copied';
        shareToHost(link, 'invite', card.expires);
      } }, 'Copy'),
      // Host mode: the host app shares the link (its own share menu); the page's browser share isn't used.
      hostMode
        ? iconBtn('share', 'Share', { class: 'btn sec2 with-icon', 'data-testid': 'share-invite-link', onclick: () => shareToHost(link, 'invite', card.expires) }, 'Share')
        : 'share' in navigator && iconBtn('share', 'Share', { class: 'btn sec2 with-icon', onclick: () => void navigator.share({ title: 'P2P Talk', text: 'Talk with me on P2P Talk', url: link }).catch(() => undefined) }, 'Share')),
    h('p', { class: 'muted small' }, `Ends ${when(card.expires)}.`),
  );
}

/** Add › Type their P2P ID: paste in any format → their card → Send request → they accept once → chat. */
function typeIdScreen(prefill = '', go = false): void {
  const box = h('textarea', { class: 'field mono id-field', rows: '2', inputmode: 'numeric', placeholder: '0000 0000 0000 0000 0000 0000', 'data-testid': 'id-input', 'aria-label': 'Their P2P ID', autocomplete: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  box.value = prefill;
  const out = h('div', { class: 'stack0', 'data-testid': 'id-result' });
  const fail = (text: string) => out.replaceChildren(h('p', { class: 'error', 'data-testid': 'id-error' }, text));
  const check = async () => {
    const id = extractId(box.value);
    if (!id || !idIsValid(id)) return fail('This ID doesn’t look right. Check the 24 digits.');
    box.value = formatId(id);
    if (id === myId()) return fail('This is your own ID.');
    if (await loadContact(id)) return void openConversation(id);
    const gen = screenGen;
    out.replaceChildren(h('div', { class: 'center', 'data-testid': 'id-searching' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, 'Looking for this ID…')));
    const card = await hub?.findById(id);
    if (gen !== screenGen) return;
    if (!card) return fail('Couldn’t find this ID. Ask them to open P2P Talk and share their ID again (it makes them findable).');
    found(id, card);
  };
  const found = (id: string, card: IdCard) => {
    const name = formatId(id); // the public card has no name: they say who they are once connected
    out.replaceChildren(h('div', { class: 'card pad center', 'data-testid': 'id-found' },
      avatar(name, id, 64),
      h('div', { class: 'big', 'data-testid': 'found-name' }, 'Found this ID'),
      h('div', { class: 'idt', 'data-testid': 'found-id' }, name),
      h('div', { class: 'pics', 'data-testid': 'found-emoji' }, emojiCode(fromB64url(card.k))),
      h('p', { class: 'muted small' }, 'Check the safety pictures with them if you can.'),
      h('button', { class: 'btn pri', 'data-testid': 'send-request', type: 'button', onclick: async (e) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        try {
          const j = await hub!.requestById(card);
          await j.requestSent;
          out.replaceChildren(h('p', { class: 'big center', 'data-testid': 'id-status' }, '✓ Request sent. You’ll connect when they accept.'));
          expecting = true; // when they accept, the chat opens
        } catch (err) {
          fail(err instanceof RelaysUnreachable ? 'Couldn’t reach the public relays. Try again later.' : (err as Error).message);
        }
      } }, 'Send request')));
  };
  flow('type-id', 'Type their P2P ID',
    h('section', { class: 'card pad' },
      h('p', { class: 'muted' }, 'The 24 digits they see under Me. Paste their whole message if you like.'),
      box,
      h('div', { class: 'row2' },
        iconBtn('copy', 'Paste', { class: 'btn sec2 with-icon', 'data-testid': 'paste-id', onclick: async () => {
          try {
            box.value = (await navigator.clipboard.readText()) || box.value;
          } catch {
            box.focus();
            toast('Press and hold in the box, then Paste.');
            return;
          }
          void check();
        } }, 'Paste'),
        h('button', { class: 'btn pri', 'data-testid': 'id-go', type: 'button', onclick: () => void check() }, 'Continue')),
      out));
  if (go) void check();
}

/** The invite we opened: one status line that changes in place. */
function inviteMessage(text: string, isError = false): void {
  const el = document.querySelector('[data-testid=invite-status]');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
  document.querySelector('[data-testid=invite-spinner]')?.remove();
}

async function joinTheirInvite(card: Card): Promise<void> {
  forgotten.clear(); // I'm adding someone: whoever it is may be someone I deleted before
  const name = card.name || shortId(p2pId(card.identityKey));
  const pid = p2pId(card.identityKey);
  flow('join-invite', name,
    h('section', { class: 'card pad center' },
      h('div', { class: 'spinner', 'data-testid': 'invite-spinner' }),
      h('p', { class: 'big', 'data-testid': 'invite-status' }, `Connecting to ${name}…`),
      h('p', { class: 'muted small' }, `P2P ID ${formatId(pid)} ${emojiCode(card.identityKey)}`)));
  const gen = screenGen;
  inviteScreenFor = pid;
  expecting = true;
  const run = async (retry: boolean): Promise<void> => {
    const j = await joinInvite(meForPeer(), card, allowedRelays());
    if (gen !== screenGen) return j.cancel();
    void hub?.refresh(); // listen for their acceptance even if this screen is left
    j.connected.then(async (p) => {
      adopt(p);
      try {
        await p.whenReady();
        linkDone();
      } catch {
        p.close();
        j.cancel();
        if (gen !== screenGen) return;
        if (retry) void run(false).catch(() => undefined); // one automatic retry: a fresh live offer
        else connectFailed(() => void joinTheirInvite(card));
      }
    });
    j.refused.then(() => {
      linkDone();
      if (inviteScreenFor === pid) inviteMessage(INVITE_USED_TEXT, true);
    });
    j.requestSent.then(
      () => {
        linkDone();
        if (inviteScreenFor === pid && !peers.get(pid)?.ready) inviteMessage(`✓ Request sent to ${name}. You'll connect when they're online.`);
      },
      () => inviteScreenFor === pid && inviteMessage('Couldn’t send the request. No internet? Use two-step codes.', true),
    );
  };
  try {
    await run(true);
  } catch (e) {
    if (gen !== screenGen) return;
    linkDone();
    inviteMessage(e instanceof RelaysUnreachable ? 'Couldn’t reach the public relays. No internet? Use two-step codes.' : (e as Error).message, true);
  }
}

async function showCard(): Promise<void> {
  forgotten.clear(); // I'm adding someone: whoever it is may be someone I deleted before
  hosted?.close();
  hosted = null;
  flow('show-code', 'Show my code', waiting('Making your code…'));
  const gen = screenGen;
  let latest: Peer | null = null;
  const made = await hostCard(meForPeer(), await myRelays(), (p) => {
    adopt(p);
    latest = p;
    // Shown once: a retry from the same person keeps this screen (no "Connecting…" again and again).
    if (!(main.kind === 'flow' && main.name === 'connecting')) {
      flow('connecting', 'Show my code', h('section', { class: 'card pad center', 'data-testid': 'connecting' }, h('div', { class: 'spinner' }), h('p', {}, 'Connecting…'), h('p', { class: 'muted small' }, `P2P ID ${formatId(p.peer!.id)}`)));
    }
    expecting = true;
    // Their side retries once on its own; after both tries, stop and say so.
    p.whenReady(CONNECT_WAIT_MS * 2 + 5000).catch(() => {
      if (latest === p && main.kind === 'flow' && main.name === 'connecting') connectFailed(() => void showCard());
    });
  }, testRelays ? [] : allowedRelays());
  if (gen !== screenGen) return made?.close();
  if (!made) {
    await showMyCode('Couldn’t reach the public relays, so you’re using two-step codes. They work with no internet too.');
    return;
  }
  hosted = made;
  flow('show-code', 'Show my code',
    h('section', { class: 'card pad' },
      h('p', { class: 'muted' }, 'Let them scan this with P2P Talk, or send them the link.'),
      codeBlock(made.link),
      hostMode ? iconBtn('share', 'Share link', { class: 'btn sec2 with-icon', 'data-testid': 'share-card', onclick: () => shareToHost(made.link, 'card') }, 'Share link') : null,
      h('p', { class: 'muted center', 'data-testid': 'waiting-scan' }, h('span', { class: 'spinner inline' }), ' Waiting for them to scan…'),
      h('p', { class: 'muted small center' }, 'This code works once and ends in 10 minutes.')),
    h('button', { class: 'link', 'data-testid': 'two-step', type: 'button', onclick: () => void showMyCode() }, 'No internet? Use two-step codes'));
  expecting = true;
}

function couldNot(message: string): void {
  linkDone();
  const err = errorBox();
  flow('error', 'Could not use this code', h('section', { class: 'card pad' }, err.el, h('button', { class: 'btn sec2', type: 'button', onclick: () => leaveFlow() }, 'Back')));
  err.set(message);
}

/** Whatever they gave us: a connect card / invite link (one-scan) or a two-step code. */
async function useTheirCode(text: string): Promise<void> {
  forgotten.clear(); // I'm adding someone: whoever it is may be someone I deleted before
  if (/P2P1\./.test(text)) return replyTo(text);
  const card = cardTextFrom(text);
  if (!card) return couldNot('This is not a P2P Talk code.');
  let decoded: Card;
  try {
    decoded = decodeCard(card);
  } catch (e) {
    return couldNot((e as Error).message);
  }
  return decoded.kind === 'invite' ? joinTheirInvite(decoded) : joinTheirCard(card);
}

async function joinTheirCard(text: string): Promise<void> {
  flow('join-card', 'Connecting', waiting('Checking their code…'));
  const gen = screenGen;
  try {
    const card = decodeCard(text);
    const boxHex = toHex(card.boxId);
    if (await wasCardUsed(boxHex)) throw new Error('This code was already used. Ask them to show a new one.');
    let cancel = () => {};
    let shown = false;
    const attempt = async () => {
      const j = await joinCard(meForPeer(), text, allowedRelays());
      cancel = j.cancel;
      if (gen !== screenGen) {
        j.cancel();
        throw new Error('left');
      }
      if (!shown) {
        shown = true;
        flow('join-card', 'Connecting',
          h('section', { class: 'card pad center', 'data-testid': 'connecting' }, h('div', { class: 'spinner' }), h('p', {}, 'Connecting…'),
            h('p', { class: 'muted small' }, `Their code is genuine. P2P ID ${formatId(p2pId(card.identityKey))}`)),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { cancel(); leaveFlow(); } }, 'Cancel'));
      }
      expecting = true;
      await j.done;
      return j.peer;
    };
    try {
      await watched(attempt); // then "ready" opens the chat
    } catch (e) {
      if (e instanceof ConnectFailed) {
        if (gen === screenGen || main.kind !== 'chat') connectFailed(() => void joinTheirCard(text));
        return;
      }
      throw e;
    }
    await markCardUsed(boxHex, card.expires); // only once it worked: a reload in the middle can carry on
    linkDone();
  } catch (e) {
    if (gen !== screenGen || (e as Error).message === 'left') return;
    linkDone();
    const err = errorBox();
    const offline = e instanceof RelaysUnreachable;
    flow('error', offline ? 'Couldn’t reach the public relays' : 'Could not use this code',
      h('section', { class: 'card pad' },
        err.el,
        offline && h('p', { class: 'muted' }, 'Ask them to tap “No internet? Use two-step codes”, then scan or paste the code they show.'),
        offline && h('div', { class: 'row2' },
          h('button', { class: 'btn sec2', type: 'button', onclick: () => scanScreen('Scan their code', (t) => void useTheirCode(t)) }, 'Scan their code'),
          h('button', { class: 'btn sec2', type: 'button', onclick: () => pasteScreen('Paste their code', (t) => useTheirCode(t)) }, 'Paste their code')),
        h('button', { class: 'btn sec2', type: 'button', onclick: () => leaveFlow() }, 'Back')));
    err.set(offline ? 'This device can’t reach the internet relays right now.' : (e as Error).message);
  }
}

async function replyTo(theirCode: string): Promise<void> {
  forgotten.clear(); // I'm adding someone: whoever it is may be someone I deleted before
  flow('reply', 'Two-step codes', waiting('Checking their code…'));
  const gen = screenGen;
  try {
    const { peer: p, code } = await Peer.reply(meForPeer(), theirCode);
    if (gen !== screenGen) return p.close();
    adopt(p);
    linkDone();
    flow('reply', 'Two-step codes',
      h('section', { class: 'card pad' },
        h('h2', {}, 'Show this reply to them'),
        h('p', { class: 'muted' }, `Their code is genuine. P2P ID ${formatId(p.peer!.id)}`),
        codeBlock(code),
        h('p', { class: 'muted center' }, h('span', { class: 'spinner inline' }), ' Waiting for them to scan it…')));
    expecting = true;
  } catch (e) {
    couldNot((e as Error).message);
  }
}

function pasteScreen(title: string, onCode: (t: string) => unknown, back?: () => void): void {
  const box = h('textarea', { class: 'field code-text', rows: '6', placeholder: 'Paste the code here', 'data-testid': 'paste-box', autocapitalize: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  flow('paste', title,
    h('section', { class: 'card pad' },
      box,
      h('button', { class: 'btn pri', 'data-testid': 'paste-go', type: 'button', onclick: () => box.value.trim() && onCode(box.value.trim()) }, 'Continue'),
      back && h('button', { class: 'btn ghost', type: 'button', onclick: back }, 'Back')));
  if (back) expecting = true;
  box.focus();
}

function stopScan(): void {
  scanAbort?.abort();
  scanAbort = null;
}

function scanScreen(title: string, onCode: (t: string) => void, back?: () => void): void {
  stopScan();
  const video = h('video', { class: 'scan-video', autoplay: true, muted: true, playsinline: true }) as HTMLVideoElement;
  const err = errorBox();
  flow('scan', title,
    h('section', { class: 'card pad' },
      h('p', { class: 'muted' }, 'Point your camera at the code on their screen.'),
      h('div', { class: 'scan-frame' }, video),
      err.el,
      h('button', { class: 'link', type: 'button', onclick: () => pasteScreen(title.replace(/^Scan/, 'Paste'), onCode, back) }, 'Paste instead'),
      back && h('button', { class: 'btn ghost', type: 'button', onclick: () => { stopScan(); back(); } }, 'Back')));
  if (back) expecting = true;
  scanAbort = new AbortController();
  scanQr(video, scanAbort.signal).then(
    (t) => { stopScan(); onCode(t); },
    (e: Error) => { if (e.message !== 'stopped') err.set('The camera could not start. Use “Paste” instead.'); },
  );
}

// ---- conversation ------------------------------------------------------------------------------------
// Header (one row, 60 px): back · avatar · name over one status line · voice and video.
// Everything for checking (ID, safety pictures, device, path) is in the details (sheet or side panel).

let conv: {
  id: string;
  contact: Contact;
  list: HTMLElement;
  presence: HTMLElement;
  status: HTMLElement;
  /** Peers already announced with "Connected" in this chat. */
  announced: WeakSet<Peer>;
  files: Map<string, HTMLElement>;
} | null = null;

async function openConversation(id: string): Promise<void> {
  if (!shell) buildShell();
  const contact = await loadContact(id);
  if (!contact) return;
  await locks.ready;
  if (locks.isLocked(id) && !locks.isOpen) return askCode(() => openConversation(id));
  closeSheets();
  stopScan();
  screenGen++;
  expecting = false;
  inviteScreenFor = null;
  const sameChat = conv?.id === id && main.kind === 'chat';
  if (sameChat) {
    announce();
    renderPresence();
    renderInfo();
    if (!peers.get(id)?.ready && !connectingTo.has(id)) void connectInChat(contact);
    return;
  }
  main = { kind: 'chat', id };
  gconv = null;
  relockIfLeft();
  const name = contact.name || shortId(id);
  const list = h('div', { class: 'chat', 'data-testid': 'messages' });
  const presence = h('div', { class: 's', 'data-testid': 'presence' });
  const status = h('div', { class: 'conv-status' });
  conv = { id, contact, list, presence, status, announced: new WeakSet(), files: new Map() };
  const input = h('input', { class: 'field', placeholder: `Message`, 'data-testid': 'message-input', maxlength: '4000', enterkeyhint: 'send', 'aria-label': 'Message', autocomplete: 'off' }) as HTMLInputElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const p = peers.get(id);
    input.value = '';
    void markTrusted(id); // I wrote to them: a known contact from now on
    let m: ChatMessage;
    try {
      // Not connected, or they said "bye" (app closed or in the background): it waits, with a clock.
      if (!p?.ready || !p.isOnline) throw new Error('offline');
      const sent = await p.sendText(text);
      m = { peer: id, from: 'me', text, ts: sent.ts, mid: sent.mid, st: 'sent' };
    } catch {
      // Not connected: kept with a clock and sent by itself when the connection opens (flushWaiting).
      m = { peer: id, from: 'me', text, ts: Date.now(), mid: newMid(), st: 'wait' };
      if (!connectingTo.has(id)) void connectInChat(contact);
    }
    m.key = await locks.store(m);
    toHost('message', hostMessage(id, 'me', m.mid, text, m.ts, m.st));
    appendMessage(m);
    refreshListSoon();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void send());

  shell!.main.replaceChildren(
    h('header', { class: 'hd chat-hd' },
      iconBtn('back', 'Back', { class: 'ib phone-only', 'data-testid': 'chat-back', onclick: () => (locks.isLocked(id) && locks.isOpen ? void lockedChatsScreen() : clearMain()) }),
      h('button', { class: 'who', 'data-testid': 'peer-info-open', type: 'button', 'aria-label': `About ${name}`, onclick: () => openInfo() },
        avatar(name, id, 38),
        h('div', { class: 'wt' }, h('div', { class: 'n', 'data-testid': 'peer-name' }, name), presence)),
      iconBtn('phone', 'Voice call', { 'data-testid': 'voice-call', onclick: () => void callContact(id, false) }),
      iconBtn('video', 'Video call', { 'data-testid': 'video-call', onclick: () => void callContact(id, true) })),
    list,
    status,
    h('footer', { class: 'compose' },
      iconBtn('plus', 'Send a photo, video or file', { 'data-testid': 'attach', onclick: () => sendSheet(id) }),
      input,
      h('button', { class: 'send', 'aria-label': 'Send', title: 'Send', 'data-testid': 'send', type: 'button', onclick: () => void send() }, icon('send', 22))),
  );
  document.body.classList.add('has-main');
  const history = (await locks.read(id)) ?? [];
  for (const m of history) appendMessage(m);
  const before = (await loadReadMarks())[id] ?? 0;
  readNow(id, history.filter((m) => m.from === 'them' && !m.note && (m.key ?? 0) > before).map((m) => m.mid));
  if (peers.get(id)?.ready) void flushWaiting(id); // a locked chat's waiting messages, now that it is open
  for (const t of files.get(id)?.list() ?? []) if (!['done', 'declined', 'cancelled', 'failed'].includes(t.state)) drawTransfer(t, true);
  const lastKey = history.at(-1)?.key;
  if (lastKey) await markRead(id, lastKey);
  announce();
  renderPresence();
  renderInfo();
  void renderList();
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
  // Not connected: reach them now.
  if (!peers.get(id)?.ready && !connectingTo.has(id)) void connectInChat(contact);
}

/** "Connected" once per connection, and the joined note if there is one. */
function announce(): void {
  const p = conv && peers.get(conv.id);
  if (!conv || !p?.ready || conv.announced.has(p)) return;
  conv.announced.add(p);
  // In time order: reopening a chat later puts these notes where they happened, not after newer messages.
  const at = readyAt.get(p) ?? Date.now();
  placeByTime(conv.list, h('div', { class: 'note', 'data-testid': 'success-note', 'data-ts': String(at) }, icon('check', 14), h('span', {}, 'Connected')), at);
  const note = notes.get(p);
  if (note) placeByTime(conv.list, h('div', { class: 'note plain', 'data-testid': 'joined-note', 'data-ts': String(at) }, note), at);
  conv.status.replaceChildren();
  conv.list.scrollTop = conv.list.scrollHeight;
}

/** Puts a note before the first message that is newer than it (or at the end). */
function placeByTime(list: HTMLElement, el: HTMLElement, ts: number): void {
  for (const c of list.children) {
    const t = Number((c as HTMLElement).dataset.ts);
    if (t && t > ts) return void list.insertBefore(el, c);
  }
  dayMark(list, ts); // at the end: under its own day heading
  list.append(el);
}

async function connectInChat(c: Contact): Promise<void> {
  const name = c.name || shortId(c.id);
  const line = (text: string, retry = false) =>
    conv?.id === c.id &&
    conv.status.replaceChildren(h('div', { class: 'note plain', 'data-testid': 'contact-status' }, text),
      retry ? h('button', { class: 'link small', 'data-testid': 'try-connect', type: 'button', onclick: () => void connectInChat(c) }, 'Try again') : '');
  line(`Connecting to ${name}…`);
  renderPresence();
  try {
    await watched(() => reach(c));
  } catch (e) {
    if (e instanceof ConnectFailed) {
      if (conv?.id === c.id)
        conv.status.replaceChildren(h('div', { class: 'note plain wrap', 'data-testid': 'contact-status' }, failText()),
          h('div', { class: 'links row-links' },
            h('button', { class: 'link small', 'data-testid': 'try-connect', type: 'button', onclick: () => void connectInChat(c) }, 'Try again'),
            h('button', { class: 'link small', 'data-testid': 'open-details', type: 'button', onclick: () => detailsScreen() }, 'Connection details')));
    } else line(e instanceof RelaysUnreachable ? 'Couldn’t reach the public relays. Try again later.' : `${name} is offline · try again later`, true);
  }
  if (conv?.id === c.id) renderPresence();
}

/** A day heading before the first message of each day in a chat. */
function dayMark(list: HTMLElement, ts: number): void {
  const key = new Date(ts).toDateString();
  if (list.dataset.day === key) return;
  list.dataset.day = key;
  list.append(h('div', { class: 'day', 'data-testid': 'day' }, dayLabel(ts)));
}

function appendMessage(m: ChatMessage): void {
  if (!conv) return;
  dayMark(conv.list, m.ts);
  if (m.note) {
    conv.list.append(h('div', { class: 'note plain', 'data-testid': 'chat-note', 'data-ts': String(m.ts) }, m.text));
  } else if (m.file) {
    conv.list.append(fileBubble(fileShown(m), m.ts));
  } else {
    conv.list.append(h('div', { class: `bub ${m.from === 'me' ? 'me' : 'th'}`, 'data-testid': `msg-${m.from}`, 'data-ts': String(m.ts), 'data-mid': m.mid },
      h('span', { class: 'tx' }, m.text), h('time', { class: 'tm' }, time(m.ts), m.from === 'me' ? tickEl(statusOf(m)) : null)));
  }
  conv.list.scrollTop = conv.list.scrollHeight;
}

/** A stored file message, as a bubble shows it. */
function fileShown(m: ChatMessage): FileShown {
  const f = m.file!;
  return { fid: m.mid, name: f.name, size: f.size, from: m.from, state: m.blob || m.native || m.opfs ? 'done' : 'failed', blob: m.blob, native: m.native, opfs: m.opfs, mime: f.type, thumb: m.thumb };
}

function appendNote(text: string): void {
  if (!conv) return;
  conv.list.append(h('div', { class: 'note plain' }, text));
  conv.list.scrollTop = conv.list.scrollHeight;
}

function renderPresence(): void {
  if (!conv) return;
  const p = peers.get(conv.id);
  const on = !!p?.isOnline;
  const seen = lastPeer.get(conv.id)?.lastSeen || conv.contact.lastSeen;
  const text = on ? 'online' : connectingTo.has(conv.id) ? 'connecting…' : `offline · last seen ${seen ? time(seen) : 'never'}`;
  conv.presence.replaceChildren(h('span', { class: `dot${on ? ' on' : ''}`, 'aria-hidden': 'true' }), h('span', { class: 'one-line' }, text));
  conv.presence.classList.toggle('on', on);
  announce();
}

// ---- ticks: waiting · sent · delivered · read (net/receipts.ts; PROTOCOL §22) --------------------------

let readReceipts = true;
const newMid = () => toB64url(crypto.getRandomValues(new Uint8Array(9)));
let rcptSaveTimer: ReturnType<typeof setTimeout> | null = null;
const newReceiptOutbox = () => new ReceiptOutbox(async (to, r) => {
  const p = peers.get(to);
  if (!p?.ready) return false;
  if (!p.supports(RCPT_FEATURE)) return true; // an older build: nothing to tell it
  await p.sendFrame({ k: 'rcpt', ...r });
  saveReceiptsSoon();
  return true;
});
let rcptOut = newReceiptOutbox();
function saveReceiptsSoon(): void {
  rcptSaveTimer ??= setTimeout(() => {
    rcptSaveTimer = null;
    void saveReceiptOutbox(rcptOut.snapshot());
  }, 500);
}
/** Test pages only (?testHooks=1 → __p2pTest.noReceipts): hold back every receipt, to see one grey tick. */
let testNoReceipts = false;
function owe(to: string, mids: string[], st: 'd' | 'r', g?: string): void {
  if (!mids.length || to === myId() || testNoReceipts) return;
  rcptOut.add(to, mids, st, g);
  saveReceiptsSoon();
}

async function loadTicks(): Promise<void> {
  readReceipts = await loadReadReceipts();
  rcptOut.restore(await loadReceiptOutbox());
}

/** What a message of mine shows (a group: all members delivered / read). */
function statusOf(m: ChatMessage): TickStatus {
  if (m.peer.startsWith('g:')) {
    const g = groups?.get(m.peer.slice(2));
    const others = (g?.members ?? []).map((x) => x.p2pId).filter((x) => x !== myId());
    return shownStatus(groupStatus(m.st, m.rc, others), readReceipts);
  }
  return shownStatus(m.st, readReceipts);
}

const TICK_LABEL: Record<TickStatus, string> = { wait: 'Waiting to send', sent: 'Sent', d: 'Delivered', r: 'Read' };
function tickEl(st: TickStatus): HTMLElement {
  return h('span', { class: `tk ${st}`, 'data-testid': 'tick', 'data-st': st, role: 'img', 'aria-label': TICK_LABEL[st], title: TICK_LABEL[st] },
    icon(st === 'wait' ? 'clock' : st === 'sent' ? 'tick' : 'ticks', 15));
}

/** Redraws the tick of one message, if its bubble is on screen. */
function redrawTick(m: ChatMessage): void {
  const list = conv?.id === m.peer ? conv.list : gconv && `g:${gconv.gid}` === m.peer ? gconv.list : null;
  const old = list?.querySelector(`[data-mid="${CSS.escape(m.mid)}"] .tk`);
  old?.replaceWith(tickEl(statusOf(m)));
}

/** Receipts are applied one at a time (two members' receipts for one message must not overwrite each other). */
let receiptQueue: Promise<void> = Promise.resolve();
function onReceipt(from: string, frame: unknown): Promise<void> {
  receiptQueue = receiptQueue.then(() => applyReceipt(from, frame)).catch(() => undefined);
  return receiptQueue;
}

/** A receipt from `from`: only for my messages in their chat (or a group they are in). */
async function applyReceipt(from: string, frame: unknown): Promise<void> {
  const r = parseReceipt(frame);
  if (!r) return;
  let chat = from;
  if (r.g) {
    const g = groups?.get(r.g);
    if (!g || g.status !== 'joined' || !g.members.some((m) => m.p2pId === from)) return;
    chat = `g:${r.g}`;
  } else if (!(await loadContact(from))) return;
  const want = new Set(r.mids);
  let msgs = await loadStoredMessages(chat);
  if (!msgs.some((m) => m.from === 'me' && want.has(m.mid))) {
    // On a fast link the receipt can arrive before my own message is stored: look once more.
    await new Promise((f) => setTimeout(f, 400));
    msgs = await loadStoredMessages(chat);
  }
  for (const m of msgs) {
    if (m.from !== 'me' || !want.has(m.mid)) continue;
    let changed = false;
    if (r.g) {
      const cur = m.rc?.[from];
      const next = upgrade(cur, r.st) as 'd' | 'r';
      if (next !== cur) {
        m.rc = { ...(m.rc ?? {}), [from]: next };
        changed = true;
      }
    } else {
      const next = upgrade(m.st, r.st);
      if (next !== m.st) {
        m.st = next;
        changed = true;
        if (next === 'd' || next === 'r') toHost('message-status', { contactId: from, mid: m.mid, status: next === 'r' ? 'read' : 'delivered' });
      }
    }
    if (!changed) continue;
    await putMessage(m);
    redrawTick(m);
  }
}

/**
 * Messages I typed while they were offline: sent now, in order, when the connection opens (or they
 * come back). With receipts, also my last day's messages that left this device but never arrived
 * (the link died under them): the other side keeps only the first copy of a message id.
 */
const flushing = new Set<string>();
async function flushWaiting(id: string): Promise<void> {
  const p = peers.get(id);
  if (!p?.ready || !p.isOnline || flushing.has(id)) return;
  flushing.add(id);
  try {
    await sendWaiting(id, p);
  } finally {
    flushing.delete(id);
  }
}
async function sendWaiting(id: string, p: Peer): Promise<void> {
  const msgs = await locks.read(id); // a locked chat that isn't open: sent the next time it is opened
  const resend = p.supports(RCPT_FEATURE);
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const m of msgs ?? []) {
    if (m.from !== 'me' || m.file || m.note) continue;
    if (!(m.st === 'wait' || (resend && m.st === 'sent' && m.ts > dayAgo))) continue;
    try {
      await p.sendFrame({ k: 'msg', mid: m.mid, text: m.text, ts: m.ts });
    } catch {
      return;
    }
    const stored = await findStoredMessage(id, m.mid);
    if (stored) {
      if (stored.st === 'wait') {
        stored.st = 'sent'; // a receipt may already have moved it further
        toHost('message-status', { contactId: id, mid: m.mid, status: 'sent' });
      }
      await putMessage(stored);
      m.st = stored.st;
      redrawTick(m);
    }
  }
}

/** Read receipts for what is on screen now (the chat open and the page visible). */
function readNow(chat: string, mids: string[], sender?: Map<string, string>): void {
  if (!readReceipts || document.visibilityState !== 'visible' || !mids.length) return;
  if (chat.startsWith('g:')) {
    const byFrom = new Map<string, string[]>();
    for (const mid of mids) {
      const f = sender?.get(mid);
      if (f) byFrom.set(f, [...(byFrom.get(f) ?? []), mid]);
    }
    for (const [f, l] of byFrom) owe(f, l, 'r', chat.slice(2));
  } else owe(chat, mids, 'r');
}

/** Coming back to a visible page with a chat open: read receipts for what arrived meanwhile. */
const unreadOnScreen: { chat: string; mids: string[]; sender: Map<string, string> } = { chat: '', mids: [], sender: new Map() };
function seenOnScreen(chat: string, mid: string, from?: string): void {
  if (document.visibilityState === 'visible') return readNow(chat, [mid], from ? new Map([[mid, from]]) : undefined);
  if (unreadOnScreen.chat !== chat) {
    unreadOnScreen.chat = chat;
    unreadOnScreen.mids = [];
    unreadOnScreen.sender = new Map();
  }
  unreadOnScreen.mids.push(mid);
  if (from) unreadOnScreen.sender.set(mid, from);
}
function flushSeen(): void {
  const open = conv?.id ?? (gconv ? `g:${gconv.gid}` : '');
  if (open && unreadOnScreen.chat === open) readNow(open, unreadOnScreen.mids, unreadOnScreen.sender);
  unreadOnScreen.chat = '';
  unreadOnScreen.mids = [];
}

/** Group message info (hold a message of mine): who has it and who read it. */
let holdTimer: ReturnType<typeof setTimeout> | null = null;
function holdForInfo(e: Event, gid: string, mid: string): void {
  const el = e.currentTarget as HTMLElement;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => void messageInfo(gid, mid), 550);
  const stop = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    el.removeEventListener('pointerup', stop);
    el.removeEventListener('pointerleave', stop);
    el.removeEventListener('pointermove', stop);
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointermove', stop);
}

async function messageInfo(gid: string, mid: string): Promise<void> {
  const g = groups?.get(gid);
  const m = (await loadStoredMessages(`g:${gid}`)).find((x) => x.mid === mid && x.from === 'me');
  if (!g || !m) return;
  closeSheets();
  const others = g.members.filter((x) => x.p2pId !== myId());
  const row = (x: GroupMember) => {
    const st = m.rc?.[x.p2pId];
    const shown: TickStatus = st === 'r' && !readReceipts ? 'd' : (st ?? (m.st === 'wait' ? 'wait' : 'sent'));
    return h('div', { class: 'kv', 'data-testid': 'info-member', 'data-st': shown },
      avatar(x.name || '?', x.p2pId, 32), h('div', { class: 'k one-line' }, x.name || shortId(x.p2pId)),
      h('div', { class: 'v' }, shown === 'r' ? 'Read' : shown === 'd' ? 'Delivered' : 'Not yet'), tickEl(shown));
  };
  sheet('message-info',
    h('h2', {}, 'Message info'),
    h('p', { class: 'muted small' }, m.locked ? 'A message in a locked chat.' : `“${m.text.slice(0, 120)}”`),
    h('div', { class: 'card' }, ...others.map(row)),
    readReceipts ? null : h('p', { class: 'muted small' }, 'Your read receipts are off, so you don’t see who read it.'));
}

// ---- pictures: mine, contacts' and groups' (core/photo.ts, net/photos.ts, ui/photo.ts) ----------------

let myPhoto: StoredPhoto | null = null;
let photoVis: 'contacts' | 'nobody' = 'contacts';
let pics: Record<string, StoredPhoto> = {};
const photoLinks = new Map<string, PhotoLink>();
/** Storage key → the id avatars use (a contact's P2P ID; a group's id without "g:"). */
const avatarKey = (key: string) => (key.startsWith('g:') ? key.slice(2) : key);
const groupPic = (gid: string) => groups?.get(gid)?.pic;

const photoHost: PhotoHost = {
  mine: () => (photoVis === 'contacts' ? myPhoto : null),
  stored: (key) => pics[key],
  isMember: (gid, id) => {
    const g = groups?.get(gid);
    return !!g && g.status === 'joined' && g.members.some((m) => m.p2pId === id);
  },
  received: (key, p) => void gotPicture(key, p),
};

async function loadPictures(): Promise<void> {
  [myPhoto, photoVis, pics] = await Promise.all([loadMyPhoto().then((p) => p ?? null), loadPhotoVisibility(), loadPics()]);
  if (myPhoto) setAvatarPhoto(myId(), await photoUrl(myPhoto));
  for (const [k, p] of Object.entries(pics)) {
    const url = await photoUrl(p);
    if (url) setAvatarPhoto(avatarKey(k), url);
    else delete pics[k];
  }
  for (const id of [myId(), ...Object.keys(pics).map(avatarKey)]) redrawAvatars(id);
  refreshListSoon();
}

/** Every avatar of this id on screen shows its picture now (or the letter again). */
function redrawAvatars(id: string): void {
  const url = avatarPhoto(id);
  for (const el of document.querySelectorAll<HTMLElement>(`[data-av="${CSS.escape(id)}"]`)) {
    let img = el.querySelector<HTMLImageElement>('img.avp');
    if (!url) {
      img?.remove();
      continue;
    }
    if (!img) {
      img = h('img', { class: 'avp', alt: '', draggable: 'false', 'data-testid': 'avatar-photo' }) as HTMLImageElement;
      el.prepend(img);
    }
    img.src = url;
  }
}

/** A checked picture from a contact or a group member (or theirs was removed). */
async function gotPicture(key: string, p: StoredPhoto | null): Promise<void> {
  const before = pics[key];
  if (!p) {
    if (!before) return;
    delete pics[key];
    await savePics(pics);
    setAvatarPhoto(avatarKey(key), null);
  } else {
    if (key.startsWith('g:') && groupPic(key.slice(2)) !== p.h) return; // only the picture the signed record names
    const url = await photoUrl(p); // decoded and drawn again; never the raw bytes
    if (!url) return;
    pics[key] = p;
    await savePics(pics);
    setAvatarPhoto(avatarKey(key), url);
    if (before && before.h !== p.h && !key.startsWith('g:') && (await loadContact(key))) {
      const c = await loadContact(key);
      const text = `${c?.name || shortId(key)} changed their photo`;
      const m: ChatMessage = { peer: key, from: 'them', text, ts: Date.now(), mid: `pic-${p.h.slice(0, 12)}`, note: true };
      await locks.store(m);
      if (conv?.id === key) appendMessage(m);
    }
  }
  redrawAvatars(avatarKey(key));
  if (conv?.id === key) renderInfo();
  refreshListSoon();
}

/** Tell every connected contact about my picture (after a change, or Who can see my photo). */
function announcePicture(): void {
  for (const l of photoLinks.values()) void l.announce();
}

/** Groups whose record names a picture I don't have: ask the members I'm connected to. */
function askGroupPictures(): void {
  for (const g of groups?.list() ?? []) {
    if (g.status !== 'joined') continue;
    const want = groupPic(g.id);
    const key = `g:${g.id}`;
    if (!want) {
      if (pics[key]) void gotPicture(key, null);
      continue;
    }
    if (pics[key]?.h === want) continue;
    for (const m of g.members) photoLinks.get(m.p2pId)?.askGroup(g.id, want);
  }
}

/** The picked photo as a Blob (browsers: the file itself; the apps: read once, photos only). */
async function pickedBlob(src: PickedSource): Promise<Blob> {
  try {
    if (src.blob) return src.blob;
    if (src.size > 40 * 1024 * 1024) throw new Error('This photo is too big. Choose a smaller one.');
    return new Blob([(await src.read(0, src.size)) as Uint8Array<ArrayBuffer>], { type: src.mime });
  } finally {
    void src.release().catch(() => undefined);
  }
}

/** Profile photo (gid null) or a group's photo (admins): Choose · Take · Remove. */
function photoMenu(gid: string | null): void {
  closeSheets();
  const has = gid ? !!pics[`g:${gid}`] : !!myPhoto;
  const choose = (kind: PickKind) => {
    closeSheets();
    void pickOriginals(kind, { multiple: false }).then(async (picked) => {
      if (!picked.length) return;
      const p = await cropPhoto(await pickedBlob(picked[0]), picked[0].name);
      if (p) await setPicture(gid, p);
    }).catch((e: Error) => toast(e.message));
  };
  const row = (iconName: IconName, title: string, testid: string, fn: () => void) =>
    h('button', { class: 'opt', 'data-testid': testid, type: 'button', onclick: fn }, h('div', { class: 'oi' }, icon(iconName)), h('div', { class: 'b' }, h('div', { class: 'n' }, title)));
  sheet('photo-sheet',
    h('h2', {}, gid ? 'Group photo' : 'Profile photo'),
    h('div', { class: 'card' },
      row('image', 'Choose photo', 'photo-choose', () => choose('media')),
      row('camera', 'Take photo', 'photo-take', () => choose('camera')),
      has ? row('block', 'Remove photo', 'photo-remove', () => (closeSheets(), void setPicture(gid, null))) : null),
    h('p', { class: 'muted small center' }, gid
      ? 'Members see it. It goes straight to them, never to the relays.'
      : 'Your contacts see it (Me › Privacy). It goes straight to them, never to the relays.'));
}

async function setPicture(gid: string | null, p: StoredPhoto | null): Promise<void> {
  const url = p ? await photoUrl(p) : null;
  if (p && !url) return toast('This photo could not be used.');
  if (!gid) {
    myPhoto = p;
    await saveMyPhoto(p);
    setAvatarPhoto(myId(), url);
    redrawAvatars(myId());
    announcePicture();
  } else {
    const key = `g:${gid}`;
    if (p) pics[key] = p;
    else delete pics[key];
    await savePics(pics);
    setAvatarPhoto(gid, url);
    redrawAvatars(gid);
    // The signed group record names the picture (its hash); members fetch the bytes from each other.
    await groups?.setPicture(gid, p?.h ?? null).catch((e: Error) => toast(e.message));
    await saveGroupsNow();
  }
  toast(p ? 'Photo saved' : 'Photo removed');
  void renderList();
}

// ---- files -----------------------------------------------------------------------------------------

/** A file message from the history (finished earlier). */
interface FileShown {
  fid: string;
  name: string;
  size: number;
  from: 'me' | 'them';
  state: 'done' | 'failed';
  blob?: Blob;
  native?: { ref: string; name: string; size: number; mime: string };
  /** In the browser's private file area (loaded from there when needed, BUG-7). */
  opfs?: string;
  mime?: string;
  thumb?: Blob;
}

/** A file name that keeps its end: "Diwali-rang…goli.jpg" (the cut is in the middle, by CSS). */
function fileName(name: string): HTMLElement {
  const ext = /\.[^.]{1,8}$/.exec(name)?.[0] ?? '';
  const keep = Math.min(name.length, ext.length + 5);
  return h('div', { class: 'fn mid', 'data-testid': 'file-name', title: name },
    h('span', { class: 'a' }, name.slice(0, name.length - keep)), h('span', { class: 'z' }, name.slice(name.length - keep)));
}

/** The photo / video preview at the top of a file bubble (tap: full view of the file on this device). */
function bubbleThumb(thumb: Blob | undefined, name: string, mime: string, load: () => Promise<Blob | null>, native?: FileShown['native']): HTMLElement | null {
  if (!thumb) return null;
  return thumbView(thumb, isVideoType(mime, name), () => {
    if (native && isNativeApp()) return void shareOrOpen({ where: 'native', native } as unknown as SinkResult, name, mime).catch(() => undefined);
    void load().then((b) => (b ? openViewer(b, mime, name) : toast('This file is no longer on this device.')));
  });
}

function fileBubble(f: FileShown, ts = Date.now()): HTMLElement {
  const mime = f.mime ?? f.native?.mime ?? '';
  const btn = (label: string, testid: string, fn: () => void) => h('button', { class: 'fbtn', 'data-testid': testid, type: 'button', onclick: fn }, label);
  const facts = h('div', { class: 'facts' });
  const size = h('div', { class: 'fs' }, f.state === 'done' ? bytes(f.size) : 'Not kept on this device');
  if (f.state === 'done' && f.from === 'them') {
    if (f.native) facts.append(...saveButtons({ where: 'native', native: f.native } as unknown as SinkResult, f.name, mime, btn));
    else if (f.opfs) {
      // Only the name is stored; the file itself is read from the private file area when shown.
      void opfsFile(f.opfs).then((file) => {
        if (file) facts.append(...saveButtons({ where: 'opfs', file, opfsName: f.opfs }, f.name, mime, btn));
        else size.textContent = 'Not kept on this device';
      });
    } else if (f.blob) {
      // Saved as plain bytes (never opened as a page in this origin: a received .html or .svg can't run here).
      facts.append(h('a', { class: 'fbtn', href: URL.createObjectURL(new Blob([f.blob], { type: 'application/octet-stream' })), download: f.name, 'data-testid': 'file-save' }, 'Save'));
    }
  }
  const load = async () => f.blob ?? (f.opfs ? await opfsFile(f.opfs) : null);
  const bub = h('div', { class: `bub file-bub ${f.from === 'me' ? 'me' : 'th'}${f.thumb ? ' has-thumb' : ''}`, 'data-testid': `file-${f.from}`, 'data-state': f.state, 'data-fid': f.fid, 'data-ts': String(ts) },
    bubbleThumb(f.thumb, f.name, mime, load, f.native),
    h('div', { class: 'file' }, h('div', { class: 'fi' }, icon(isMedia(mime, f.name) ? 'image' : 'file')),
      h('div', { class: 'fmeta' }, fileName(f.name), size)),
    facts,
    h('time', { class: 'tm' }, time(ts)));
  // A photo or video received in the app before previews were made there: the phone makes one now.
  if (!f.thumb && f.native && f.state === 'done' && isMedia(mime, f.name)) {
    void receivedThumb({ where: 'native', native: f.native } as unknown as SinkResult, mime, f.name).then((t) => {
      const el = t && bubbleThumb(t, f.name, mime, load, f.native);
      if (!el || bub.querySelector('[data-testid=file-thumb]')) return;
      bub.prepend(el);
      bub.classList.add('has-thumb');
    });
  }
  return bub;
}

// ---- files with no size limit (files2 engine: one data channel per transfer, resume) --------------

const files = new Map<string, FileTransfers>();
/** Picked originals by transfer: released (the phone's temporary copy) once the transfer is over. */
const picks = new Map<string, PickedSource>();
/** Photo / video previews by transfer (made from the local file: the picked one, or the received one). */
const thumbs = new Map<string, Blob>();
/** Per transfer: when it started moving, the smoothed speed, and the last time its line was drawn. */
const fileStats = new Map<string, { started: number; ema: number; drawn: number; state: string }>();

function filesFor(id: string): FileTransfers {
  let f = files.get(id);
  if (!f) {
    // Every offer comes to us first: known contacts' files under 100 MB are taken at once; a new
    // contact's files (any size) and bigger files ask Accept / Decline.
    f = new FileTransfers(id, { autoAcceptBelow: 0, maxFrame: peers.get(id)?.maxFrame ?? 65_536 });
    const ft = f;
    f.on('offer', (t) => {
      hostFile(t);
      if (trusted.has(id) && t.size < 100 * 1024 * 1024) void ft.accept(t.id, receiveSink(t.name, t.size, t.mime));
      else drawTransfer(t, true);
    });
    f.on('update', (t) => {
      hostFile(t);
      drawTransfer(t);
    });
    f.on('done', (t) => {
      hostFile(t);
      drawTransfer(t, true);
      void saveTransfer(t);
    });
    files.set(id, f);
  }
  return f;
}

/** Contacts I have written to or whose call I accepted (the rest are "new contacts"). */
const trusted = new Set<string>();
async function loadTrusted(): Promise<void> {
  for (const c of await loadContacts()) {
    if (c.trusted) trusted.add(c.id);
    contactKeys.set(c.id, c.publicKey);
  }
}
async function markTrusted(id: string): Promise<void> {
  if (trusted.has(id)) return;
  trusted.add(id);
  const c = await loadContact(id);
  if (c && !c.trusted) await saveContact({ ...c, trusted: true });
}

/** A connection opened: hand its channels to the file and group engines. */
function attachEngines(id: string, p: Peer): void {
  if (p.supports(FILE_FEATURE)) {
    const f = filesFor(id);
    f.attach(p.chatChannel(), (tid) => p.openFileChannel(tid));
    p.on('fileChannel', (ch) => f.addDataChannel(ch));
  }
  if (groups && p.supports(GROUP_FEATURE)) {
    const detach = groups.attach(p.chatChannel());
    p.on('closed', detach);
  }
  if (gcm && p.supports(GROUP_CALL_FEATURE)) {
    const g = gcm;
    p.on('frame', (f) => GROUP_CALL_KINDS.has((f as { k: string }).k) && g.onFrame(id, f));
    g.peerReady(id); // rings a member who was offline; tells one in the call
  }
  if (p.supports(RCPT_FEATURE)) p.on('frame', (f) => (f as { k: string }).k === 'rcpt' && void onReceipt(id, f));
  void rcptOut.flush(id); // receipts I owed them while they were away
  void flushWaiting(id); // messages typed while they were offline
  if (p.supports(PIC_FEATURE)) {
    const link = new PhotoLink(id, (f) => p.sendFrame(f), photoHost);
    photoLinks.set(id, link);
    p.on('frame', (f) => PIC_KINDS.has((f as { k: string }).k) && link.onFrame(f));
    p.on('closed', () => photoLinks.get(id) === link && photoLinks.delete(id));
    void link.announce();
    askGroupPictures();
  }
}

/** A preview of a picked photo or video, from the file on this device (big videos: none in the apps). */
async function thumbOfPicked(src: PickedSource): Promise<Blob | null> {
  if (!isMedia(src.mime, src.name)) return null;
  const blob = (src as PickedSource & { blob?: Blob }).blob ?? (src.size <= 30 * 1024 * 1024 && !isVideoType(src.mime, src.name) ? new Blob([(await src.read(0, src.size)) as Uint8Array<ArrayBuffer>], { type: src.mime }) : null);
  return blob ? makeThumb(blob, src.mime, src.name) : null;
}

/** One picked item shared by several transfers (a group): released when the last one is over. */
function shared(src: PickedSource, n: number): PickedSource {
  let left = n;
  return { ...src, read: (o, l) => src.read(o, l), release: async () => { if (--left === 0) await src.release(); } };
}

/** The clip: Photos and videos · Files · Camera. Always the original, full quality. */
function sendSheet(id: string): void {
  const pick = (kind: PickKind) => {
    closeSheets();
    // Called inside the tap: the browser's file chooser needs it.
    void pickOriginals(kind).then(async (picked) => {
      if (!picked.length) return;
      if (id.startsWith('g:')) return sendToGroup(id.slice(2), picked);
      const p = peers.get(id);
      if (!p?.ready) return appendNote('Not sent: they are offline.');
      if (!p.supports(FILE_FEATURE)) return appendNote('Their app can’t receive files yet. Ask them to update P2P Talk.');
      const failed = await sendPicked(picked, (src) => filesFor(id).send(src), (tid, src) => {
        picks.set(tid, src);
        void thumbOfPicked(src).then((t) => t && (thumbs.set(tid, t), redrawTransfer(id, tid)));
      });
      if (failed) appendNote(failedLine(failed));
    }, (e: Error) => (id.startsWith('g:') ? appendGroupNote(e.message) : appendNote(e.message)));
  };
  const row = (iconName: IconName, title: string, sub: string, testid: string, kind: PickKind) =>
    h('button', { class: 'opt', 'data-testid': testid, type: 'button', onclick: () => pick(kind) },
      h('div', { class: 'oi' }, icon(iconName)), h('div', { class: 'b' }, h('div', { class: 'n' }, title), h('div', { class: 'm' }, sub)));
  sheet('send-sheet',
    h('h2', {}, 'Send'),
    h('div', { class: 'card' },
      row('image', 'Photos and videos', 'From your gallery', 'pick-media', 'media'),
      row('folder', 'Files', 'Any file, any size', 'pick-files', 'files'),
      row('camera', 'Camera', 'Take a photo or video', 'pick-camera', 'camera')),
    id.startsWith('g:') ? h('p', { class: 'muted small center', 'data-testid': 'group-file-note' }, 'Goes straight to each member who is online now, in your chat with them.') : null,
    h('p', { class: 'ok small with-icon center-row', 'data-testid': 'original-note' }, icon('check', 16), 'Sent as original, full quality'));
}

/**
 * Files to a group: groups carry text only (net/groups.ts has no file frames), so each file goes
 * straight to every member who is connected now, as a normal 1:1 transfer (it shows in their chat with
 * me). The group chat says who got it and who didn't.
 */
async function sendToGroup(gid: string, picked: PickedSource[]): Promise<void> {
  const g = groups?.get(gid);
  if (!g) return;
  const others = g.members.filter((m) => m.p2pId !== myId());
  const ready = others.filter((m) => peers.get(m.p2pId)?.ready && peers.get(m.p2pId)!.supports(FILE_FEATURE));
  const missed = others.filter((m) => !ready.includes(m));
  if (!ready.length) {
    for (const src of picked) void src.release().catch(() => undefined);
    return appendGroupNote('Not sent: no member is online right now.');
  }
  let failed = 0;
  for (const src of picked) {
    const one = shared(src, ready.length);
    for (const m of ready) {
      try {
        const tid = await filesFor(m.p2pId).send(one);
        picks.set(tid, one);
      } catch {
        failed++;
        void one.release().catch(() => undefined);
      }
    }
  }
  const names = (l: GroupMember[]) => l.map((m) => m.name || shortId(m.p2pId)).join(', ');
  const what = picked.length === 1 ? `“${picked[0].name}”` : `${picked.length} files`;
  appendGroupNote(`Sending ${what} to ${names(ready)}, in your chat with each.`);
  if (missed.length) appendGroupNote(`Not sent to ${names(missed)} (offline).`);
  if (failed) appendGroupNote(failedLine(failed));
}

function redrawTransfer(peerId: string, tid: string): void {
  const t = files.get(peerId)?.list().find((x) => x.id === tid);
  if (t) drawTransfer(t, true);
}

const mbps = (bps: number) => `${(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)} MB/s`;
function left(s: number | null): string {
  if (s === null || !isFinite(s)) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}
function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** One file bubble, drawn from the engine's state; the live line at most twice a second, speed smoothed. */
function drawTransfer(t: TransferInfo, force = false): void {
  const now = Date.now();
  if (['done', 'declined', 'cancelled', 'failed'].includes(t.state)) {
    const src = picks.get(t.id);
    picks.delete(t.id);
    void src?.release().catch(() => undefined);
  }
  let st = fileStats.get(t.id);
  if (!st) fileStats.set(t.id, (st = { started: now, ema: 0, drawn: 0, state: '' }));
  if (t.state === 'active' && t.speed > 0) st.ema = st.ema ? st.ema * 0.7 + t.speed * 0.3 : t.speed;
  const changed = st.state !== t.state;
  if (!force && !changed && now - st.drawn < 500) return;
  st.drawn = now;
  st.state = t.state;
  if (conv?.id !== t.peerId) return;
  const el = transferBubble(t, st);
  const old = conv.files.get(t.id);
  if (old) old.replaceWith(el);
  else {
    dayMark(conv.list, now);
    conv.list.append(el);
    conv.list.scrollTop = conv.list.scrollHeight;
  }
  conv.files.set(t.id, el);
}

/**
 * One file bubble, two clean lines: the name, then one info line, always starting with the size:
 *   "48 MB · 29% · 9.0 MB/s · 5 s left" while moving, "48 MB · original" when done (how long it took
 *   and that it was checked are in the line's tooltip), "48 MB · Ravi wants to send this", …
 */
function transferBubble(t: TransferInfo, st: { started: number; ema: number }): HTMLElement {
  const out = t.dir === 'out';
  const f = files.get(t.peerId);
  const who = conv?.contact.name || 'them';
  const pct = t.size ? Math.min(100, Math.floor((t.bytes / t.size) * 100)) : 100;
  let info = '';
  let tip = '';
  const acts: Child[] = [];
  const btn = (label: string, testid: string, fn: () => void) => h('button', { class: 'fbtn', 'data-testid': testid, type: 'button', onclick: fn }, label);
  switch (t.state) {
    case 'queued':
      info = 'Waiting…';
      acts.push(btn('Cancel', 'file-cancel', () => f?.cancel(t.id)));
      break;
    case 'offered':
      info = `Waiting for ${who} to accept`;
      acts.push(btn('Cancel', 'file-cancel', () => f?.cancel(t.id)));
      break;
    case 'incoming':
      info = `${who} wants to send this`;
      acts.push(btn('Accept', 'file-accept', () => void f?.accept(t.id, receiveSink(t.name, t.size, t.mime))), btn('Decline', 'file-decline', () => f?.decline(t.id)));
      break;
    case 'active':
    case 'verifying':
      info = t.state === 'verifying' ? 'Checking…' : [`${pct}%`, st.ema ? mbps(st.ema) : '', left(t.eta)].filter(Boolean).join(' · ');
      acts.push(btn('Pause', 'file-pause', () => f?.pause(t.id)), btn('Cancel', 'file-cancel', () => f?.cancel(t.id)));
      break;
    case 'paused':
      info = `${pct}% · ${t.pausedByMe ? 'Paused by you' : `Paused by ${who}`}`;
      if (t.pausedByMe) acts.push(btn('Resume', 'file-resume', () => f?.resume(t.id)));
      acts.push(btn('Cancel', 'file-cancel', () => f?.cancel(t.id)));
      break;
    case 'waiting':
      info = `${pct}% · Waiting for connection…`;
      acts.push(btn('Cancel', 'file-cancel', () => f?.cancel(t.id)));
      break;
    case 'done': {
      const ms = Date.now() - st.started;
      info = 'original';
      tip = `${out ? 'Sent' : 'Received'} in ${took(ms)} · avg ${mbps(t.size / Math.max(ms / 1000, 0.001))}${out ? '' : ' · checked'}`;
      if (!out && t.result) acts.push(...saveButtons(t.result, t.name, t.mime, btn));
      break;
    }
    case 'declined':
      info = out ? `${who} declined` : 'Declined';
      break;
    case 'cancelled':
      info = 'Cancelled';
      break;
    case 'failed':
      info = 'Didn’t arrive. Try sending it again.';
      break;
  }
  const moving = ['active', 'verifying', 'paused', 'waiting'].includes(t.state);
  const thumb = thumbs.get(t.id);
  const native = nativeFileOf(t.result) ?? undefined;
  // The preview opens the file on this device: the received one, or (sending) nothing more than the preview.
  const load = async () => t.result?.file ?? null;
  return h('div', { class: `bub file-bub ${out ? 'me' : 'th'}${thumb ? ' has-thumb' : ''}`, 'data-testid': `file-${out ? 'me' : 'them'}`, 'data-state': t.state, 'data-fid': t.id },
    bubbleThumb(thumb, t.name, t.mime, load, native),
    h('div', { class: 'file' }, h('div', { class: 'fi' }, icon(isMedia(t.mime, t.name) ? 'image' : 'file')),
      h('div', { class: 'fmeta' },
        fileName(t.name),
        h('div', { class: 'fs fline', 'data-testid': 'file-line', title: tip || undefined, 'aria-label': tip ? `${bytes(t.size)} · ${info} · ${tip}` : undefined }, `${bytes(t.size)} · ${info}`))),
    moving ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null,
    acts.length ? h('div', { class: 'facts' }, ...acts) : null);
}

/** Save to Photos (app, images and videos) · Save to Files · Share or open; in a browser: Save · Share. */
function saveButtons(r: SinkResult, name: string, mime: string, btn: (label: string, testid: string, fn: () => void) => HTMLElement): HTMLElement[] {
  const app = isNativeApp();
  const said = (e: unknown) =>
    toast(e instanceof NativeFilesError && e.code === 'denied' ? 'P2P Talk can’t add to Photos. You can allow it in Settings.' : (e as Error).message);
  const run: Record<SaveKind, () => void> = {
    photos: () => void saveToPhotos(r, name, mime).then(() => toast('Saved to Photos'), said),
    files: () => void saveToFiles(r, name, mime).then((ok) => ok && app && toast('Saved to Files'), said),
    share: () =>
      void shareOrOpen(r, name, mime).then((o) => o === 'downloaded' && toast('This browser can’t share this file, so it was saved instead.'), said),
  };
  return saveActions(app, canSaveToPhotos(mime)).map((a) => btn(a.label, a.testid, run[a.kind]));
}

/**
 * A finished transfer becomes a chat message. Where the file is kept:
 *   apps        the app's folder (`native`, a reference only);
 *   browser     the private file area (`opfs`, its name only: BUG-7, never the File itself, which
 *               IndexedDB would copy whole), or, without one, in memory for files up to 100 MB (`blob`).
 * Photos and videos also get a small preview, made here from the received file.
 */
async function saveTransfer(t: TransferInfo): Promise<void> {
  const r = t.result;
  const native = nativeFileOf(r) ?? undefined;
  const opfs = r?.where === 'opfs' && r.opfsName ? r.opfsName : undefined;
  let thumb = thumbs.get(t.id);
  if (!thumb && t.dir === 'in' && (r?.file || native)) {
    // Browser: drawn here from the received file. Apps: made by the phone (scaled while decoding, HEIC too).
    thumb = (r?.file ? await makeThumb(r.file, t.mime, t.name) : await receivedThumb(r, t.mime, t.name)) ?? undefined;
    if (thumb) {
      thumbs.set(t.id, thumb);
      drawTransfer(t, true);
    }
  }
  const blob = native || opfs || r?.where !== 'memory' ? undefined : r?.file;
  const key = await locks.store({ peer: t.peerId, from: t.dir === 'out' ? 'me' : 'them', text: '', ts: Date.now(), mid: t.id, file: { name: t.name, size: t.size, type: t.mime }, blob, native, opfs, thumb });
  if (conv?.id === t.peerId && t.dir === 'in') void markRead(t.peerId, key);
  if (conv?.id !== t.peerId && locks.isLocked(t.peerId) && t.dir === 'in' && !muted.has(t.peerId)) toast('New message');
  refreshListSoon();
}

/**
 * BUG-7: older versions kept each received file inside its IndexedDB message (a 2 GB file grew the
 * database by 2 GB more). Moves those files into the private file area once; the message keeps the name.
 */
let movedFiles = false;
async function moveOldFiles(): Promise<void> {
  if (movedFiles || isNativeApp()) return;
  movedFiles = true;
  try {
    const old = await loadMessagesWithBlobs();
    if (!old.length || !(await opfsSupported())) return;
    for (const m of old) {
      if (!m.blob || m.blob.size < 256 * 1024 || m.locked) continue; // small ones may stay
      const name = await blobToOpfs(m.blob, m.mid.replace(/[^0-9a-z]/gi, '').slice(0, 16) || 'f', m.file?.name ?? 'file');
      if (!name) return;
      const { blob: _drop, ...rest } = m;
      await putMessage({ ...rest, opfs: name });
    }
  } catch (e) {
    console.warn('P2P Talk: could not move old files', e);
  }
}

// ---- groups (sender keys, members carry messages for each other; plan §8.6) --------------------------

let groups: GroupManager | null = null;
let groupsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let gconv: { gid: string; list: HTMLElement; count: HTMLElement; pillSlot: HTMLElement } | null = null;

/** "Call on · Join" in the group chat while its call runs and I'm not in it (late join, or rejoin). */
function drawJoinPill(): void {
  if (!gconv) return;
  const gid = gconv.gid;
  const open = gcm?.joinable(gid) ?? [];
  gconv.pillSlot.replaceChildren(open.length
    ? h('button', { class: 'join-pill', 'data-testid': 'group-call-join', type: 'button', onclick: () => void gcm?.join(open[0].callId).catch((e: Error) => toast(e.message)) },
        icon('phone', 16), h('span', {}, 'Call on · Join'))
    : '');
}

function startGroups(): void {
  groups = new GroupManager({ secretKey: me!.secretKey, publicKey: me!.publicKey, name: me!.name }, { connect: (id) => void connectMember(id) });
  const g = groups;
  void loadGroupsState().then((st) => {
    if (st && g === groups) g.importState(st as GroupsState);
    void hub?.refresh();
    void renderList();
  });
  g.on('invite', (info) => {
    void loadBlocked().then(async (blocked) => {
      const inviter = info.members.find((m) => m.p2pId === info.createdBy);
      const invited = g.list().filter((x) => x.status === 'invited');
      // Spam limits (M-7): invites from blocked people, or more than 20 waiting, are declined quietly.
      if ((inviter && blocked.includes(inviter.identityKey)) || invited.length > 20) await g.declineInvite(info.id);
      void saveGroupsNow();
      void renderList();
    });
  });
  g.on('group', (info) => {
    toHost('group', hostGroup(info));
    void saveGroupsNow();
    askGroupPictures();
    void hub?.refresh();
    void renderList();
    if (gconv?.gid === info.id) {
      gconv.count.textContent = `${info.members.length} members`;
      renderGroupSide();
    }
  });
  g.on('removed', (info) => {
    toHost('group', hostGroup(info));
    void saveGroupsNow();
    void hub?.refresh();
    if (gconv?.gid === info.id) clearMain();
    void renderList();
  });
  g.on('conflict', () => toast('Another admin changed the group at the same time. Try again.'));
  g.on('message', (m) => {
    if (gcm?.onGroupMessage(m)) return; // a group call invite / end: never a chat bubble
    void onGroupMessage(m);
  });
  startGroupCalls(g);
}

// ---- group calls (small mesh: one direct connection per pair; 8 on voice, 6 on video) -------------

let gcm: GroupCallManager | null = null;

function startGroupCalls(g: GroupManager): void {
  gcm?.destroy();
  const m = gcm = new GroupCallManager({
    me: { secretKey: me!.secretKey, publicKey: me!.publicKey, name: me!.name },
    groups: g,
    iceServers: ICE_SERVERS,
    // Over the locked chat channel; rejects when not connected (then the manager connects first).
    send: async (to, f) => {
      const p = peers.get(to);
      if (!p?.ready || !p.supports(GROUP_CALL_FEATURE)) throw new Error('offline');
      await p.sendFrame(f);
    },
    connect: async (to) => {
      const c = (await loadContact(to)) ?? memberAsContact(to);
      if (!c) throw new Error('offline');
      const p = await reach(c);
      await p.whenReady();
    },
    fanout: (gid, f) => g.send(gid, { gcall: f }).then(() => undefined),
    busy: () => [...peers.values()].some((p) => p.inCallNow),
  });
  const gHost = (): GroupCallHost => ({ myId: myId(), myName: me!.name, note: toast, ended: (gid, text) => void groupCallEnded(gid, text), hosted: hostMode });
  const draw = () => renderGroupCall(m, gHost());
  m.on('invite', (c) => {
    toHost('groupCall', hostGroupCall(c));
    toHost('call', hostGroupCallState(c));
    draw();
    if (tab === 'groups') refreshListSoon();
  });
  m.on('call', (c) => {
    toHost('groupCall', hostGroupCall(c));
    toHost('call', hostGroupCallState(c));
    renderGroupCall(m, gHost(), c);
    drawJoinPill();
    if (tab === 'groups') refreshListSoon(); // "Call on · Join" in the Groups list
  });
  m.on('participant', draw);
  m.on('speaker', draw);
  m.on('screen', draw);
  m.on('localStream', draw);
}

/** A group call ended and its screen closed by itself: back to the group's chat, with how it ended. */
async function groupCallEnded(gid: string, text: string): Promise<void> {
  if (!me) return;
  if (!groups?.get(gid) || (locks.isLocked(`g:${gid}`) && !locks.isOpen)) return toast(text);
  if (gconv?.gid !== gid) await openGroup(gid);
  if (gconv?.gid !== gid) return toast(text);
  gconv.list.append(h('div', { class: 'note plain call-note', 'data-testid': 'call-end-note' }, icon('phone', 14), h('span', {}, `${text} · ${time(Date.now())}`)));
  gconv.list.scrollTop = gconv.list.scrollHeight;
}

/** Something waits for a group member I'm not connected to: connect (a contact, or a group-member link). */
async function connectMember(id: string): Promise<void> {
  if (peers.get(id)?.ready || connectingTo.has(id)) return;
  const c = (await loadContact(id)) ?? memberAsContact(id);
  if (c) await reach(c).catch(() => undefined);
}

/** A group member who is not a contact, as something hub.connectTo can use (built-in relays). */
function memberAsContact(id: string): Contact | null {
  for (const info of groups?.list() ?? []) {
    const m = info.members.find((x) => x.p2pId === id);
    if (m) return { id, publicKey: m.identityKey, name: m.name, lastSeen: 0, relays: searchRelays() };
  }
  return null;
}

/** Saves the groups now: a join / leave / new group must survive the app closing right after (BUG-10). */
async function saveGroupsNow(): Promise<void> {
  if (groupsSaveTimer) clearTimeout(groupsSaveTimer);
  groupsSaveTimer = null;
  if (groups) await saveGroupsState(groups.exportState());
}

function saveGroupsSoon(): void {
  if (groupsSaveTimer) return;
  groupsSaveTimer = setTimeout(() => {
    groupsSaveTimer = null;
    if (groups) void saveGroupsState(groups.exportState());
  }, 300);
}

const memberName = (g: GroupInfo, id: string) => (id === myId() ? 'You' : g.members.find((m) => m.p2pId === id)?.name || shortId(id));
const groupText = (body: unknown) => (typeof (body as { text?: unknown })?.text === 'string' ? String((body as { text: string }).text).slice(0, 20000) : '');

async function onGroupMessage(m: GroupMessage): Promise<void> {
  const text = groupText(m.body);
  if (!text) return;
  const key = groups?.get(m.gid)?.members.find((x) => x.p2pId === m.from)?.identityKey;
  if (key && (await loadBlocked()).includes(key)) return; // someone I blocked (or reported)
  const mine = m.from === myId();
  const gid = `g:${m.gid}`;
  const stored = await locks.store({ peer: gid, from: mine ? 'me' : 'them', text, ts: m.ts, mid: m.mid, fromName: m.fromName, fromId: m.from });
  toHost('groupMessage', hostGroupMessage(m.gid, m.from, m.fromName, m.mid, text, m.ts));
  saveGroupsSoon();
  if (!mine) owe(m.from, [m.mid], 'd', m.gid); // delivered, to the member who wrote it
  if (gconv?.gid === m.gid) {
    appendGroupMessage({ peer: gid, from: mine ? 'me' : 'them', text, ts: m.ts, mid: m.mid, fromName: m.fromName });
    void markRead(gid, stored);
    if (!mine) seenOnScreen(gid, m.mid, m.from);
  } else if (locks.isLocked(gid) && !mine && !muted.has(gid)) toast('New message'); // a locked group: no name, no text
  refreshListSoon();
}

function appendGroupNote(text: string): void {
  if (!gconv) return;
  gconv.list.append(h('div', { class: 'note plain wrap', 'data-testid': 'group-note' }, text));
  gconv.list.scrollTop = gconv.list.scrollHeight;
}

function appendGroupMessage(m: ChatMessage): void {
  if (!gconv) return;
  dayMark(gconv.list, m.ts);
  const mine = m.from === 'me';
  gconv.list.append(h('div', { class: `bub ${mine ? 'me' : 'th'}`, 'data-testid': `gmsg-${m.from}`, 'data-ts': String(m.ts), 'data-mid': m.mid,
    ...(mine ? { title: 'Hold for message info', oncontextmenu: (e: Event) => (e.preventDefault(), void messageInfo(gconv!.gid, m.mid)), onpointerdown: (e: Event) => holdForInfo(e, gconv!.gid, m.mid) } : {}) },
    m.from === 'them' ? h('div', { class: 'gfrom', 'data-testid': 'gmsg-from' }, m.fromName || 'Someone') : null,
    h('span', { class: 'tx' }, m.text), h('time', { class: 'tm' }, time(m.ts), mine ? tickEl(statusOf(m)) : null)));
  gconv.list.scrollTop = gconv.list.scrollHeight;
}

const asMember = (c: Contact): GroupMember => ({ p2pId: c.id, identityKey: c.publicKey, name: c.name });

async function pickContacts(exclude: string[] = []): Promise<{ el: HTMLElement; chosen: () => Contact[] }> {
  const contacts = (await loadContacts()).filter((c) => !exclude.includes(c.id));
  const boxes = contacts.map((c) => {
    const box = h('input', { type: 'checkbox', 'data-testid': 'group-pick' }) as HTMLInputElement;
    return { c, box, row: h('label', { class: 'kv tap' }, avatar(c.name || '?', c.id, 36), h('div', { class: 'k one-line' }, c.name || shortId(c.id)), box) };
  });
  return {
    el: boxes.length ? h('div', { class: 'card' }, ...boxes.map((b) => b.row)) : h('p', { class: 'muted' }, 'Add some contacts first.'),
    chosen: () => boxes.filter((b) => b.box.checked).map((b) => b.c),
  };
}

async function newGroupScreen(): Promise<void> {
  const name = h('input', { class: 'field', maxlength: '60', placeholder: 'Group name', 'data-testid': 'group-name-input', 'aria-label': 'Group name' }) as HTMLInputElement;
  const pick = await pickContacts();
  const err = errorBox();
  flow('new-group', 'New group',
    h('section', { class: 'card pad' }, name),
    h('div', { class: 'sec' }, 'MEMBERS (UP TO 50)'),
    pick.el,
    err.el,
    h('button', { class: 'btn pri', 'data-testid': 'group-create', type: 'button', onclick: async () => {
      const chosen = pick.chosen();
      if (!name.value.trim()) return err.set('Give the group a name.');
      if (!chosen.length) return err.set('Choose at least one contact.');
      const gid = await groups!.create(name.value.trim(), chosen.map(asMember));
      await saveGroupsNow();
      void openGroup(gid);
    } }, 'Create group'),
    h('p', { class: 'muted small' }, 'Messages go straight to each member, locked. Members who are online pass them on to members who are not.'));
}

async function openGroup(gid: string): Promise<void> {
  const g = groups?.get(gid);
  if (!g || !shell) return;
  await locks.ready;
  if (locks.isLocked(`g:${gid}`) && !locks.isOpen) return askCode(() => openGroup(gid));
  closeSheets();
  stopScan();
  screenGen++;
  conv = null;
  main = { kind: 'chat', id: `g:${gid}` };
  relockIfLeft();
  const list = h('div', { class: 'chat', 'data-testid': 'messages' });
  const count = h('div', { class: 's', 'data-testid': 'group-count' }, `${g.members.length} members`);
  const pillSlot = h('div', { class: 'pill-slot' });
  gconv = { gid, list, count, pillSlot };
  drawJoinPill();
  const input = h('input', { class: 'field', placeholder: 'Message', 'data-testid': 'message-input', maxlength: '4000', enterkeyhint: 'send', 'aria-label': 'Message', autocomplete: 'off' }) as HTMLInputElement;
  const isIn = g.status === 'joined';
  const send = async () => {
    const text = input.value.trim();
    if (!text || !groups) return;
    input.value = '';
    let r: { ts: number; mid: string };
    try {
      r = await groups.send(gid, { text });
    } catch (e) {
      input.value = text; // nothing was sent: the text stays to try again
      return appendGroupNote(`Not sent: ${(e as Error).message}`);
    }
    const m: ChatMessage = { peer: `g:${gid}`, from: 'me', text, ts: r.ts, mid: r.mid, st: 'sent' };
    m.key = await locks.store(m);
    toHost('groupMessage', hostGroupMessage(gid, myId(), me!.name, r.mid, text, r.ts));
    saveGroupsSoon();
    appendGroupMessage(m);
    refreshListSoon();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void send());
  shell.main.replaceChildren(
    h('header', { class: 'hd chat-hd' },
      iconBtn('back', 'Back', { class: 'ib phone-only', 'data-testid': 'chat-back', onclick: () => clearMain() }),
      h('button', { class: 'who', 'data-testid': 'group-info-open', type: 'button', 'aria-label': `About ${g.name}`, onclick: () => groupSheet(gid) },
        avatar(g.name, gid, 38),
        h('div', { class: 'wt' }, h('div', { class: 'n', 'data-testid': 'peer-name' }, g.name), count)),
      isIn ? iconBtn('phone', 'Group voice call', { 'data-testid': 'group-voice-call', onclick: () => void startGroupCall(gid, false) }) : null,
      isIn ? iconBtn('video', 'Group video call', { 'data-testid': 'group-video-call', onclick: () => void startGroupCall(gid, true) }) : null),
    pillSlot,
    list,
    isIn
      ? h('footer', { class: 'compose' },
          iconBtn('plus', 'Send a photo, video or file', { 'data-testid': 'attach', onclick: () => sendSheet(`g:${gid}`) }),
          input,
          h('button', { class: 'send', 'aria-label': 'Send', title: 'Send', 'data-testid': 'send', type: 'button', onclick: () => void send() }, icon('send', 22)))
      : h('footer', { class: 'left-note', 'data-testid': 'group-left-note' }, g.status === 'removed' ? 'You were removed from this group.' : 'You left this group.', ' ',
          h('button', { class: 'chip', type: 'button', 'data-testid': 'group-delete', onclick: () => deleteGroupAsk(gid) }, 'Delete group')),
  );
  renderGroupSide();
  document.body.classList.add('has-main');
  const history = (await locks.read(`g:${gid}`)) ?? [];
  for (const m of history) appendGroupMessage(m);
  const before = (await loadReadMarks())[`g:${gid}`] ?? 0;
  const fresh = history.filter((m) => m.from === 'them' && (m.key ?? 0) > before);
  const senders = new Map<string, string>();
  for (const m of fresh) {
    const who = m.fromId ?? g.members.find((x) => x.name === m.fromName)?.p2pId; // older messages: by name
    if (who) senders.set(m.mid, who);
  }
  readNow(`g:${gid}`, fresh.map((m) => m.mid), senders);
  const lastKey = history.at(-1)?.key;
  if (lastKey) await markRead(`g:${gid}`, lastKey);
  void renderList();
}

async function startGroupCall(gid: string, video: boolean): Promise<void> {
  if (!gcm) return;
  if ([...peers.values()].some((p) => p.inCallNow)) return toast('You are already in a call.');
  try {
    await gcm.start(gid, { video });
  } catch (e) {
    toast((e as Error).message);
  }
}

/**
 * The group's details: members (online dots, admins), Call, Add (admins), Lock, Leave, Report.
 * A sheet on phones; the right-hand details pane on wide screens (≥ 1200 px) while the group is open.
 */
function groupInfoContent(gid: string, big: boolean, redraw: () => void, done: () => void): Child[] {
  const g = groups?.get(gid);
  if (!g) return [];
  const online = g.members.filter((m) => m.p2pId !== myId() && peers.get(m.p2pId)?.isOnline).length;
  return [
    h('div', { class: big ? 'who-big' : 'who-row' }, avatar(g.name, gid, big ? 76 : 52),
      h('div', { class: 'wt' }, h('div', { class: 'n one-line' }, g.name), h('div', { class: 's' }, `${g.members.length} members${online ? ` · ${online} online` : ''}`))),
    big
      ? h('div', { class: 'row2 call-row2' },
          iconBtn('phone', 'Group voice call', { class: 'btn sec2 with-icon', 'data-testid': 'group-side-voice', onclick: () => void startGroupCall(gid, false) }, 'Voice'),
          iconBtn('video', 'Group video call', { class: 'btn sec2 with-icon', 'data-testid': 'group-side-video', onclick: () => void startGroupCall(gid, true) }, 'Video'))
      : null,
    h('div', { class: 'sec' }, 'MEMBERS'),
    h('div', { class: 'card' }, ...g.members.map((m) => h('div', { class: 'kv', 'data-testid': 'group-member' },
      avatar(m.name || '?', m.p2pId, 32, m.p2pId === myId() ? undefined : !!peers.get(m.p2pId)?.isOnline), h('div', { class: 'k one-line' }, m.p2pId === myId() ? 'You' : m.name || shortId(m.p2pId)),
      g.admins.includes(m.p2pId) ? h('div', { class: 'v admin', 'data-testid': 'group-admin' }, 'admin') : null,
      g.iAmAdmin && m.p2pId !== myId() && !g.admins.includes(m.p2pId)
        ? h('button', { class: 'chip', 'data-testid': 'group-make-admin', type: 'button', onclick: async () => {
            await groups?.setAdmin(gid, m.p2pId, true).catch((e: Error) => toast(e.message));
            await saveGroupsNow();
            redraw();
          } }, 'Make admin')
        : null,
      g.iAmAdmin && m.p2pId !== myId()
        ? h('button', { class: 'chip', 'data-testid': 'group-remove', type: 'button', onclick: async () => {
            if (!confirm(`Remove ${m.name || shortId(m.p2pId)} from ${g.name}? They won't read new messages.`)) return;
            await groups?.removeMembers(gid, [m.p2pId]).catch((e: Error) => toast(e.message));
            await saveGroupsNow();
            redraw();
          } }, 'Remove')
        : null,
      m.p2pId === myId() ? null : h('button', { class: 'chip', 'data-testid': 'report-member', type: 'button', onclick: () => void reportPerson(m.name || shortId(m.p2pId), m.p2pId, async () => {
        await hub?.blockKey(m.identityKey);
        const c = await loadContact(m.p2pId);
        if (c) await hub?.blockContact(c);
      }, g.name) }, 'Report')))),
    g.iAmAdmin ? h('div', { class: 'card' }, kvRow('image', 'Group photo', avatarPhoto(gid) ? 'Change' : 'Add', 'group-photo', () => photoMenu(gid))) : null,
    g.iAmAdmin && iconBtn('user-add', 'Add members', { class: 'btn sec2 with-icon', 'data-testid': 'group-add', onclick: async () => {
      done();
      const pick = await pickContacts(g.members.map((m) => m.p2pId));
      flow('group-add', `Add to ${g.name}`, pick.el,
        h('button', { class: 'btn pri', type: 'button', onclick: async () => {
          const chosen = pick.chosen();
          if (chosen.length) await groups!.addMembers(gid, chosen.map(asMember)).catch((e: Error) => toast(e.message));
          await saveGroupsNow();
          void openGroup(gid);
        } }, 'Add'));
    } }, 'Add members'),
    h('div', { class: 'card lock-card' }, lockRow(`g:${gid}`)),
    h('div', { class: 'row2' },
      g.status === 'joined'
        ? h('button', { class: 'btn sec2 dang', 'data-testid': 'group-leave', type: 'button', onclick: () => leaveGroupAsk(gid) }, 'Leave')
        : h('button', { class: 'btn sec2 dang', 'data-testid': 'group-delete-info', type: 'button', onclick: () => deleteGroupAsk(gid) }, 'Delete group'),
      iconBtn('alert', 'Report', { class: 'btn sec2 dang with-icon', 'data-testid': 'group-report', onclick: () => void reportPerson(g.name, `group ${gid}, made by ${g.createdBy}`, async () => {
        await groups?.leave(gid);
        await saveGroupsNow();
        closeSheets();
        clearMain();
      }) }, 'Report')),
  ];
}

function groupSheet(gid: string): void {
  if (wideSide.matches && gconv?.gid === gid) return renderGroupSide(); // the details pane already shows it
  closeSheets();
  const s = sheet('group-info', ...groupInfoContent(gid, false, () => groupSheet(gid), () => s.remove()));
}

/** Wide screens: the open group's details in the right-hand pane (kept current). */
function renderGroupSide(): void {
  if (!shell || !gconv) return;
  if (!wideSide.matches) return void shell.side.replaceChildren();
  const gid = gconv.gid;
  shell.side.replaceChildren(h('div', { class: 'side', 'data-testid': 'group-info' }, ...(groupInfoContent(gid, true, () => renderGroupSide(), () => undefined).filter(Boolean) as Node[])));
}

// ---- details: sheet (phones, up to 1200 px) or side panel ------------------------------------------

function infoContent(big: boolean): Child[] {
  if (!conv) return [];
  const p = peers.get(conv.id);
  const c = conv.contact;
  const key = fromB64url(c.publicKey);
  const name = c.name || shortId(c.id);
  const online = !!p?.isOnline;
  const deviceName = p?.peer?.device?.name ?? c.devices?.[0]?.cert.dn;
  const path = p?.ready ? p.path : { kind: 'offline' as const, networkType: '' };
  const idText = formatId(c.id);
  const connected = path.kind !== 'offline';
  return [
    h('div', { class: big ? 'who-big' : 'who-row' },
      avatar(name, c.id, big ? 76 : 52),
      h('div', { class: 'wt' },
        h('div', { class: 'n one-line' }, name),
        h('div', { class: 's one-line', 'data-testid': 'peer-device' }, deviceName ? icon('mobile', 15) : null, `${deviceName ? `on ${deviceName} · ` : ''}${online ? 'online' : 'offline'}`))),
    avatarPhoto(c.id) ? h('p', { class: 'muted small photo-trust', 'data-testid': 'photo-trust' }, 'The photo is chosen by them. To be sure it’s them, compare the safety pictures.') : null,
    h('div', { class: 'sec' }, 'CHECK IT’S REALLY THEM'),
    h('div', { class: 'card' },
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, h('div', { class: 'lbl' }, 'P2P ID'),
          h('div', { class: 'idt', 'data-testid': 'peer-id' }, h('span', {}, idText.slice(0, 14) + ' '), h('span', {}, idText.slice(15)))),
        iconBtn('copy', 'Copy P2P ID', { onclick: () => void navigator.clipboard?.writeText(c.id).catch(() => undefined) })),
      h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Safety pictures'), h('div', { class: 'pics', 'data-testid': 'peer-emoji', title: 'Their safety pictures' }, emojiCode(key)))),
    h('div', { class: 'sec' }, 'THIS CONNECTION'),
    h('div', { class: 'card', 'data-testid': 'path' },
      h('div', { class: 'kv' }, icon(PATH_ICON[path.kind], 22, connected ? 'ok' : 'soft'), h('div', { class: 'k', 'data-testid': 'path-label' }, PATH_TEXT[path.kind].short), connected ? icon('check', 22, 'ok') : null),
      connected && h('div', { class: 'kv' }, icon('lock', 22, 'ok'), h('div', { class: 'k' }, 'Locked end to end'), icon('check', 22, 'ok')),
      connected && h('div', { class: 'kv' }, icon('shield', 22, 'ok'), h('div', { class: 'k' }, 'Key matches their ID'), icon('check', 22, 'ok'))),
    h('p', { class: 'muted small' }, connected ? PATH_TEXT[path.kind].detail : 'Not connected right now.'),
    h('div', { class: 'card lock-card' }, lockRow(c.id)),
    h('div', { class: 'row2' },
      iconBtn('block', 'Block', { class: 'btn sec2 dang with-icon', 'data-testid': 'block-contact', onclick: () => void blockContact(c) }, 'Block'),
      iconBtn('alert', 'Report', { class: 'btn sec2 dang with-icon', 'data-testid': 'report-contact', onclick: () => void reportPerson(name, c.id, async () => {
        peers.get(c.id)?.close();
        await hub?.blockContact(c);
        closeSheets();
        clearMain();
      }) }, 'Report')),
  ];
}

function openInfo(): void {
  if (!conv) return;
  if (wideSide.matches) return renderInfo(); // the side panel already shows it
  closeSheets();
  sheet('peer-info', ...infoContent(false));
}

/** Keeps the details current (side panel, or the open sheet). */
function renderInfo(): void {
  if (!shell) return;
  if (conv && wideSide.matches) {
    shell.side.replaceChildren(h('div', { class: 'side', 'data-testid': 'peer-info' }, ...infoContent(true)));
    return;
  }
  shell.side.replaceChildren();
  const open = document.querySelector('[data-testid=peer-info]');
  if (open && conv) open.replaceChildren(h('div', { class: 'grab', 'aria-hidden': 'true' }), ...(infoContent(false).filter(Boolean) as Node[]));
}
wideSide.addEventListener('change', () => {
  closeSheets();
  renderInfo();
  renderGroupSide();
});

async function blockContact(c: Contact): Promise<void> {
  if (!confirm(`Block ${c.name || shortId(c.id)}? They can't reach you any more, and they are removed from your contacts.`)) return;
  peers.get(c.id)?.close();
  await hub?.blockContact(c);
  closeSheets();
  clearMain();
}

// ---- calls -------------------------------------------------------------------------------------------

/** Call a contact: on the open connection, or connect first. */
async function callContact(id: string, video: boolean): Promise<void> {
  if (callPeer()?.inCallNow) return;
  let p = peers.get(id);
  if (!p?.ready && !(await loadContact(id))) {
    // Deleted (or blocked) since: they need to be added again first.
    const rec = (await loadCalls()).find((x) => x.peer === id);
    return toast(`${rec?.name || 'This person'} isn’t in your chats any more. Add them again to call.`);
  }
  if (!p?.ready) {
    const c = await loadContact(id);
    try {
      if (!c) throw new Error('offline');
      if (conv?.id !== id) await openConversation(id);
      p = await (connectingTo.get(id) ?? reach(c));
      await new Promise<void>((resolve, reject) => {
        if (p!.ready) return resolve();
        const t = setTimeout(() => reject(new Error('offline')), 15_000);
        p!.on('ready', () => { clearTimeout(t); resolve(); });
      });
    } catch {
      // Still reachable as a closed connection: its call screen says "<name> is offline", with Try again.
      const old = lastPeer.get(id);
      if (old) {
        adopt(old);
        await old.startCall(video);
      } else appendNote(`${c?.name || 'They'} ${c?.name ? 'is' : 'are'} offline · try again later`);
      return;
    }
  }
  await p.startCall(video);
}

// ---- host mode (?embed=1&ui=1, design CN2): these screens inside a host app (Vilnek OS on the Mac) -------
// The host signs in with P2PTalk.start({ words, name, deviceName }); the identity stays in memory (never in
// the page's storage), in the same database headless embed mode uses, so the chats carry over. The host
// hears the same events as in embed mode, plus share, group, groupMessage and groupCall, and can open a
// chat, a group or a tab (P2PTalk.ui). Docs: docs/HOST_MODE.md.

/** Contacts the host asked to connect to (online dots): their chat doesn't open by itself. ID → when. */
const hostQuiet = new Map<string, number>();
let hostStarting = false;

function hostWaiting(): void {
  firstRun(brand(), waiting('Waiting for Vilnek OS…', 'host-waiting'));
}

/** Host mode: an invite link (or my connect card's link) was shared or copied: the host app shares it. */
function shareToHost(link: string, kind: 'invite' | 'card', expires?: number): void {
  toHost('share', { link, name: me?.name ?? '', kind, expires: expires ?? null });
}

function hostNeed(): StoredMe {
  if (!me) throw new Error('Call P2PTalk.start() first.');
  return me;
}

function hostMeInfo() {
  const m = hostNeed();
  return {
    id: p2pId(m.publicKey),
    name: m.name,
    emoji: emojiCode(m.publicKey),
    publicKey: toB64url(m.publicKey),
    deviceName: device?.name ?? '',
    deviceCode: device ? deviceCode(device.publicKey) : '',
    kept: false,
  };
}

const hostPathOf = (p: Peer) => ({ kind: p.path.kind, label: PATH_TEXT[p.path.kind].label });
const HOST_OFFLINE = { kind: 'offline', label: PATH_TEXT.offline.label };

/** A contact's picture (checked by net/photos.ts) as a data: URL. */
function hostPhoto(id: string): string | null {
  const p = pics[id];
  if (!p) return null;
  const b64 = toB64url(p.b).replace(/-/g, '+').replace(/_/g, '/');
  return `data:${p.t};base64,${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
}

function hostContact(c: Contact) {
  const p = peers.get(c.id);
  return {
    photo: hostPhoto(c.id),
    id: c.id,
    name: c.name,
    emoji: c.emoji ?? emojiCode(fromB64url(c.publicKey)),
    online: !!p?.isOnline,
    lastSeen: p?.lastSeen || c.lastSeen,
    path: p ? hostPathOf(p) : HOST_OFFLINE,
    device: p?.peer?.device?.name ?? c.devices?.[0]?.cert.dn ?? null,
    locked: locks.isLocked(c.id),
  };
}

function hostPeerContact(p: Peer) {
  const info = p.peer!;
  return {
    photo: hostPhoto(info.id),
    id: info.id,
    name: info.name,
    emoji: emojiCode(info.publicKey),
    online: p.isOnline,
    lastSeen: p.lastSeen,
    path: hostPathOf(p),
    device: info.device?.name ?? null,
    locked: locks.isLocked(info.id),
  };
}

const hostCallData = (p: Peer, c: CallInfo) => ({
  contactId: p.peer?.id ?? '',
  state: c.state,
  video: c.video,
  outgoing: c.outgoing,
  reason: c.failure ?? null,
  connectedAt: c.connectedAt ?? null,
});

const HOST_STATUS: Partial<Record<string, string>> = { wait: 'waiting', sent: 'sent', d: 'delivered', r: 'read' };

/** A 1:1 message. A locked chat's text never leaves the page (only that something came). */
function hostMessage(contactId: string, from: 'me' | 'them', mid: string, text: string, ts: number, st?: string) {
  const locked = locks.isLocked(contactId);
  return { contactId, from, mid, text: locked ? '' : text, ts, ...(st && HOST_STATUS[st] ? { status: HOST_STATUS[st] } : {}), ...(locked ? { locked: true } : {}) };
}

function hostGroupMessage(gid: string, senderId: string, senderName: string, mid: string, text: string, ts: number) {
  const locked = locks.isLocked(`g:${gid}`);
  return {
    groupId: gid,
    groupName: groups?.get(gid)?.name ?? '',
    from: me && senderId === myId() ? 'me' : 'them',
    senderId,
    senderName,
    mid,
    text: locked ? '' : text,
    ts,
    ...(locked ? { locked: true } : {}),
  };
}

const hostGroup = (g: GroupInfo) => ({
  groupId: g.id,
  name: g.name,
  status: g.status,
  iAmAdmin: g.iAmAdmin,
  admins: [...g.admins],
  members: g.members.map((m) => ({ id: m.p2pId, name: m.name })),
  locked: locks.isLocked(`g:${g.id}`),
});

const hostGroupCall = (c: GroupCallInfo) => ({
  groupId: c.gid,
  groupName: c.groupName,
  callId: c.callId,
  state: c.state,
  video: c.video,
  by: c.by,
  byName: c.byName,
  reason: c.reason ?? null,
  canJoin: c.canJoin,
});

/** When I joined each group call (for connectedAt in "call" events). */
const groupJoinedAt = new Map<string, number>();
const GROUP_CALL_STATE: Record<GroupCallInfo['state'], string> = { incoming: 'incoming', joined: 'connected', missed: 'missed', declined: 'ended', ended: 'ended' };

/**
 * A group call as a "call" event too (the host's Record button and call watch follow "call"):
 * {contactId: "g:<group id>", group: true, groupId, groupName, state, video, outgoing, reason, connectedAt}.
 * joined → "connected"; declined → "ended" (reason "declined").
 */
function hostGroupCallState(c: GroupCallInfo) {
  if (c.state === 'joined' && !groupJoinedAt.has(c.callId)) groupJoinedAt.set(c.callId, Date.now());
  const connectedAt = c.state === 'joined' ? groupJoinedAt.get(c.callId)! : groupJoinedAt.get(c.callId) ?? null;
  if (c.state !== 'joined' && c.state !== 'incoming') groupJoinedAt.delete(c.callId);
  return {
    contactId: `g:${c.gid}`,
    group: true,
    groupId: c.gid,
    groupName: c.groupName,
    callId: c.callId,
    state: GROUP_CALL_STATE[c.state] ?? c.state,
    video: c.video,
    outgoing: !!me && c.by === myId(),
    reason: c.state === 'declined' ? 'declined' : c.reason ?? null,
    connectedAt,
  };
}

const hostDeviceRow = (d: { cert: { dk: string; dn: string }; seen: number }) => ({ name: d.cert.dn, code: deviceCode(d.cert.dk), seen: d.seen });

/** A file's progress (1:1 transfers, also a group's files to each member): in the page with the file itself. */
function hostFile(t: TransferInfo): void {
  if (!hostMode) return;
  const d = { contactId: t.peerId, fid: t.id, name: t.name, size: t.size, type: t.mime, from: t.dir === 'out' ? 'me' : 'them', done: t.bytes, speed: t.speed, eta: t.eta, state: t.state };
  toHost('file', { ...d, blob: t.result?.file ?? null }, d);
}

/** The 1:1 call going on (also a call to someone offline, on their last connection). */
function hostCallPeer(): Peer | null {
  const live = [...peers.values()].find((p) => p.inCallNow);
  if (live) return live;
  const shown = callPeer();
  return shown?.inCallNow ? shown : null;
}

const NORMAL_DB = 'p2ptalk';

/**
 * Where host mode keeps this identity's chats: the normal app's database when it holds this same identity
 * (P2P Talk opened normally on this origin with the same 24 words: one set of chats for both, nothing
 * copied), otherwise the one headless embed mode uses. Another identity's data is never opened for use.
 */
async function hostDatabase(pub: Uint8Array): Promise<string> {
  if (await databaseExists(NORMAL_DB)) {
    try {
      useDatabase(NORMAL_DB);
      const stored = await loadMe();
      if (stored && toB64url(stored.publicKey) === toB64url(pub)) return NORMAL_DB;
    } catch {
      /* can't be read here: keep them apart */
    }
  }
  return dbFor(pub);
}

/**
 * Using the normal app's database: the chats headless embed mode kept for this identity (contacts and
 * messages; it has no groups, locks or secrets to carry) are added to it once. The embedded database
 * stays as it is.
 */
async function carryOverEmbedded(pub: Uint8Array): Promise<void> {
  const from = dbFor(pub);
  if (await loadFlag(`carried:${from}`)) return;
  const { contacts, messages } = await readOtherChats(from).catch(() => ({ contacts: [] as Contact[], messages: [] as ChatMessage[] }));
  const have = new Set((await loadContacts()).map((c) => c.id));
  for (const c of contacts) if (!have.has(c.id)) await saveContact(c);
  for (const m of messages.sort((a, b) => a.ts - b.ts)) {
    if (m.locked || m.note || !m.peer || !m.mid) continue;
    if (await findStoredMessage(m.peer, m.mid)) continue;
    const copy: ChatMessage = { ...m };
    delete copy.key;
    await addMessage(copy);
  }
  await saveFlag(`carried:${from}`);
}

const HOST_TTL: Record<string, number> = { '1h': 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };

export interface HostStartOptions {
  /** The 24 words (from the host, which keeps them sealed). */
  words?: string;
  name?: string;
  deviceName?: string;
}

const hostApi = {
  /** {protocol, build, features}: features include "hostui" (the screens are on). */
  version: () => ({ protocol: PROTOCOL_VERSION, build: __BUILD__, features: [...FEATURES, HOST_UI_FEATURE] }),

  /** 24 new words, for a new account (the host shows them and keeps them; the page keeps nothing). */
  newWords: () => newPhrase(),

  async start(o: HostStartOptions & { resume?: boolean; keep?: boolean; secretKey?: string }) {
    if (me || hostStarting) throw new Error('Already started. Call P2PTalk.stop() first.');
    if (o?.resume || o?.keep) throw new Error('This page never keeps the identity: give the 24 words each time.');
    if (typeof o?.words !== 'string' || !o.words.trim()) throw new Error('Give the 24 words.');
    hostStarting = true;
    try {
      const id = await identityFromPhrase(o.words);
      const dbName = await hostDatabase(id.publicKey);
      useDatabase(dbName);
      if (dbName === NORMAL_DB) await carryOverEmbedded(id.publicKey);
      me = { secretKey: id.secretKey, publicKey: id.publicKey, name: String(o.name ?? '').slice(0, 40), created: Date.now() }; // memory only
      device = await ensureDevice(me, o.deviceName);
      start();
      const info = hostMeInfo();
      toHost('ready', info);
      return info;
    } catch (e) {
      me = null;
      device = null;
      throw e;
    } finally {
      hostStarting = false;
    }
  },

  /** Closes every connection and forgets the identity (the chats stay in this page's database). */
  stop() {
    if (!me) return;
    if (groupsSaveTimer) void saveGroupsNow();
    dropConnections();
    closeCallView();
    forgetSession();
    hostQuiet.clear();
    groupJoinedAt.clear();
    main = { kind: 'none' };
    conv = null;
    gconv = null;
    tab = 'chats';
    hostWaiting();
  },

  me: () => hostMeInfo(),

  async setName(name: string) {
    hostNeed().name = String(name).slice(0, 40);
    startHub();
    void renderList();
    return hostMeInfo();
  },

  async setDeviceName(name: string) {
    const m = hostNeed();
    const n = cleanDeviceName(String(name));
    if (!n || !device) throw new Error('Give a device name.');
    device = renameDevice(m.secretKey, m.publicKey, device, n);
    await saveDevice(device);
    startHub();
    return hostMeInfo();
  },

  async myDevices() {
    hostNeed();
    return (await loadMyDevices()).map(hostDeviceRow);
  },

  async contacts() {
    hostNeed();
    return (await loadContacts()).sort((a, b) => b.lastSeen - a.lastSeen).map(hostContact);
  },

  /** A chat's messages (a locked chat: none; its text stays in the page). */
  async history(contactId: string) {
    hostNeed();
    const id = String(contactId);
    if (locks.isLocked(id)) return [];
    return (await loadMessages(id)).map((m) => ({ from: m.from, mid: m.mid, text: m.text, ts: m.ts, ...(m.st ? { status: m.st } : {}) }));
  },

  async markRead(contactId: string, mids: string[]) {
    hostNeed();
    const p = peers.get(String(contactId));
    if (!p?.ready || !p.supports(RCPT_FEATURE) || !Array.isArray(mids) || !mids.length) return false;
    await p.sendFrame({ k: 'rcpt', mids: mids.map(String).slice(0, 200), st: 'r' });
    return true;
  },

  async makeInvite(o: { ttl?: '1h' | '24h' | '7d'; name?: string } = {}) {
    const m = hostNeed();
    const relays = await myRelays();
    const ttlMs = testInviteTtl ? testInviteTtl * 1000 : HOST_TTL[o.ttl ?? '24h'] ?? HOST_TTL['24h'];
    const { card, boxSecret, link } = newCard(m.secretKey, m.publicKey, relays, Date.now(), { invite: true, ttlMs, name: o.name ?? m.name });
    const inviteId = toHex(card.boxId);
    await saveInvite({ id: inviteId, link, boxSecret, created: Date.now(), expires: card.expires, relays, status: 'waiting', blocked: [] });
    await hub?.refresh();
    return { link, inviteId, expires: card.expires };
  },

  /** Someone's link: the screens ask "Connect?" first (nothing is sent before the person taps Connect). */
  async openLink(link: string) {
    hostNeed();
    const text = cardTextFrom(String(link));
    if (!text) throw new Error('This is not a P2P Talk link.');
    const card = decodeCard(text);
    void askAboutLink(String(link));
    return { state: 'asking', contactId: p2pId(card.identityKey) };
  },

  requests() {
    return [...(hub?.requests ?? new Map<string, { invite: { id: string }; req: ContactRequest }>())].map(([requestId, r]) => ({
      requestId,
      inviteId: r.invite.id,
      id: p2pId(fromB64url(r.req.k)),
      name: r.req.n,
      note: r.req.note,
    }));
  },

  async accept(requestId: string) {
    const c = await hub?.accept(String(requestId));
    if (!c) throw new Error('No such request.');
    void renderList();
    toHost('contact', hostContact(c));
    return hostContact(c);
  },

  async block(requestId: string) {
    await hub?.block(String(requestId));
    void renderList();
  },

  async blockContact(contactId: string) {
    const c = await loadContact(String(contactId));
    peers.get(String(contactId))?.close();
    if (c) await hub?.blockContact(c);
    void renderList();
  },

  /** Connect to a contact (resolves when the chat is open). Their chat doesn't open on screen by itself. */
  async connect(contactId: string) {
    hostNeed();
    const id = String(contactId);
    if (peers.get(id)?.ready) return;
    const c = await loadContact(id);
    if (!c) throw new Error('Not a contact.');
    if (!hub) throw new Error('Not started.');
    if (!connectingTo.has(id)) hostQuiet.set(id, Date.now());
    try {
      const p = await reach(c);
      await p.whenReady(15_000);
    } catch (e) {
      hostQuiet.delete(id);
      throw e;
    }
  },

  /** Send a text (shown in the chat when it is open). */
  async send(contactId: string, text: string) {
    const id = String(contactId);
    const p = peers.get(id);
    if (!p?.ready) throw new Error('offline');
    const sent = await p.sendText(String(text));
    const m: ChatMessage = { peer: id, from: 'me', text: String(text), ts: sent.ts, mid: sent.mid, st: 'sent' };
    m.key = await locks.store(m);
    if (conv?.id === id) appendMessage(m);
    refreshListSoon();
    return sent;
  },

  /** Call a contact: P2P Talk's own call screen (states also arrive as "call" events). */
  async call(contactId: string, o: { video?: boolean } = {}) {
    hostNeed();
    const id = String(contactId);
    if (hostCallPeer() || gcm?.inCall) throw new Error('Already in a call.');
    await callContact(id, !!o.video);
    if (!hostCallPeer()) toHost('call', { contactId: id, state: 'failed', video: !!o.video, outgoing: true, reason: 'offline', connectedAt: null });
  },

  async acceptCall() {
    await [...peers.values()].find((p) => p.call.state === 'incoming')?.acceptCall();
  },

  async declineCall() {
    await [...peers.values()].find((p) => p.call.state === 'incoming')?.declineCall();
  },

  async hangUp() {
    await hostCallPeer()?.hangUp();
  },

  setMicOn: (on: boolean) => hostCallPeer()?.setMicOn(!!on),
  setCameraOn: (on: boolean) => hostCallPeer()?.setCameraOn(!!on),

  async replaceVideoTrack(track: MediaStreamTrack | null) {
    const p = hostCallPeer();
    if (!p) throw new Error('No call.');
    await p.replaceVideoTrack(track);
  },

  async startScreenShare() {
    const p = hostCallPeer();
    if (!p) throw new Error('No call.');
    await p.startScreenShare();
  },

  async stopScreenShare() {
    await hostCallPeer()?.stopScreenShare();
  },

  setScreenSound(on: boolean) {
    hostCallPeer()?.setScreenSound(!!on);
  },

  connectionDetails: () => report(lastAttempt()),

  getLocalStream: () => hostCallPeer()?.localStream ?? null,
  getRemoteStream: () => hostCallPeer()?.remoteStream ?? null,

  /** The host records this 1:1 call: the other side sees "● <name> is recording", this call screen "● Recording". */
  async setRecording(on: boolean) {
    const p = hostCallPeer();
    if (!p) throw new Error('No call.');
    await p.setRecording(!!on);
    renderCall(p, p.call, callHost);
  },

  /** My groups (also announced by "group" events). */
  groups() {
    hostNeed();
    return (groups?.list() ?? []).map(hostGroup);
  },

  /** Opens a chat, a group or a tab on screen. Resolves false when there is no such chat or group. */
  ui: {
    async open(contactId: string) {
      hostNeed();
      const id = String(contactId);
      if (id.startsWith('g:')) return hostApi.ui.openGroup(id.slice(2));
      if (!(await loadContact(id))) return false;
      if (!shell) buildShell();
      if (tab !== 'chats') setTab('chats');
      await openConversation(id); // a locked chat asks for the secret code first
      return true;
    },
    async openGroup(gid: string) {
      hostNeed();
      const id = String(gid);
      if (!groups?.get(id)) return false;
      if (!shell) buildShell();
      if (tab !== 'groups') setTab('groups');
      await openGroup(id);
      return true;
    },
    show(t: HostTab) {
      hostNeed();
      if (!isHostTab(t)) throw new Error('Give chats, groups, calls, add or me.');
      if (!shell) buildShell();
      setTab(t);
      return true;
    },
  },

  on: (event: HostEventName, fn: (data: unknown) => void) => hostOn(event, fn),
  off: (event: HostEventName, fn: (data: unknown) => void) => hostOff(event, fn),
};

export type P2PTalkHostApi = typeof hostApi;

function startHostMode(): void {
  document.body.classList.add('hostui');
  hostWaiting();
  (window as unknown as { P2PTalk: P2PTalkHostApi }).P2PTalk = hostApi;
  toHost('loaded', hostApi.version());
}

// ---- start ---------------------------------------------------------------------------------------------

/** The start animation: removes itself after ~3 s, tap to skip; skipped for tests (?nosplash=1, automated browsers). */
function splash(): void {
  const el = document.getElementById('p2p-splash');
  if (!el) return;
  if (query.get('splash') !== '1' && (query.get('nosplash') === '1' || navigator.webdriver)) {
    el.remove();
    return;
  }
  el.addEventListener('animationend', (e) => {
    if (e.target === el && e.animationName === 'splash-out') el.remove();
  });
  el.addEventListener('click', () => (el.style.animation = 'splash-out .25s ease forwards'));
}

/** Moves a link from the address into memory (and this tab's storage). True if there was one. */
function takeHashLink(): boolean {
  const hash = location.hash.slice(1);
  if (!(hash.startsWith('P2P1.') || hash.startsWith('c='))) return false;
  rememberLink('#' + hash);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

/**
 * "Away" (a small 'bye' frame, PROTOCOL.md §presence): sent when the page is hidden or closed, so the
 * other side shows offline at once; 'back' when it is in front again. Not during a call (a call goes on
 * in the background). Older builds ignore both, and their ~12 s timeout still applies.
 */
let away = false;
function sayAway(hidden: boolean): void {
  if (hidden === away) return;
  away = hidden;
  for (const p of peers.values()) if (p.ready && !p.inCallNow) void p.setAway(hidden).catch(() => undefined);
}

/** Test-only hooks (?testHooks=1): never in normal use. */
function testHooks(): void {
  if (testFlag('testHooks') !== '1') return;
  (window as unknown as { __p2pTest: object }).__p2pTest = {
    /** Holds back every receipt (no ticks go out) until called with false. */
    noReceipts: (on: boolean) => {
      testNoReceipts = on;
    },
    /** Drops every open connection (as if the network went away). */
    drop: () => {
      for (const p of peers.values()) p.close();
    },
    /** Open connections: who, which device, which attempt. */
    peers: () => [...peers].map(([id, p]) => ({ id, ready: p.ready, device: p.peer?.device?.name ?? null, attempt: p.diag.kind, main: main.kind })),
    /** Total received sound energy over every connection (WebRTC stats), to check sound is flowing. */
    audioEnergy: async () => {
      let e = 0;
      for (const p of peers.values()) (await p.pc.getStats()).forEach((r) => r.type === 'inbound-rtp' && r.kind === 'audio' && (e += r.totalAudioEnergy ?? 0));
      return e;
    },
  };
}

async function boot(): Promise<void> {
  installPhoneScreenShare(); // the Android and iPhone apps: phones share their own screen (no-op elsewhere)
  // Back in front (Android stops the camera in the background): a fresh camera for the call.
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    if (!hidden) for (const p of peers.values()) void p.refreshCameraIfEnded();
    lockInBackground(hidden); // locked chats close after 1 minute in the background
    sayAway(hidden);
    if (!hidden) flushSeen(); // read receipts for what arrived while the page was hidden
    if (hidden && groupsSaveTimer) void saveGroupsNow(); // BUG-10: nothing waits in the debounce when the app goes away
  });
  // Closing the page (or the app): tell contacts at once, so they show "offline" now, not ~12 s later.
  addEventListener('pagehide', () => {
    sayAway(true);
    if (groupsSaveTimer) void saveGroupsNow();
  });
  // The phone apps (Capacitor) also fire pause / resume on the document.
  document.addEventListener('pause', () => {
    lockInBackground(true);
    sayAway(true);
    if (groupsSaveTimer) void saveGroupsNow();
  });
  document.addEventListener('resume', () => (lockInBackground(false), sayAway(false)));
  testHooks();
  if (hostMode) {
    // Host mode (?embed=1&ui=1): the screens, signed in by the host app (never the home page).
    document.getElementById('p2p-splash')?.remove();
    startHostMode();
    return;
  }
  if (query.get('embed') === '1') {
    document.getElementById('p2p-splash')?.remove();
    startEmbed();
    return;
  }
  splash();
  RelayPool.onStored = (r) => void addPublished(r);
  if (!window.RTCPeerConnection || !window.indexedDB || !crypto.subtle) {
    firstRun(brand(), h('section', { class: 'card pad' }, h('h2', {}, 'This browser can’t run P2P Talk'), h('p', {}, 'Open this page in a recent Chrome, Safari, Edge or Firefox, from a secure (https) address.')));
    return;
  }
  // A link in the address (#c=… or #P2P1.…): keep it until its join is done, and clean the address.
  takeHashLink();
  // A link opened while the page is already open changes only the part after "#": no reload.
  addEventListener('hashchange', () => {
    if (!takeHashLink()) return;
    const link = takeLink();
    if (!link) return;
    if (me && shell) void askAboutLink(link);
    else if (!me) joinScreen(link);
  });
  me = (await loadMe()) ?? null;
  if (me) {
    device = await ensureDevice(me);
    start();
  } else {
    const link = takeLink();
    if (link) joinScreen(link);
    else welcome();
  }
}

void boot();
