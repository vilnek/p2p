import { describe, expect, it } from 'vitest';
import { utf8 } from '../../src/core/bytes';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { newEphemeral, SessionLock } from '../../src/core/lock';
import { SerialQueue } from '../../src/core/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('received frames: one throw does not stop the later ones (interop fix 1a)', () => {
  it('keeps the chain alive and reports the error', async () => {
    const errors: unknown[] = [];
    const q = new SerialQueue((e) => errors.push(e));
    const done: number[] = [];
    q.push(async () => done.push(1));
    q.push(async () => {
      throw new Error('bad session description after decrypting');
    });
    q.push(async () => done.push(3));
    q.push(() => {
      throw new Error('wrong-state answer');
    });
    q.push(async () => done.push(5));
    await q.idle();
    expect(done).toEqual([1, 3, 5]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['bad session description after decrypting', 'wrong-state answer']);
  });

  it('runs one at a time, in order, even when tasks take different times', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    let running = 0;
    const jobs = [30, 1, 15, 0, 5].map((ms, i) =>
      q.run(async () => {
        running++;
        expect(running).toBe(1);
        await sleep(ms);
        order.push(i);
        running--;
        return i;
      }),
    );
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('sent frames: serialised so the strict receiver never sees counters out of order (interop fix 1b)', () => {
  async function pair() {
    const [a, b] = await Promise.all([identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase())]);
    const ea = newEphemeral();
    const eb = newEphemeral();
    const base = { offerFingerprint: 'sha-256 AA', answerFingerprint: 'sha-256 BB' };
    const A = await SessionLock.create({ ...base, role: 'offerer', myIdentitySecret: a.secretKey, myIdentityPublic: a.publicKey, myEphemeralSecret: ea.secret, myEphemeralPublic: ea.public, peerIdentityPublic: b.publicKey, peerEphemeralPublic: eb.public });
    const B = await SessionLock.create({ ...base, role: 'answerer', myIdentitySecret: b.secretKey, myIdentityPublic: b.publicKey, myEphemeralSecret: eb.secret, myEphemeralPublic: eb.public, peerIdentityPublic: a.publicKey, peerEphemeralPublic: ea.public });
    return { A, B };
  }

  it('unqueued: if a later frame leaves first, the strict receiver refuses the earlier one', async () => {
    const { A, B } = await pair();
    // Without a queue, sealing two frames at once lets the second (small) one finish first.
    const first = A.seal(new Uint8Array(1024 * 1024)); // counter 1
    const second = A.seal(utf8('tiny')); // counter 2
    const wire = [await second, await first]; // the order they would reach the channel
    await B.open(wire[0]);
    await expect(B.open(wire[1])).rejects.toThrow(/replayed/);
  });

  it('queued: every frame leaves in counter order and opens', async () => {
    const { A, B } = await pair();
    const q = new SerialQueue();
    const wire: Uint8Array[] = [];
    const sends = Array.from({ length: 40 }, (_, i) =>
      q.run(async () => {
        const f = await A.seal(i % 7 === 0 ? new Uint8Array(256 * 1024) : utf8(`m${i}`));
        if (i % 5 === 0) await sleep(3);
        wire.push(f);
      }),
    );
    await Promise.all(sends);
    for (const f of wire) await B.open(f);
    expect(wire).toHaveLength(40);
  });
});
