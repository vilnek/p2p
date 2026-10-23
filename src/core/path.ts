// Which way the connection goes, read from RTCPeerConnection.getStats(), in plain words.

export type PathKind =
  | 'bluetooth' //   later, native apps only
  | 'local' //       both devices on the same Wi-Fi / local network
  | 'wifi-direct' // later, native apps only
  | 'internet' //    straight across the internet (through home routers), still device to device
  | 'postbox' //     later: through your own always-on postbox device (plan §8.2)
  | 'own-relay' //   later: through a relay you run yourself
  | 'relay' //       through someone else's relay computer (should not happen: we use no relay)
  | 'offline';

export interface PathInfo {
  kind: PathKind;
  /** Our own network type where the browser tells us (e.g. "wifi", "cellular"), else "". */
  networkType: string;
}

// Icons as in the plan (§8.8).
/** `short`: the one-line label in the info sheet (design P2). */
export const PATH_TEXT: Record<PathKind, { icon: string; label: string; short: string; detail: string }> = {
  bluetooth: { icon: '📶', short: 'Bluetooth, direct', label: 'Bluetooth', detail: 'Device to device over Bluetooth (coming in the phone apps).' },
  local: {
    icon: '🛜', short: 'Same Wi-Fi, direct',
    label: 'Same Wi-Fi / local network',
    detail: 'Your two devices are talking straight to each other inside the same network. Nothing goes out to the internet.',
  },
  'wifi-direct': { icon: '📡', short: 'Wi-Fi Direct', label: 'Wi-Fi Direct', detail: 'Device to device over Wi-Fi Direct (coming in the phone apps).' },
  internet: {
    icon: '🌐', short: 'Internet, direct',
    label: 'Internet, direct',
    detail: 'Your devices are talking straight to each other across the internet. No company computer sits in between or keeps a copy.',
  },
  postbox: { icon: '📮', short: 'Through your postbox', label: 'Your postbox', detail: 'Through your own postbox device, which keeps locked messages for you (coming later).' },
  'own-relay': { icon: '🏠', short: 'Through your own relay', label: 'Your own relay', detail: 'Through a relay computer you run yourself. It is still locked (coming later).' },
  relay: {
    icon: '⚠️', short: 'Through a relay',
    label: 'Relay',
    detail: 'The connection is going through a relay computer. It is still locked, but it is not direct.',
  },
  offline: { icon: '○', short: 'Offline', label: 'Offline', detail: 'There is no connection to this person right now.' },
};

interface Cand {
  candidateType?: string;
  address?: string;
  ip?: string;
  networkType?: string;
}

/** Private, loopback, link-local or hidden (".local") addresses: inside a local network. */
export function isLocalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a.endsWith('.local')) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return a === '::1' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd');
}

export function classify(local: Cand | undefined, remote: Cand | undefined): PathKind {
  if (!local || !remote) return 'offline';
  const lt = local.candidateType;
  const rt = remote.candidateType;
  if (lt === 'relay' || rt === 'relay') return 'relay';
  if (lt === 'host' && rt === 'host') return 'local';
  // A "peer-reflexive" candidate is learned during the connection checks; if both ends still use
  // private addresses they are on the same network.
  if (lt === 'host' && rt === 'prflx' && isLocalAddress(remote.address ?? remote.ip)) return 'local';
  if (lt === 'prflx' && rt === 'host' && isLocalAddress(local.address ?? local.ip)) return 'local';
  return 'internet';
}

/** Finds the selected candidate pair in a stats report. */
export function pathFromStats(stats: RTCStatsReport | Map<string, any>): PathInfo {
  const all = new Map<string, any>();
  stats.forEach((v: any, k: string) => all.set(k, v));
  let pair: any;
  for (const s of all.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId);
  }
  if (!pair) {
    for (const s of all.values()) {
      if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    }
  }
  if (!pair) return { kind: 'offline', networkType: '' };
  const local = all.get(pair.localCandidateId) as Cand | undefined;
  const remote = all.get(pair.remoteCandidateId) as Cand | undefined;
  return { kind: classify(local, remote), networkType: local?.networkType ?? '' };
}
