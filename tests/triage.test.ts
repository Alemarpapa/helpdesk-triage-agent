import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryHelpdesk, InMemoryMail } from '../src/adapters/memory.js';
import { TriageStore } from '../src/store.js';
import { TriageService } from '../src/triage.js';
import { NOW, config, mail, ticket } from './helpers.js';

let helpdesk: InMemoryHelpdesk;
let mailbox: InMemoryMail;
let store: TriageStore;
let service: TriageService;

function setup(tickets = [ticket({ id: 'T-1', subject: 'Invoice is wrong' }), ticket({ id: 'T-2' })], messages = [mail({ id: 'm-1' })]) {
  helpdesk = new InMemoryHelpdesk(tickets);
  mailbox = new InMemoryMail(messages);
  store = new TriageStore(':memory:', () => NOW);
  service = new TriageService(helpdesk, mailbox, store, config());
}

beforeEach(() => setup());

describe('proposing assignments', () => {
  it('queues proposals without touching the helpdesk', async () => {
    const created = await service.proposeAssignments();
    expect(created.map((p) => p.payload)).toEqual([
      { kind: 'assign_ticket', ticketId: 'T-1', assigneeId: 'tech-b', ruleId: 'billing' },
      { kind: 'assign_ticket', ticketId: 'T-2', assigneeId: 'tech-a', ruleId: null }
    ]);
    expect((await helpdesk.listTickets()).every((t) => t.assigneeId === null)).toBe(true);
  });

  it('is idempotent: a second run creates nothing new', async () => {
    await service.proposeAssignments();
    expect(await service.proposeAssignments()).toEqual([]);
    expect(store.listProposals()).toHaveLength(2);
  });

  it('ignores resolved and already-assigned tickets', async () => {
    setup([ticket({ id: 'done', status: 'resolved' }), ticket({ id: 'taken', assigneeId: 'tech-a' })]);
    expect(await service.proposeAssignments()).toEqual([]);
  });

  it('counts pending proposals as load so one batch is spread across the team', async () => {
    setup(['1', '2', '3', '4', '5'].map((id) => ticket({ id })));
    const created = await service.proposeAssignments();
    const assignees = created.map((p) => (p.payload.kind === 'assign_ticket' ? p.payload.assigneeId : 'x'));
    // Two technicians with a limit of 2 each: the fifth ticket has nobody left.
    expect(assignees).toEqual(['tech-a', 'tech-b', 'tech-a', 'tech-b', null]);
  });

  it('handles urgent tickets first so they get capacity before low-priority ones', async () => {
    setup([
      ticket({ id: 'low', priority: 'low', createdAt: '2026-03-10T07:00:00Z' }),
      ticket({ id: 'urgent', priority: 'urgent', createdAt: '2026-03-10T09:00:00Z' })
    ]);
    const created = await service.proposeAssignments();
    expect(created[0].payload).toMatchObject({ ticketId: 'urgent' });
  });

  it('the database refuses a second pending proposal for the same ticket', () => {
    const payload = { kind: 'assign_ticket', ticketId: 'T-1', assigneeId: 'tech-a', ruleId: null } as const;
    store.createProposal(payload, 'first');
    expect(() => store.createProposal(payload, 'second')).toThrow(/UNIQUE/);
  });
});

describe('approving', () => {
  it('applies the assignment only on approval and records who approved', async () => {
    const [p] = await service.proposeAssignments();
    const approved = await service.approve(p.id, 'alex');
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'alex', decidedAt: NOW.toISOString() });
    expect((await helpdesk.getTicket('T-1'))?.assigneeId).toBe('tech-b');
    expect((await helpdesk.getTicket('T-2'))?.assigneeId).toBeNull();
  });

  it('refuses to decide the same proposal twice', async () => {
    const [p] = await service.proposeAssignments();
    await service.approve(p.id, 'alex');
    await expect(service.approve(p.id, 'alex')).rejects.toThrow(/already approved/);
    expect(() => service.reject(p.id, 'alex', 'changed my mind')).toThrow(/already approved/);
  });

  it('lets only one of two concurrent approvals win', async () => {
    const [p] = await service.proposeAssignments();
    const results = await Promise.allSettled([service.approve(p.id, 'alex'), service.approve(p.id, 'sam')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.listAudit().filter((e) => e.event === 'proposal_applied')).toHaveLength(1);
  });

  it('requires an operator id and reserves "system"', async () => {
    const [p] = await service.proposeAssignments();
    await expect(service.approve(p.id, '  ')).rejects.toThrow(/operator id is required/);
    await expect(service.approve(p.id, 'System')).rejects.toThrow(/reserved/);
    expect(store.getProposal(p.id)?.status).toBe('pending');
  });

  it('rejects unknown proposals and unknown technicians', async () => {
    const [p] = await service.proposeAssignments();
    await expect(service.approve(999, 'alex')).rejects.toThrow(/not found/);
    await expect(service.approve(p.id, 'alex', { assigneeOverride: 'ghost' })).rejects.toThrow(/Unknown technician/);
    expect((await helpdesk.getTicket('T-1'))?.assigneeId).toBeNull();
  });

  it('lets the approver override the assignee and audits the final choice', async () => {
    const [p] = await service.proposeAssignments();
    const approved = await service.approve(p.id, 'alex', { assigneeOverride: 'tech-a' });
    expect(approved.payload).toMatchObject({ assigneeId: 'tech-a' });
    expect((await helpdesk.getTicket('T-1'))?.assigneeId).toBe('tech-a');
  });

  it('needs an explicit assignee when the engine found nobody with capacity', async () => {
    setup(['1', '2', '3', '4', '5'].map((id) => ticket({ id })));
    const last = (await service.proposeAssignments())[4];
    await expect(service.approve(last.id, 'alex')).rejects.toThrow(/no assignee/);
    await service.approve(last.id, 'alex', { assigneeOverride: 'tech-b' });
    expect((await helpdesk.getTicket('5'))?.assigneeId).toBe('tech-b');
  });

  it('will not overwrite a ticket that was assigned after the proposal was created', async () => {
    const [p] = await service.proposeAssignments();
    await helpdesk.assignTicket('T-1', 'tech-a'); // someone assigned it by hand in the meantime
    await expect(service.approve(p.id, 'alex')).rejects.toThrow(/already assigned to 'tech-a'/);
    expect((await helpdesk.getTicket('T-1'))?.assigneeId).toBe('tech-a');
    expect(store.getProposal(p.id)?.status).toBe('pending');
  });

  it('returns the proposal to the queue and audits the failure when the helpdesk call fails', async () => {
    const [p] = await service.proposeAssignments();
    helpdesk.assignTicket = async () => {
      throw new Error('helpdesk unavailable');
    };
    await expect(service.approve(p.id, 'alex')).rejects.toThrow(/pending again: helpdesk unavailable/);
    expect(store.getProposal(p.id)).toMatchObject({ status: 'pending', decidedBy: null });
    expect(store.listAudit().map((e) => e.event)).toEqual([
      'proposal_created',
      'proposal_created',
      'proposal_approved',
      'apply_failed'
    ]);
  });
});

