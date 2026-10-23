// Screen sharing in the phone apps. Android's WebView has no getDisplayMedia, and iPhone's can't
// share the phone's screen, so the app's "ScreenCapture" plugin captures it and sends JPEG frames;
// here they become a normal video track, and the rest of the app (peer.ts, groupCall.ts) shares it
// exactly like a desktop browser's screen.
//   Android (native/, ScreenCapturePlugin.java): the phone's own "share your screen?" question.
//   iPhone (native/, ScreenCapturePlugin.swift + the ScreenShare extension): iOS's Start Broadcast
//   sheet; the whole screen, other apps too, while P2P Talk keeps the call going in the background.
//   Frames: binary through the page's "P2PScreen" object when the Android WebView can, else base64 in
//   the plugin's "frame" event (always on iPhone).
//   Sound (getDisplayMedia({ audio: true }); Android 10+, iPhone): what other apps play, 48 kHz PCM
//   a few ms at a time, played into an audio track (AudioWorklet; ScriptProcessor when it can't).
//   Stop in the notification / iOS's red status pill (or the phone ends it): the tracks stop and fire 'ended'.
//   The app stops the video track: the plugin stops too.
// Does nothing in browsers, or when the plugin is missing.

interface Handle {
  remove(): Promise<void>;
}

interface ScreenPlugin {
  start(o: ShareOptions & { binary: boolean }): Promise<{ width: number; height: number; channels?: number }>;
  stop(): Promise<void>;
  addListener(event: 'frame', fn: (e: { data: string }) => void): Handle | Promise<Handle>;
  addListener(event: 'audio', fn: (e: { data: string; channels: number }) => void): Handle | Promise<Handle>;
  addListener(event: 'stopped', fn: (e: { reason: string }) => void): Handle | Promise<Handle>;
}

interface CapacitorGlobal {
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: { ScreenCapture?: ScreenPlugin };
  registerPlugin?: (name: string) => ScreenPlugin;
}

/** Injected by the app into its own page only (WebViewCompat web message listener). */
interface NativePort {
  postMessage(m: string): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

/** Chrome's track made from frames we write (works while the app is in the background). */
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
type GeneratorClass = new (o: { kind: 'video' }) => TrackGenerator;

export interface ShareOptions {
  fps: number;
  maxWidth: number;
  maxHeight: number;
  audio: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(x)));

/** One number from a constraint: 10, { max: 10 }, { ideal: 10 }, { exact: 10 }. */
function pick(c: ConstrainDouble | ConstrainULong | undefined): number | undefined {
  if (typeof c === 'number') return Number.isFinite(c) ? c : undefined;
  if (c && typeof c === 'object') return c.max ?? c.exact ?? c.ideal;
  return undefined;
}

/** getDisplayMedia's constraints -> what the phone sends. Default: 10 frames a second, at most 1280 px each way, no sound. */
export function shareOptions(c?: DisplayMediaStreamOptions): ShareOptions {
  const v = c?.video;
  if (v === false) throw new TypeError('Screen sharing needs video.');
  const o: MediaTrackConstraints = typeof v === 'object' ? v : {};
  return {
    fps: clamp(pick(o.frameRate) ?? 10, 1, 30),
    maxWidth: clamp(pick(o.width) ?? 1280, 160, 1920),
    maxHeight: clamp(pick(o.height) ?? 1280, 160, 1920),
    audio: !!c?.audio,
  };
}

/**
 * The app calls track.stop(): run onAppStop once (stops the phone's capture).
 * Returns end(): the phone stopped it; the track stops and fires 'ended' (track.stop() alone
 * doesn't, and the app listens for 'ended' to go back to the camera).
 */
export function endable(track: MediaStreamTrack, onAppStop: () => void): () => void {
  const stop = track.stop.bind(track);
  let done = false;
  track.stop = () => {
    stop();
    if (!done) {
      done = true;
      onAppStop();
    }
  };
  return () => {
    if (done) return;
    done = true;
    stop();
    track.dispatchEvent(new Event('ended'));
  };
}

// ---- sound -----------------------------------------------------------------------------------------

const RATE = 48000;

/**
 * Sound waiting to be played: interleaved chunks in, blocks of samples out, one array per channel.
 * Waits for 60 ms before playing (and again after running dry); keeps at most 300 ms (drops the
 * oldest), so the delay stays small. Self-contained (no outside names, no class fields): the
 * AudioWorklet gets its source text.
 */
