import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { CONNECTED, join, makeAccount, openInfo, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Host mode (?embed=1&ui=1, design CN2): P2P Talk's own screens inside Vilnek OS on the Mac, signed in by the
// host (P2PTalk.start), with events to the host's WebKit message handler. A fake handler records them here.
// LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

type Ev = { event: string; data: Record<string, unknown> };
declare global {
  interface Window {
    P2PTalk: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    __host: Ev[];
    __streams: { kind: string; isStream: boolean }[];
  }
}

/** Vilnek OS's side: window.webkit.messageHandlers.p2ptalk (plain data only, as WebKit would copy it). */
async function hostPage(label: string, context?: BrowserContext): Promise<Page> {
  const ctx = context ?? (await people.context({ viewport: { width: 1280, height: 800 } }));
  const page = await people.page(ctx, label);
  await page.addInitScript(() => {
    window.__host = [];
    (window as unknown as { webkit: object }).webkit = {
      messageHandlers: { p2ptalk: { postMessage: (m: Ev) => window.__host.push(JSON.parse(JSON.stringify(m))) } },
    };
  });
  await page.goto(people.q('&embed=1&ui=1'));
  await page.waitForFunction(() => !!window.P2PTalk);
  return page;
}

const hostEvents = (page: Page, e: string) => page.evaluate((name) => window.__host.filter((x) => x.event === name).map((x) => x.data), e);
async function waitHost(page: Page, e: string, match: Record<string, unknown> = {}, timeout = 30_000): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      found = (await hostEvents(page, e)).find((d) => Object.entries(match).every(([k, v]) => d?.[k] === v));
      return !!found;
    }, { timeout })
    .toBe(true);
  return found!;
}

/** No identity is kept in any of the page's databases or its storage. */
async function nothingKept(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (localStorage.getItem('p2ptalk-embed-last')) return false;
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const me = await new Promise<unknown>((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) return resolve(undefined), db.close();
          const get = db.transaction('kv').objectStore('kv').get('me');
          get.onsuccess = () => (resolve(get.result), db.close());
          get.onerror = () => (resolve(undefined), db.close());
        };
        req.onerror = () => resolve(undefined);
      });
      if (me !== undefined) return false;
    }
    return true;
  });
}

