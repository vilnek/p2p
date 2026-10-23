// The small transport interface that files.ts and groups.ts are written against, so both can be
// tested without WebRTC (tests use an in-memory pair) and wired to a real connection later.
//
// Two kinds of Channel are used (see docs/INTEGRATION_FILES_GROUPS.md):
//   - the LOCKED 1:1 chat channel of a Peer: JSON objects only (each one locked with the session lock);
//   - a DEDICATED RTCDataChannel per file transfer (label `file:<id>`, ordered, reliable): binary
//     frames only. Chunks on it are locked with a per-file AES-256-GCM key, which travels inside the
//     locked chat channel, so the app-level lock is kept on top of DTLS.

export type Frame = object | Uint8Array;

export interface Channel {
  /** Sends one frame. JSON objects on the locked chat channel; Uint8Array on a file data channel. */
  send(frame: Frame): Promise<void>;
  /** Every received frame. Returns an "unsubscribe" function. */
  onFrame(cb: (frame: Frame) => void): () => void;
  /** Bytes queued and not yet sent (RTCDataChannel.bufferedAmount), for back-pressure. */
  bufferedAmount?(): number;
  /**
   * Resolves when bufferedAmount() is at or below `below` (RTCDataChannel: bufferedAmountLowThreshold
   * + the `bufferedamountlow` event). Optional: without it, the sender polls bufferedAmount().
   */
  drained?(below: number): Promise<void>;
  /** Closes the underlying data channel (only used for dedicated file channels). */
  close?(): void;
  /** 24-digit P2P ID of the other side. */
  readonly peerId: string;
}

export const isBytes = (f: unknown): f is Uint8Array => f instanceof Uint8Array;

/** Waits until a channel's queue is at or below `below` bytes. */
export async function waitDrained(ch: Channel, below: number, pollMs = 10): Promise<void> {
  if (!ch.bufferedAmount || ch.bufferedAmount() <= below) return;
  if (ch.drained) return ch.drained(below);
  while (ch.bufferedAmount() > below) await new Promise((r) => setTimeout(r, pollMs));
}

/**
 * A Channel over one dedicated, binary RTCDataChannel (a file transfer channel, label `file:<id>`).
 * Resolves once the data channel is open. Frames must be Uint8Array (JSON objects are refused).
 */
export function rtcBinaryChannel(dc: RTCDataChannel, peerId: string): Promise<Channel> {
  dc.binaryType = 'arraybuffer';
  const listeners = new Set<(f: Frame) => void>();
  dc.addEventListener('message', (e: MessageEvent) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const f = new Uint8Array(e.data);
    for (const cb of [...listeners]) cb(f);
  });
  const ch: Channel = {
    peerId,
    async send(frame) {
      if (!isBytes(frame)) throw new Error('binary frames only on a file channel');
      if (dc.readyState !== 'open') throw new Error('channel closed');
      dc.send(frame as Uint8Array<ArrayBuffer>);
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    bufferedAmount: () => dc.bufferedAmount,
    drained(below) {
      if (dc.bufferedAmount <= below || dc.readyState !== 'open') return Promise.resolve();
      return new Promise((resolve) => {
        dc.bufferedAmountLowThreshold = below;
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
      });
    },
    close: () => {
      try {
        dc.close();
      } catch {
        /* already closed */
      }
    },
  };
  if (dc.readyState === 'open') return Promise.resolve(ch);
  return new Promise((resolve, reject) => {
    dc.addEventListener('open', () => resolve(ch), { once: true });
    dc.addEventListener('close', () => reject(new Error('channel closed')), { once: true });
  });
}
