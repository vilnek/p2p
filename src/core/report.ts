// Report (Play policy): Block, then the person's own email app opens with the details. Nothing is
// sent by the app (there is no server). The person can attach screenshots themselves.

export const REPORT_ADDRESS = 'info@vilnek.in';
export const REPORT_SUBJECT = 'P2P Talk report';

/** What goes into a report email. */
export interface ReportDetails {
  /** The reported person's 24-digit P2P ID. */
  theirId: string;
  /** Their name as shown on this device (may be empty). */
  theirName?: string;
  /** My own 24-digit P2P ID (the reporter). */
  myId: string;
  /** When the report was made (ms). Defaults to now. */
  when?: number;
  /** Set when a group member is reported: the group's name. */
  group?: string;
}

/** "2026-10-23 14:05 UTC": the same on every device and easy for us to read. */
export function reportDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The email body (plain text). */
export function reportBody(d: ReportDetails): string {
  const lines = [
    'I want to report this person on P2P Talk.',
    '',
    `Their P2P ID: ${d.theirId}`,
    `Their name: ${d.theirName?.trim() || '(no name)'}`,
    ...(d.group ? [`In the group: ${d.group}`] : []),
    `My P2P ID: ${d.myId}`,
    `Date: ${reportDate(d.when ?? Date.now())}`,
    '',
    'What happened:',
    '',
    '',
    '(You can attach screenshots.)',
  ];
  return lines.join('\n');
}

/**
 * mailto: link to info@vilnek.in with the subject "P2P Talk report". Pass the full details; a bare
 * P2P ID (older callers) gives a shorter body with only that ID.
 */
export function reportMailto(details: ReportDetails | string): string {
  const body =
    typeof details === 'string'
      ? `I want to report this P2P ID: ${details}\n\nWhat happened:\n\n(You can attach screenshots.)`
      : reportBody(details);
  // encodeURIComponent, not URLSearchParams: mail apps read %20 as a space but may show "+" as is.
  return `mailto:${REPORT_ADDRESS}?subject=${encodeURIComponent(REPORT_SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/** Shown after Report (the person is already blocked). */
export const REPORT_DONE_TEXT = 'Blocked. You can also email us the details.';
