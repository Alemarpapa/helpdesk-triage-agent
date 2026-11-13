import { describe, expect, it } from 'vitest';
import { buildDailyReport } from '../src/report.js';
import type { Proposal } from '../src/schemas.js';
import { NOW, config, ticket } from './helpers.js';

const technicians = config().technicians;

function proposal(over: Partial<Proposal> & { id: number }): Proposal {
  return {
    payload: { kind: 'assign_ticket', ticketId: 'T-1', assigneeId: 'tech-a', ruleId: null },
    reason: 'fallback',
    status: 'pending',
    createdAt: NOW.toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    ...over
  };
}

describe('daily report', () => {
  it('counts pending / in progress and excludes resolved tickets', () => {
    const md = buildDailyReport({
      tickets: [
        ticket({ id: 'a', status: 'pending' }),
        ticket({ id: 'b', status: 'in_progress', assigneeId: 'tech-a' }),
        ticket({ id: 'c', status: 'in_progress', assigneeId: 'tech-a' }),
        ticket({ id: 'd', status: 'resolved', assigneeId: 'tech-a' })
      ],
      technicians,
      proposals: [proposal({ id: 1 })],
      now: NOW
    });
    expect(md).toContain('# Helpdesk daily report: 2026-03-10');
    expect(md).toContain('| 1 | 2 | 1 | 1 |');
    expect(md).toContain('| Tech A | 0 | 2 | 2 (at limit) | 2 |');
    expect(md).toContain('| Tech B | 0 | 0 | 0 | 2 |');
  });

  it('still shows load for an assignee missing from the config', () => {
    const md = buildDailyReport({ tickets: [ticket({ id: 'a', assigneeId: 'contractor-9' })], technicians, proposals: [], now: NOW });
    expect(md).toContain('| contractor-9 (not in config) | 1 | 0 | 1 | n/a |');
  });

  it('lists pending proposals and only decisions from the last 24 hours', () => {
    const md = buildDailyReport({
      tickets: [],
      technicians,
      proposals: [
        proposal({ id: 1 }),
        proposal({ id: 2, status: 'rejected', decidedAt: '2026-03-10T08:00:00Z', decidedBy: 'alex', decisionNote: 'dup' }),
        proposal({ id: 3, status: 'approved', decidedAt: '2026-03-08T08:00:00Z', decidedBy: 'alex' }),
        proposal({ id: 4, payload: { kind: 'mark_mail_read', messageIds: ['m-1', 'm-2'] } })
      ],
      now: NOW
    });
    expect(md).toContain('| 1 | Assign ticket T-1 to tech-a | fallback |');
    expect(md).toContain('| 4 | Mark 2 mail message(s) as read | fallback |');
    expect(md).toContain('| 2 | Assign ticket T-1 to tech-a | rejected | alex | dup |');
    expect(md).not.toContain('| 3 |');
  });

  it('says "None." for empty sections instead of printing empty tables', () => {
    const md = buildDailyReport({ tickets: [], technicians, proposals: [], now: NOW });
    expect(md.match(/^None\.$/gm)).toHaveLength(3);
  });

  it('escapes pipes and newlines so ticket text cannot break the table', () => {
    const md = buildDailyReport({
      tickets: [ticket({ id: 'a', subject: 'error | fatal\nsecond line' })],
      technicians,
      proposals: [],
      now: NOW
    });
    expect(md).toContain('| a | Cedar Hill Vets | normal | error \\| fatal second line |');
  });
});