test('host mode: screens signed in by the host, no account screens, ui API, events, share, chat, call, recording, groups', async () => {
  const a = await hostPage('A');

  // "loaded" with "hostui"; the page waits for the host (never the home page or an account screen).
  const loaded = await waitHost(a, 'loaded');
  expect(loaded.features).toEqual(expect.arrayContaining(['hostui', 'chat', 'call', 'rec']));
  expect((await a.evaluate(() => window.P2PTalk.version())).features).toContain('hostui');
  await expect(a.getByTestId('host-waiting')).toBeVisible();
  await expect(a.getByText('Waiting for Vilnek OS…')).toBeVisible();
  for (const id of ['make-account', 'restore', 'join-screen', 'tab-chats']) await expect(a.getByTestId(id)).toHaveCount(0);
  await expect(a.evaluate(() => window.P2PTalk.ui.show('chats'))).rejects.toThrow(/start\(\) first/);

  // The host signs in (the words are the host's; nothing secret is kept by the page).
  await expect(a.evaluate(() => window.P2PTalk.start({ words: window.P2PTalk.newWords(), keep: true }))).rejects.toThrow(/never keeps/);
  const words = await a.evaluate(() => window.P2PTalk.newWords());
  const meA = await a.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay', deviceName: 'Mac (Vilnek OS)' }), words);
  expect(meA.id).toMatch(/^\d{24}$/);
  expect(meA.kept).toBe(false);
  expect((await waitHost(a, 'ready')).id).toBe(meA.id);
  await expect(a.getByTestId('tab-chats')).toBeVisible();
  await expect(a.getByTestId('host-waiting')).toHaveCount(0);
  expect(await nothingKept(a)).toBe(true);
  // In-page listeners get the MediaStreams themselves (the host's recorder uses them).
  await a.evaluate(() => {
    window.__streams = [];
    window.P2PTalk.on('stream', (d: { kind: string; stream: unknown }) => window.__streams.push({ kind: d.kind, isStream: d.stream instanceof MediaStream }));
  });

  // Me: the account belongs to Vilnek OS (no words, no delete).
  await tab(a, 'me');
  await expect(a.getByTestId('host-managed')).toHaveText('Account managed by Vilnek OS');
  await expect(a.getByTestId('my-name')).toHaveText('Dr Vijay');
  await expect(a.getByTestId('my-device-line')).toHaveText('This device: Mac (Vilnek OS)');
  await expect(a.getByTestId('me-words')).toHaveCount(0);
  await expect(a.getByTestId('delete-account')).toHaveCount(0);
  await expect(a.getByTestId('me-chat-lock')).toBeVisible();
  await a.getByTestId('me-devices').click();
  await expect(a.getByTestId('host-managed-devices')).toContainText('Account managed by Vilnek OS');

  // ui.show: each tab.
  for (const t of ['groups', 'calls', 'add', 'me', 'chats'] as const) {
    expect(await a.evaluate((x) => window.P2PTalk.ui.show(x), t)).toBe(true);
    await expect(a.getByTestId(`tab-${t}`)).toHaveAttribute('aria-current', 'page');
  }
  await expect(a.evaluate(() => window.P2PTalk.ui.show('home'))).rejects.toThrow();
  expect(await a.evaluate(() => window.P2PTalk.ui.open('000000000000000000000000'))).toBe(false);
  expect(await a.evaluate(() => window.P2PTalk.ui.openGroup('nope'))).toBe(false);

  // An invite link made on the Add screen: Copy and Share both go to the host ("share").
  await a.evaluate(() => window.P2PTalk.ui.show('add'));
  await a.getByTestId('share-invite').click();
  await a.getByTestId('make-invite').click();
  const link = await a.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/^https:\/\/p2p\.vilnek\.in\/#c=/);
  await a.getByTestId('copy-invite').click();
  await a.getByTestId('share-invite-link').click();
  await expect.poll(async () => (await hostEvents(a, 'share')).length).toBe(2);
  expect(await hostEvents(a, 'share')).toEqual([
    expect.objectContaining({ link, name: 'Dr Vijay', kind: 'invite' }),
    expect.objectContaining({ link, name: 'Dr Vijay', kind: 'invite' }),
  ]);

  // A normal browser (Ravi) opens it: they connect; the host hears "contact" and the chat opens on screen.
  const b = await people.page(undefined, 'B');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  const ravi = await waitHost(a, 'contact', { name: 'Ravi', online: true });
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });

  // Chat both ways: typed in P2P Talk's screen → "message" from me; theirs → "message" from them.
  await a.getByTestId('message-input').fill('Namaste from Vilnek OS');
  await a.getByTestId('send').click();
  expect(await waitHost(a, 'message', { from: 'me' })).toEqual(expect.objectContaining({ contactId: ravi.id, text: 'Namaste from Vilnek OS' }));
  await expect(b.getByTestId('msg-them').last()).toContainText('Namaste from Vilnek OS', { timeout: 20_000 });
  await b.getByTestId('message-input').fill('Hello');
  await b.getByTestId('send').click();
  expect((await waitHost(a, 'message', { from: 'them' })).text).toBe('Hello');
  await expect(a.getByTestId('msg-them').last()).toContainText('Hello');
  await waitHost(a, 'message-status', { status: 'read' });

  // A file from Ravi: the host hears "file" (plain data), the page shows it.
  await b.getByTestId('attach').click();
  const chooser = b.waitForEvent('filechooser');
  await b.getByTestId('pick-files').click();
  await (await chooser).setFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Seva report '.repeat(500)) });
  expect(await waitHost(a, 'file', { from: 'them', state: 'done' })).toEqual(expect.objectContaining({ contactId: ravi.id, name: 'report.txt', size: 6000 }));
  await expect(a.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });

  // ui.open: back from another tab to the chat.
  await a.evaluate(() => window.P2PTalk.ui.show('me'));
  expect(await a.evaluate((id) => window.P2PTalk.ui.open(id), ravi.id)).toBe(true);
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi');
  await expect(a.getByTestId('tab-chats')).toHaveAttribute('aria-current', 'page');

  // A video call from P2P Talk's own call screen; the host hears its states and gets the streams.
  await a.getByTestId('video-call').click();
  await b.getByTestId('accept').click({ timeout: 20_000 });
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await waitHost(a, 'call', { contactId: ravi.id, state: 'connected', video: true });
  await expect.poll(async () => (await hostEvents(a, 'stream')).some((d) => d.kind === 'remote' && (d.tracks as string[]).includes('video')), { timeout: 15_000 }).toBe(true);
  expect(await a.evaluate(() => window.__streams.some((s) => s.kind === 'remote' && s.isStream))).toBe(true);
  expect(await a.evaluate(() => window.P2PTalk.getRemoteStream()?.getVideoTracks().length)).toBe(1);
  // Share screen is there (this browser can capture).
  await expect(a.getByTestId('screen-share')).toBeVisible();

  // Vilnek OS records: "● Recording" here, "● Dr Vijay is recording" on Ravi's side.
  await expect(a.getByTestId('call-rec')).toBeHidden();
  await a.evaluate(() => window.P2PTalk.setRecording(true));
  await expect(a.getByTestId('call-rec')).toBeVisible();
  await expect(a.getByTestId('call-rec')).toHaveText('Recording');
  await expect(b.getByTestId('call-rec')).toHaveText('Dr Vijay is recording');
  await a.evaluate(() => window.P2PTalk.setRecording(false));
  await expect(a.getByTestId('call-rec')).toBeHidden();
  await expect(b.getByTestId('call-rec')).toBeHidden();
  await a.getByTestId('hang-up').click();
  await waitHost(a, 'call', { contactId: ravi.id, state: 'ended' });
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });

  // A group with Ravi: "group", "groupMessage" both ways, ui.openGroup, and a group call ("groupCall").
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('peer-name')).toHaveText('Seva team');
  const group = await waitHost(a, 'group', { name: 'Seva team' });
  await tab(b, 'groups');
  await b.getByTestId('group-join').click({ timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Seva team');
  await a.getByTestId('message-input').fill('Namaste team');
  await a.getByTestId('send').click();
  expect(await waitHost(a, 'groupMessage', { from: 'me' })).toEqual(expect.objectContaining({ groupId: group.groupId, groupName: 'Seva team', text: 'Namaste team', senderName: 'Dr Vijay' }));
  await expect(b.getByTestId('gmsg-them').last()).toContainText('Namaste team', { timeout: 20_000 });
  await b.getByTestId('message-input').fill('Hi all');
  await b.getByTestId('send').click();
  expect(await waitHost(a, 'groupMessage', { from: 'them' })).toEqual(expect.objectContaining({ groupId: group.groupId, text: 'Hi all', senderId: ravi.id, senderName: 'Ravi' }));
  expect(await a.evaluate(() => window.P2PTalk.groups())).toEqual([expect.objectContaining({ groupId: group.groupId, name: 'Seva team', status: 'joined' })]);
  await a.evaluate(() => window.P2PTalk.ui.show('calls'));
  expect(await a.evaluate((gid) => window.P2PTalk.ui.openGroup(gid), group.groupId as string)).toBe(true);
  await expect(a.getByTestId('peer-name')).toHaveText('Seva team');
  await expect(a.getByTestId('tab-groups')).toHaveAttribute('aria-current', 'page');
  await a.getByTestId('group-voice-call').click();
  await waitHost(a, 'groupCall', { groupId: group.groupId, state: 'joined', video: false });
  // Also as a "call" event (the host's Record button follows "call"): state, video, connectedAt.
  const gcall = await waitHost(a, 'call', { contactId: `g:${group.groupId}`, state: 'connected' });
  expect(gcall).toEqual(expect.objectContaining({ group: true, groupId: group.groupId, groupName: 'Seva team', video: false, outgoing: true }));
  expect(typeof gcall.connectedAt).toBe('number');
  await b.getByTestId('gcall-join').click({ timeout: 20_000 });
  await expect(a.locator('[data-testid=gcall-tile][data-state=connected]')).toHaveCount(1, { timeout: 40_000 });
  await a.getByTestId('gcall-leave').click();
  await waitHost(a, 'groupCall', { groupId: group.groupId, state: 'ended' });
  await waitHost(a, 'call', { contactId: `g:${group.groupId}`, state: 'ended', group: true });

  // Sign out (the host's stop): back to waiting; the same words start again with the same chats.
  await a.evaluate(() => window.P2PTalk.stop());
  await expect(a.getByTestId('host-waiting')).toBeVisible();
  await expect(a.getByTestId('tab-chats')).toHaveCount(0);
  await a.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay', deviceName: 'Mac (Vilnek OS)' }), words);
  await expect(a.getByTestId('tab-chats')).toBeVisible();
  expect((await a.evaluate(() => window.P2PTalk.contacts())).map((c: { name: string }) => c.name)).toEqual(['Ravi']);
  expect(await a.evaluate((id) => window.P2PTalk.history(id), ravi.id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ from: 'me', text: 'Namaste from Vilnek OS' }), expect.objectContaining({ from: 'them', text: 'Hello' })]),
  );
  expect(await nothingKept(a)).toBe(true);

  // The host's connect (online dots) doesn't open the chat by itself.
  await a.evaluate((id) => window.P2PTalk.connect(id), ravi.id as string);
  await waitHost(a, 'contact', { id: ravi.id, online: true });
  await a.waitForTimeout(1000);
  await expect(a.getByTestId('peer-name')).toHaveCount(0);

  // Chat lock: a locked chat's text never goes to the host (only that a message came).
  expect(await a.evaluate((id) => window.P2PTalk.ui.open(id), ravi.id)).toBe(true);
  const info = await openInfo(a);
  await info.getByTestId('lock-chat').click();
  await expect(a.getByTestId('set-code-sheet')).toBeVisible();
  await a.getByTestId('code-new').fill('2580');
  await a.getByTestId('code-again').fill('2580');
  await a.getByTestId('code-set').click();
  await expect(a.getByTestId('toast')).toContainText('Chat locked');
  await tab(b, 'chats');
  await b.getByTestId('contact').filter({ hasText: 'Dr Vijay' }).click();
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay');
  await b.getByTestId('message-input').fill('Secret plan for Diwali');
  await b.getByTestId('send').click();
  expect(await waitHost(a, 'message', { from: 'them', locked: true })).toEqual(expect.objectContaining({ contactId: ravi.id, text: '' }));
  expect(JSON.stringify(await a.evaluate(() => window.__host))).not.toContain('Secret plan');
  expect(await a.evaluate((id) => window.P2PTalk.history(id), ravi.id)).toEqual([]);
  people.onlyLocal();
});

