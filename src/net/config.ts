// Relay settings shared by the screens and the embedded mode.

import { DEFAULT_RELAYS } from '../core/card';
import { loadRelayChoice } from '../core/store';

import { testFlag } from '../core/testmode';

/** Tests point at a local relay with ?relays=ws://… (never the public relays). Test pages only. */
export const testRelays = testFlag('relays')?.split(',').map((r) => r.trim()).filter(Boolean) ?? null;

/** Relays for my own codes and invites: the built-in list (Settings can switch some off). */
export async function myRelays(): Promise<string[]> {
  if (testRelays) return testRelays;
  const chosen = ((await loadRelayChoice()) ?? []).filter((r) => DEFAULT_RELAYS.includes(r));
  return chosen.length ? chosen : [...DEFAULT_RELAYS];
}

/** Relays this device may contact when it uses someone's code. */
export const allowedRelays = () => [...DEFAULT_RELAYS, ...(testRelays ?? [])];

/** Test-only: invite life in seconds (negative = already expired). */
export const testInviteTtl = Number(testFlag('inviteTtl')) || 0;

/** Where to look for someone's ID card and send ID requests: every built-in relay (only the test relays in tests). */
export const searchRelays = () => (testRelays ? [...testRelays] : [...DEFAULT_RELAYS]);