export class Ring {
  declare ch: number;
  declare q: Float32Array[];
  declare at: number;
  declare frames: number;
  declare waiting: boolean;
  constructor(channels: number) {
    this.ch = channels;
    this.q = [];
    this.at = 0;
    this.frames = 0;
    this.waiting = true;
  }
  push(chunk: Float32Array): void {
    this.q.push(chunk);
    this.frames += chunk.length / this.ch;
    while (this.frames > 48000 * 0.3 && this.q.length > 1) {
      const old = this.q.shift() as Float32Array;
      this.frames -= (old.length - this.at) / this.ch;
      this.at = 0;
    }
  }
  pull(out: Float32Array[]): void {
    const n = out[0].length;
    let i = 0;
    if (this.waiting && this.frames >= 48000 * 0.06) this.waiting = false;
    while (!this.waiting && i < n) {
      const c = this.q[0];
      if (!c) {
        this.waiting = true; // ran dry: wait for 60 ms again
        break;
      }
      for (let k = 0; k < out.length; k++) out[k][i] = c[this.at + Math.min(k, this.ch - 1)];
      this.at += this.ch;
      this.frames--;
      i++;
      if (this.at >= c.length) {
        this.q.shift();
        this.at = 0;
      }
    }
    for (; i < n; i++) for (let k = 0; k < out.length; k++) out[k][i] = 0;
  }
}

const WORKLET = `const Ring = (${Ring.toString()});
registerProcessor('p2p-screen-sound', class extends AudioWorkletProcessor {
  constructor(o) { super(); const r = new Ring(o.processorOptions.channels); this.r = r; this.port.onmessage = (e) => r.push(e.data); }
  process(_, outputs) { this.r.pull(outputs[0]); return true; }
});`;

/** 16-bit samples -> -1…1. */
export function toFloat(pcm: Int16Array): Float32Array<ArrayBuffer> {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
}

/** The phone's sound as an audio track: feed it 16-bit interleaved PCM at 48 kHz. */
async function soundTrack(channels: number): Promise<{ track: MediaStreamTrack; feed: (pcm: Int16Array) => void; close: () => void }> {
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const dest = ctx.createMediaStreamDestination();
  let feed: ((f: Float32Array<ArrayBuffer>) => void) | null = null;
  if (ctx.audioWorklet) {
    // The worklet's code comes from a blob: URL; a strict content policy (no blob: scripts) refuses
    // it, and then the ScriptProcessor below plays the sound instead.
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'p2p-screen-sound', { numberOfInputs: 0, outputChannelCount: [channels], processorOptions: { channels } });
      node.connect(dest);
      feed = (f) => node.port.postMessage(f, [f.buffer]);
    } catch {
      feed = null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!feed) {
    // No AudioWorklet (old WebViews, or the content policy): the same ring, on the page's own thread.
    const ring = new Ring(channels);
    const sp = ctx.createScriptProcessor(1024, 1, channels);
    sp.onaudioprocess = (e) => ring.pull(Array.from({ length: channels }, (_, k) => e.outputBuffer.getChannelData(k)));
    sp.connect(dest);
    feed = (f) => ring.push(f);
  }
  await ctx.resume().catch(() => undefined);
  return { track: dest.stream.getAudioTracks()[0], feed: (pcm) => feed(toFloat(pcm)), close: () => void ctx.close().catch(() => undefined) };
}

/** A binary message from the app: "PCM" + channels + samples, or a JPEG frame. */
export function isSound(b: ArrayBuffer): boolean {
  const h = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  return h.length === 4 && h[0] === 0x50 && h[1] === 0x43 && h[2] === 0x4d;
}

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The share now running (one at a time). */
let current: { end: () => void } | null = null;

