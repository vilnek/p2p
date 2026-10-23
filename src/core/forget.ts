// Clear chat / Delete chat / Delete group (on this device only; there is no server): which received
// files a chat's messages keep on this device, and deleting them with the messages.
//
// Received files live outside the database: in the phone apps in the app's own received folder
// (ChatMessage.native.ref, or keepRef for a locked chat's sealed message), in a browser in its private
// file area (ChatMessage.opfs; for a locked chat that name is inside the seal, so it is read with the
// chat open). Files the person already saved to Photos, Files or Downloads are copies there and are
// never touched. Small files kept in the database (blob, lockedBlob, thumb) go with their messages.

import type { ChatMessage } from './store';

export interface ChatFiles {
  /** Received files in the phone app's folder (opaque names). */
  native: string[];
  /** Received files in the browser's private file area. */
  opfs: string[];
}

/** The received files these messages keep on this device (sealed ones: only what is outside the seal). */
export function filesOf(stored: readonly ChatMessage[], opened: readonly ChatMessage[] | null = null): ChatFiles {
  const native = new Set<string>();
  const opfs = new Set<string>();
  for (const m of [...stored, ...(opened ?? [])]) {
    const ref = m.native?.ref ?? m.keepRef;
    if (ref) native.add(ref);
    if (m.opfs) opfs.add(m.opfs);
  }
  return { native: [...native], opfs: [...opfs] };
}

export interface ForgetDeps {
  /** The chat's messages as stored (sealed ones stay sealed). */
  stored(chat: string): Promise<ChatMessage[]>;
  /** The chat's messages opened (null: locked and the code wasn't typed). */
  opened(chat: string): Promise<ChatMessage[] | null>;
  /** Deletes every message of the chat (and its unread mark). */
  deleteMessages(chat: string): Promise<void>;
  removeNative(ref: string): Promise<void>;
  removeOpfs(name: string): Promise<void>;
  /** Files other chats still show (a file forwarded into two chats is kept for the other one). */
  inUseElsewhere?(chat: string): Promise<ChatFiles>;
}

/**
 * Deletes a chat's messages and the received files they keep on this device. The messages go first
 * (one transaction), then the files; a file that can't be deleted now is left for the app's start-up
 * cleanup (it is no longer in any chat). Returns how many files were deleted.
 */
export async function clearChatData(chat: string, deps: ForgetDeps): Promise<number> {
  const stored = await deps.stored(chat);
  const opened = stored.some((m) => m.locked) ? await deps.opened(chat).catch(() => null) : null;
  const files = filesOf(stored, opened);
  const keep = deps.inUseElsewhere ? await deps.inUseElsewhere(chat) : { native: [], opfs: [] };
  await deps.deleteMessages(chat);
  let n = 0;
  for (const ref of files.native) {
    if (keep.native.includes(ref)) continue;
    await deps.removeNative(ref).then(() => n++, () => undefined);
  }
  for (const name of files.opfs) {
    if (keep.opfs.includes(name)) continue;
    await deps.removeOpfs(name).then(() => n++, () => undefined);
  }
  return n;
}
