// What to tell the person when Share screen doesn't start (never fail silently). null: say nothing
// (they closed the picker themselves, or a second tap while the first is still starting).

/** The browser's name for the Mac's settings path ("turn it on for Google Chrome"). */
export function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Google Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'your browser';
}

/** Said when the window (e.g. a host app's web view) has no screen capture. */
export const NO_SCREEN_HERE = 'This window can’t share the screen.';

const isMac = (ua: string) => /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);

export function shareErrorText(e: unknown, ua = globalThis.navigator?.userAgent ?? ''): string | null {
  const name = (e as { name?: string } | null)?.name ?? '';
  const message = (e as { message?: string } | null)?.message ?? '';
  const mac = isMac(ua);
  const allow = mac
    ? `Your Mac hasn’t allowed ${browserName(ua)} to share the screen. Open System Settings › Privacy & Security › Screen & System Audio Recording, turn on ${browserName(ua)}, then open it again.`
    : 'This computer hasn’t allowed the browser to share the screen. Check its privacy settings for screen recording, then try again.';
  if (name === 'NotAllowedError') {
    // Chrome: "Permission denied by system" = the computer's setting; plain "Permission denied" = the
    // person closed the picker (and the phone apps' "cancelled").
    return /system/i.test(message) ? allow : null;
  }
  if (name === 'NotReadableError') return mac ? allow : 'The screen couldn’t be shared. Close other apps that record or share the screen, then try again.';
  if (name === 'NotFoundError') return 'There’s no screen to share.';
  if (name === 'AbortError' && /already/i.test(message)) return null;
  if (/can’t share the screen|can't share the screen/i.test(message)) return message;
  if (/sharing their screen|started sharing first/i.test(message)) return message; // group calls: one at a time
  return 'Screen sharing couldn’t start. Please try again.';
}