test('host mode: a reload never signs in by itself; headless embed (no ui=1) stays without screens or "hostui"', async () => {
  const a = await hostPage('A');
  await a.evaluate(() => window.P2PTalk.start({ words: window.P2PTalk.newWords(), name: 'Dr Vijay' }));
  await expect(a.getByTestId('tab-chats')).toBeVisible();
  await a.reload();
  await a.waitForFunction(() => !!window.P2PTalk);
  await expect(a.getByTestId('host-waiting')).toBeVisible();
  await expect(a.getByTestId('tab-chats')).toHaveCount(0);
  await expect(a.evaluate(() => window.P2PTalk.me())).rejects.toThrow(/start\(\) first/);

  const h = await people.page(undefined, 'H');
  await h.goto(people.q('&embed=1'));
  await h.waitForFunction(() => !!window.P2PTalk);
  expect((await h.evaluate(() => window.P2PTalk.version())).features).not.toContain('hostui');
  expect(await h.evaluate(() => typeof window.P2PTalk.ui)).toBe('undefined');
  await expect(h.locator('#app')).toBeEmpty();
  people.onlyLocal();
});

test('host mode: no screen capture in the window → Share screen says so plainly', async () => {
  const a = await hostPage('A');
  await a.evaluate(() => {
    // As in a web view without screen capture.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
  });
  await a.evaluate(() => window.P2PTalk.start({ words: window.P2PTalk.newWords(), name: 'Dr Vijay' }));
  await a.evaluate(() => window.P2PTalk.ui.show('add'));
  await a.getByTestId('share-invite').click();
  await a.getByTestId('make-invite').click();
  const link = await a.getByTestId('invite-link').inputValue();
  const b = await people.page(undefined, 'B');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  const ravi = await waitHost(a, 'contact', { name: 'Ravi', online: true });
  // The host starts the call (as Vilnek OS's Call button does), then opens the chat in the page.
  await a.evaluate((id) => window.P2PTalk.call(id, { video: true }), ravi.id as string);
  await b.getByTestId('accept').click({ timeout: 20_000 });
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('share-error')).toHaveText('This window can’t share the screen.');
  await a.evaluate(() => window.P2PTalk.hangUp());
  await waitHost(a, 'call', { state: 'ended' });
  people.onlyLocal();
});

