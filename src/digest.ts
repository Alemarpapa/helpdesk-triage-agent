import type { MailMessage } from './schemas.js';

export interface DigestItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  /** The phrase that made this message count as "asks you to do something". */
  cue: string;
}

export interface DigestOptions {
  /** Mailbox owner's address. Only mail addressed To: this person can ask them for action. */
  recipient: string;
  now: Date;
  windowHours?: number;
}

/** "Dana Wu <Dana@Client.example>" -> "dana@client.example" */
const address = (raw: string) => (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();

const AUTOMATED_SENDER = /(^|[<\s])(no-?reply|do-?not-?reply|mailer-daemon|notifications?|newsletter)@/i;

// Keyword heuristic, not language understanding: it misses polite indirect asks and can fire on
// rhetorical questions. It is intentionally simple and predictable.
const ACTION_CUES: RegExp[] = [
  /\b(?:could|can|would|will) you\b/i,
  /\bplease (?!note\b|be advised\b|disregard\b|ignore\b)\w+/i,
  /\bneed(?:s)? you to\b/i,
  /\baction (?:required|needed)\b/i,
  /\bwaiting (?:for|on) (?:you|your)\b/i,
  /\byour (?:approval|review|confirmation|sign-?off|reply|response|input|feedback)\b/i,
  /\blet me know\b/i,
  /\?/
];

export function findActionCue(text: string): string | null {
  for (const cue of ACTION_CUES) {
    const m = cue.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Digest filter: unread, received in the last `windowHours` (default 48), addressed directly to the
 * recipient, not from an automated sender, and containing an action cue. Newest first.
 */
export function buildDigest(messages: MailMessage[], opts: DigestOptions): DigestItem[] {
  const cutoff = opts.now.getTime() - (opts.windowHours ?? 48) * 3_600_000;
  const me = address(opts.recipient);
  const items: DigestItem[] = [];

  for (const m of messages) {
    if (!m.unread) continue;
    if (Date.parse(m.receivedAt) < cutoff) continue;
    if (!m.to.some((addr) => address(addr) === me)) continue;
    if (AUTOMATED_SENDER.test(m.from)) continue;
    const cue = findActionCue(`${m.subject}\n${m.body}`);
    if (!cue) continue;
    items.push({ id: m.id, from: m.from, subject: m.subject, receivedAt: m.receivedAt, cue });
  }
  return items.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}
