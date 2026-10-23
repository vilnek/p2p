// Test switches (?relays=, ?breakIce=, ?connectWait=, ?fileDelay=, ?ring=, ?inviteTtl=, ?testHooks=, ?restartViaRelays=,
// ?debug=, ?lockAfterMs=) work ONLY on a local test page (http://127.0.0.1 or http://localhost). On p2p.vilnek.in,
// in the iPhone / Android apps (capacitor:// or https://localhost) and in Vilnek OS they are ignored.

const loc = globalThis.location;
export const TEST_PAGE = !!loc && loc.protocol === 'http:' && (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost');
const query = new URLSearchParams(loc?.search ?? '');

/** The value of a test switch, or null on a real page. */
export const testFlag = (name: string): string | null => (TEST_PAGE ? query.get(name) : null);