async function share(plugin: ScreenPlugin, constraints?: DisplayMediaStreamOptions): Promise<MediaStream> {
  const opt = shareOptions(constraints);
  current?.end();
  const port = (window as unknown as { P2PScreen?: NativePort }).P2PScreen;

  // The track: written frame by frame when possible, else a canvas.
  const Generator = (window as unknown as { MediaStreamTrackGenerator?: GeneratorClass }).MediaStreamTrackGenerator;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let track: MediaStreamTrack;
  let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  if (Generator && typeof VideoFrame === 'function') {
    const g = new Generator({ kind: 'video' });
    writer = g.writable.getWriter();
    track = g;
  } else {
    track = canvas.captureStream(opt.fps).getVideoTracks()[0];
  }
  track.contentHint = 'detail'; // text stays sharp

  let last: ImageBitmap | null = null;
  let lastAt = 0;
  let next: Blob | null = null;
  let busy = false;
  let ended = false;
  let sound: Awaited<ReturnType<typeof soundTrack>> | null = null;

  const draw = async (bmp: ImageBitmap) => {
    lastAt = performance.now();
    if (writer) {
      const f = new VideoFrame(bmp, { timestamp: Math.round(lastAt * 1000) });
      try {
        await writer.write(f);
      } finally {
        f.close();
      }
    } else if (ctx) {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
    }
  };

  // Decode only the newest frame; frames that arrive while busy replace each other.
  const push = (jpeg: Blob) => {
    next = jpeg;
    if (!busy) void drain();
  };
  const drain = async () => {
    busy = true;
    while (next && !ended) {
      const b = next;
      next = null;
      try {
        const bmp = await createImageBitmap(b);
        if (ended) {
          bmp.close();
          break;
        }
        last?.close();
        last = bmp;
        await draw(bmp);
      } catch {
        // a damaged frame: skip it
      }
    }
    busy = false;
  };

  // A still screen sends no frames; repeat the last one each second so a lost picture recovers.
  const again = setInterval(() => {
    if (last && !busy && performance.now() - lastAt > 1000) void draw(last).catch(() => undefined);
  }, 1000);

  const handles: (Handle | Promise<Handle>)[] = []; // a handle, or a promise of one (Capacitor versions differ)
  const cleanup = () => {
    ended = true;
    clearInterval(again);
    for (const h of handles.splice(0)) void Promise.resolve(h).then((x) => x.remove()).catch(() => undefined);
    if (port) port.onmessage = null;
    last?.close();
    last = null;
    void writer?.close().catch(() => undefined);
    sound?.track.stop();
    sound?.close();
    if (current === session) current = null;
  };
  // Only a share that started is stopped on the phone: a start that failed (for example "busy",
  // because the first tap's sheet is still open) must not cancel the one still starting.
  let started = false;
  const end = endable(track, () => {
    if (started) void plugin.stop().catch(() => undefined);
    cleanup();
  });
  const session = {
    end: () => {
      const a = sound?.track;
      cleanup();
      end();
      a?.dispatchEvent(new Event('ended'));
    },
  };

  // Frames and sound: binary when the app can, base64 otherwise.
  if (port) {
    port.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      if (isSound(e.data)) sound?.feed(new Int16Array(e.data, 4));
      else push(new Blob([e.data], { type: 'image/jpeg' }));
    };
    port.postMessage('hello'); // lets the app answer this page
  }
  handles.push(plugin.addListener('frame', (e) => push(new Blob([b64ToBytes(e.data)], { type: 'image/jpeg' }))));
  handles.push(plugin.addListener('audio', (e) => sound?.feed(new Int16Array(b64ToBytes(e.data).buffer))));
  handles.push(
    plugin.addListener('stopped', () => {
      if (current === session) session.end();
    }),
  );

  let channels = 0;
  try {
    channels = (await plugin.start({ ...opt, binary: !!port })).channels ?? 0;
    started = true;
  } catch (e) {
    cleanup();
    track.stop();
    const err = e as { code?: string; message?: string };
    if (err?.code === 'cancelled') throw new DOMException('Screen sharing was cancelled.', 'NotAllowedError');
    throw new DOMException(err?.message || 'Screen sharing could not start.', 'AbortError');
  }
  current = session;
  // The phone's sound (asked for, and Android 10+). If it can't play here: the screen alone.
  if (opt.audio && channels > 0) {
    const s = await soundTrack(channels).catch(() => null);
    if (s && ended) s.close();
    else sound = s;
  }
  return new MediaStream(sound ? [track, sound.track] : [track]);
}

/**
 * Puts the phone's getDisplayMedia in place. false: not yet possible (the iPhone's web view can start
 * the page before navigator.mediaDevices exists; installPhoneScreenShare tries again).
 */
function installNow(cap: CapacitorGlobal, platform: string): boolean {
  const md = navigator.mediaDevices as MediaDevices | undefined;
  // A newer Android WebView with its own getDisplayMedia keeps it.
  if (platform === 'android') {
    if (!md || typeof md.getDisplayMedia === 'function') return true;
  }
  // iPhone: WebKit's own getDisplayMedia only captures the app itself (which is capture-proof, so it
  // would send a blank picture), so it is always replaced; on MediaDevices itself, so every copy of
  // navigator.mediaDevices gets it.
  const proto = (globalThis as unknown as { MediaDevices?: { prototype: MediaDevices } }).MediaDevices?.prototype;
  const target = platform === 'ios' ? proto ?? md : md;
  if (!target) return false;
  const plugin = cap.Plugins?.ScreenCapture ?? cap.registerPlugin?.('ScreenCapture');
  if (!plugin) return true;
  void plugin.stop().catch(() => undefined); // the page reloaded while sharing: end that share
  const gdm = (c?: DisplayMediaStreamOptions) => share(plugin, c);
  target.getDisplayMedia = gdm;
  if (md && md !== target && Object.prototype.hasOwnProperty.call(md, 'getDisplayMedia')) md.getDisplayMedia = gdm;
  return true;
}

/** In the Android and iPhone apps: give the page a getDisplayMedia that shares the phone's screen. */
export function installPhoneScreenShare(retryMs = 1000, tries = Infinity): void {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  const platform = cap?.getPlatform?.();
  if (!cap || (platform !== 'android' && platform !== 'ios') || !cap.isPluginAvailable?.('ScreenCapture')) return;
  if (installNow(cap, platform)) return;
  let left = tries;
  const again = setInterval(() => {
    if (installNow(cap, platform) || --left <= 0) clearInterval(again);
  }, retryMs);
}