describe('rejecting', () => {
  it('closes the proposal, changes nothing, and requires a reason', async () => {
    const [p] = await service.proposeAssignments();
    expect(() => service.reject(p.id, 'alex', ' ')).toThrow(/reason is required/);
    const rejected = service.reject(p.id, 'alex', 'client asked to wait');
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'alex', decisionNote: 'client asked to wait' });
    expect((await helpdesk.getTicket('T-1'))?.assigneeId).toBeNull();
  });

  it('frees the ticket for a new proposal on the next run', async () => {
    const [p] = await service.proposeAssignments();
    service.reject(p.id, 'alex', 'wrong person');
    const again = await service.proposeAssignments();
    expect(again).toHaveLength(1);
    expect(again[0].payload).toMatchObject({ ticketId: 'T-1' });
  });
});

describe('mail digest approval', () => {
  it('marks nothing as read until the proposal is approved', async () => {
    const { items, proposal } = await service.proposeMailDigest('lead@helpdesk.example', NOW);
    expect(items.map((i) => i.id)).toEqual(['m-1']);
    expect(proposal?.status).toBe('pending');
    expect((await mailbox.listMessages())[0].unread).toBe(true);
  });

  it('on approval marks only the listed messages, not mail that arrived later', async () => {
    const { proposal } = await service.proposeMailDigest('lead@helpdesk.example', NOW);
    mailbox = new InMemoryMail([mail({ id: 'm-1' }), mail({ id: 'm-late' })]);
    service = new TriageService(helpdesk, mailbox, store, config());
    await service.approve(proposal!.id, 'alex');
    const unread = Object.fromEntries((await mailbox.listMessages()).map((m) => [m.id, m.unread]));
    expect(unread).toEqual({ 'm-1': false, 'm-late': true });
  });

  it('does not queue the same message twice and queues nothing for an empty digest', async () => {
    await service.proposeMailDigest('lead@helpdesk.example', NOW);
    expect((await service.proposeMailDigest('lead@helpdesk.example', NOW)).proposal).toBeNull();
    expect((await service.proposeMailDigest('nobody@helpdesk.example', NOW)).items).toEqual([]);
    expect(store.listProposals()).toHaveLength(1);
  });

  it('refuses an assignee override on a mail proposal', async () => {
    const { proposal } = await service.proposeMailDigest('lead@helpdesk.example', NOW);
    await expect(service.approve(proposal!.id, 'alex', { assigneeOverride: 'tech-a' })).rejects.toThrow(/only applies/);
  });
});

describe('audit log', () => {
  it('records every step with actor and proposal id', async () => {
    const [p1, p2] = await service.proposeAssignments();
    await service.approve(p1.id, 'alex');
    service.reject(p2.id, 'sam', 'duplicate');
    expect(store.listAudit().map((e) => [e.event, e.actor, e.proposalId])).toEqual([
      ['proposal_created', 'system', 1],
      ['proposal_created', 'system', 2],
      ['proposal_approved', 'alex', 1],
      ['proposal_applied', 'alex', 1],
      ['proposal_rejected', 'sam', 2]
    ]);
  });

  it('is append-only: updates and deletes are blocked by the database', async () => {
    await service.proposeAssignments();
    expect(() => store.db.prepare("UPDATE audit_log SET actor = 'nobody'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(store.listAudit()).toHaveLength(2);
  });
});