test('host mode: the same 24 words as the normal app here → the same chats; headless embed chats carried over once; another identity sees none', async () => {
  const ctx = await people.context({ viewport: { width: 1280, height: 800 } });
  // P2P Talk opened normally on this origin (as Vilnek OS's own browser does), chatting with Ravi.
  const n = await people.page(ctx, 'N');
  await n.goto(people.q());
  const words = await makeAccount(n, 'Dr Vijay');
  const link = await makeInvite(n);
  const b = await people.page(undefined, 'B');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(n.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await n.getByTestId('message-input').fill('From the normal app');
  await n.getByTestId('send').click();
  await expect(b.getByTestId('msg-them').last()).toContainText('From the normal app', { timeout: 20_000 });
  // Close the normal app only once the sent message is in its database (a slow CI runner can lag).
  await expect.poll(() => n.evaluate(() => new Promise<boolean>((resolve) => {
    const r = indexedDB.open('p2ptalk');
    r.onsuccess = () => {
      const all = r.result.transaction('messages').objectStore('messages').getAll();
      all.onsuccess = () => (r.result.close(), resolve(all.result.some((m: { text?: string }) => m.text === 'From the normal app')));
      all.onerror = () => (r.result.close(), resolve(false));
    };
    r.onerror = () => resolve(false);
  })), { timeout: 15_000 }).toBe(true);
  await n.close();

  // Headless embed mode had kept a chat for the same words (its own database).
  const e = await people.page(ctx, 'E');
  await e.goto(people.q('&embed=1'));
  await e.waitForFunction(() => !!window.P2PTalk);
  await e.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay' }), words);
  await e.evaluate(() => window.P2PTalk.stop());
  const meera = await e.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? '').find((x) => x.startsWith('p2ptalk-embed-'))!;
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const id = '123456789012345678901234';
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        const tx = r.result.transaction(['contacts', 'messages'], 'readwrite');
        tx.objectStore('contacts').put({ id, publicKey: key, name: 'Meera', lastSeen: Date.now(), relays: [] });
        tx.objectStore('messages').add({ peer: id, from: 'them', text: 'Hello from the embed days', ts: Date.now(), mid: 'm-embed-1' });
        tx.oncomplete = () => (r.result.close(), resolve());
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
    return id;
  });
  await e.close();

  // Host mode with the same words: the normal app's chats (nothing copied) plus the embedded one.
  const a = await hostPage('A', ctx);
  const meA = await a.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay', deviceName: 'Mac (Vilnek OS)' }), words);
  const names = (await a.evaluate(() => window.P2PTalk.contacts())).map((c: { name: string }) => c.name).sort();
  expect(names).toEqual(['Meera', 'Ravi']);
  const ravi = (await a.evaluate(() => window.P2PTalk.contacts())).find((c: { name: string }) => c.name === 'Ravi');
  expect(await a.evaluate((id) => window.P2PTalk.history(id), ravi.id)).toEqual([expect.objectContaining({ from: 'me', text: 'From the normal app' })]);
  expect(await a.evaluate((id) => window.P2PTalk.history(id), meera)).toEqual([expect.objectContaining({ from: 'them', text: 'Hello from the embed days' })]);
  await expect(a.getByTestId('contact')).toHaveCount(2);
  // Once only: starting again adds nothing twice.
  await a.evaluate(() => window.P2PTalk.stop());
  await a.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay' }), words);
  expect(await a.evaluate((id) => window.P2PTalk.history(id), meera)).toHaveLength(1);
  // The normal app's account is still there (host mode never deletes it), and its ID is the same.
  const normalMe = await a.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const r = indexedDB.open('p2ptalk');
        r.onsuccess = () => {
          const g = r.result.transaction('kv').objectStore('kv').get('me');
          g.onsuccess = () => (resolve(g.result !== undefined), r.result.close());
        };
      }),
  );
  expect(normalMe).toBe(true);
  expect(meA.id).toMatch(/^\d{24}$/);

  // Another identity on the same page: none of these chats.
  await a.evaluate(() => window.P2PTalk.stop());
  await a.evaluate(() => window.P2PTalk.start({ words: window.P2PTalk.newWords(), name: 'Someone else' }));
  expect(await a.evaluate(() => window.P2PTalk.contacts())).toEqual([]);
  await expect(a.getByTestId('contact')).toHaveCount(0);
  people.onlyLocal();
});
