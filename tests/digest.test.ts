import { describe, expect, it } from 'vitest';
import { buildDigest, findActionCue } from '../src/digest.js';
import { NOW, mail } from './helpers.js';

const opts = { recipient: 'lead@helpdesk.example', now: NOW };
const ids = (messages: ReturnType<typeof mail>[]) => buildDigest(messages, opts).map((i) => i.id);

describe('mail digest filter', () => {
  it('keeps unread mail addressed to the recipient that asks for something', () => {
    expect(ids([mail({ id: 'ok' })])).toEqual(['ok']);
  });

  it('drops mail that is already read', () => {
    expect(ids([mail({ id: 'read', unread: false })])).toEqual([]);
  });

  it('applies the 48-hour window inclusively at the boundary', () => {
    expect(
      ids([
        mail({ id: 'exactly-48h', receivedAt: '2026-03-08T12:00:00Z' }),
        mail({ id: 'one-second-older', receivedAt: '2026-03-08T11:59:59Z' })
      ])
    ).toEqual(['exactly-48h']);
  });

  it('compares instants, not strings, when timestamps carry a UTC offset', () => {
    // 09:30-03:00 is 12:30Z on the 8th: inside the window even though the text sorts "earlier".
    expect(ids([mail({ id: 'offset', receivedAt: '2026-03-08T09:30:00-03:00' })])).toEqual(['offset']);
  });

  it('drops mail where the recipient is only in CC, and matches addresses case-insensitively', () => {
    expect(
      ids([
        mail({ id: 'cc-only', to: ['team@helpdesk.example'], cc: ['lead@helpdesk.example'] }),
        mail({ id: 'caps', to: ['Lead@Helpdesk.Example'] }),
        mail({ id: 'display-name', to: ['Team Lead <lead@helpdesk.example>'] })
      ])
    ).toEqual(['caps', 'display-name']);
  });

  it('drops automated senders even when they say "action required"', () => {
    expect(
      ids([
        mail({ id: 'a', from: 'no-reply@status.example', subject: 'Action required' }),
        mail({ id: 'b', from: 'Billing <notifications@vendor.example>', body: 'Please confirm your address' })
      ])
    ).toEqual([]);
  });

  it('drops mail with no request in it', () => {
    expect(ids([mail({ id: 'fyi', subject: 'Thanks', body: 'All working now. Please note the office is closed Friday.' })])).toEqual([]);
  });

  it('sorts newest first and reports the cue that matched', () => {
    const digest = buildDigest(
      [
        mail({ id: 'old', receivedAt: '2026-03-09T10:00:00Z', body: 'We need your approval on this.' }),
        mail({ id: 'new', receivedAt: '2026-03-10T11:00:00Z' })
      ],
      opts
    );
    expect(digest.map((i) => [i.id, i.cue])).toEqual([
      ['new', 'Could you'],
      ['old', 'your approval']
    ]);
  });
});

describe('action cues', () => {
  it.each([
    ['Can you send the file', true],
    ['Please review the attached quote', true],
    ['Is the server back', false],
    ['Is the server back?', true],
    ['Action needed on your account', true],
    ['Please note that we moved offices', false],
    ['FYI, deployment finished', false]
  ])('%s -> %s', (text, expected) => {
    expect(findActionCue(text) !== null).toBe(expected);
  });
});
