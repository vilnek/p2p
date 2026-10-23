// Small decisions around files, kept apart from the screens so they can be unit-tested.

export type SaveKind = 'photos' | 'files' | 'share';

/** The buttons on a received file: Save to Photos (app, images and videos), Save to Files, Share or open. Browser: Save, Share. */
export function saveActions(app: boolean, photosOk: boolean): { kind: SaveKind; label: string; testid: string }[] {
  const out: { kind: SaveKind; label: string; testid: string }[] = [];
  if (photosOk) out.push({ kind: 'photos', label: 'Save to Photos', testid: 'file-photos' });
  out.push({ kind: 'files', label: app ? 'Save to Files' : 'Save', testid: 'file-save-files' });
  out.push({ kind: 'share', label: app ? 'Share or open' : 'Share', testid: 'file-share' });
  return out;
}

/**
 * Sends every picked item. One that can't be read or offered is counted (and its temporary copy
 * released), never dropped silently. Returns how many failed.
 */
export async function sendPicked<S extends { release?: () => Promise<void> }>(
  sources: S[],
  send: (src: S) => Promise<string>,
  sent: (transferId: string, src: S) => void,
): Promise<number> {
  let failed = 0;
  for (const src of sources) {
    try {
      sent(await send(src), src);
    } catch {
      failed++;
      void src.release?.().catch(() => undefined);
    }
  }
  return failed;
}

/** One quiet line for items that couldn't be added. */
export const failedLine = (n: number) => (n === 1 ? '1 item couldn’t be added' : `${n} items couldn’t be added`);
