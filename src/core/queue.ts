// One-at-a-time work queue. Used per connection for:
//   - received frames: opened strictly in arrival order (the lock's counter must only go up);
//   - sent frames: locked and handed to the data channel in counter order, so the other side's
//     strict counter check never sees them out of order.
// A task that throws is reported to `onError` and the queue keeps going: one bad frame (a bad
// session description, a call message in the wrong state, a failed send) must not stop every later one.

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly onError: (e: unknown) => void = (e) => console.warn('P2P Talk:', e)) {}

  /** Runs `task` after every earlier task has finished. The result (or error) also goes to the caller. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch((e) => this.onError(e));
    return result;
  }

  /** Like run(), for callers that don't wait: errors only go to `onError`. */
  push(task: () => unknown): void {
    this.run(task).catch(() => undefined);
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
