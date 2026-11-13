import { buildDigest, type DigestItem } from './digest.js';
import type { HelpdeskAdapter, MailAdapter } from './ports.js';
import { suggestAssignee } from './rules.js';
import type { Proposal, ProposalPayload, RulesConfig, Ticket } from './schemas.js';
import type { TriageStore } from './store.js';

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

const isOpen = (t: Ticket) => t.status !== 'resolved';

/** Open tickets per technician, straight from the helpdesk. */
export function openLoadByTechnician(tickets: Ticket[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const t of tickets) {
    if (isOpen(t) && t.assigneeId) load.set(t.assigneeId, (load.get(t.assigneeId) ?? 0) + 1);
  }
  return load;
}

function requireOperator(by: string): string {
  const operator = by?.trim();
  if (!operator) throw new Error('An operator id is required for every decision (it goes to the audit log)');
  if (operator.toLowerCase() === 'system') throw new Error("'system' is reserved; use your own operator id");
  return operator;
}

/**
 * The only component allowed to change anything in the helpdesk or the mailbox,
 * and it does so exclusively from `approve`.
 */
export class TriageService {
  constructor(
    private readonly helpdesk: HelpdeskAdapter,
    private readonly mail: MailAdapter,
    private readonly store: TriageStore,
    private readonly config: RulesConfig
  ) {}

  /** Creates one pending proposal per open, unassigned ticket that does not have one yet. Applies nothing. */
  async proposeAssignments(): Promise<Proposal[]> {
    const tickets = await this.helpdesk.listTickets();
    const load = openLoadByTechnician(tickets);
    const alreadyProposed = new Set<string>();
    // Pending proposals count as load too, otherwise one batch would pile everything on one person.
    for (const p of this.store.listProposals('pending')) {
      if (p.payload.kind !== 'assign_ticket') continue;
      alreadyProposed.add(p.payload.ticketId);
      const a = p.payload.assigneeId;
      if (a) load.set(a, (load.get(a) ?? 0) + 1);
    }

    const queue = tickets
      .filter((t) => isOpen(t) && !t.assigneeId && !alreadyProposed.has(t.id))
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
          a.id.localeCompare(b.id)
      );

    const created: Proposal[] = [];
    for (const ticket of queue) {
      const s = suggestAssignee(ticket, this.config, load);
      try {
        created.push(
          this.store.createProposal(
            { kind: 'assign_ticket', ticketId: ticket.id, assigneeId: s.assigneeId, ruleId: s.ruleId },
            s.reason
          )
        );
      } catch (err) {
        // Another process queued this ticket between our read and our insert: the unique index won.
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
        throw err;
      }
      if (s.assigneeId) load.set(s.assigneeId, (load.get(s.assigneeId) ?? 0) + 1);
    }
    return created;
  }

  /**
   * Builds the mail digest and queues ONE proposal to mark exactly those messages as read.
   * `now` only positions the 48-hour window; stored timestamps come from the store's clock.
   */
  async proposeMailDigest(
    recipient: string,
    now = new Date()
  ): Promise<{ items: DigestItem[]; proposal: Proposal | null }> {
    const items = buildDigest(await this.mail.listMessages(), { recipient, now });
    const queued = new Set<string>();
    for (const p of this.store.listProposals('pending')) {
      if (p.payload.kind === 'mark_mail_read') p.payload.messageIds.forEach((id) => queued.add(id));
    }
    const fresh = items.map((i) => i.id).filter((id) => !queued.has(id));
    const proposal = fresh.length
      ? this.store.createProposal(
          { kind: 'mark_mail_read', messageIds: fresh },
          `Mail digest for ${recipient}: mark the ${fresh.length} listed message(s) as read`
        )
      : null;
    return { items, proposal };
  }

  /**
   * Applies a pending proposal. `assigneeOverride` lets the approver choose a different technician
   * (required when the engine found nobody with capacity).
   */
  async approve(id: number, by: string, opts: { assigneeOverride?: string } = {}): Promise<Proposal> {
    const operator = requireOperator(by);
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new Error(`Proposal #${id} not found`);
    if (proposal.status !== 'pending') throw new Error(`Proposal #${id} is already ${proposal.status}`);

    let payload: ProposalPayload = proposal.payload;
    if (payload.kind === 'assign_ticket') {
      const assigneeId = opts.assigneeOverride ?? payload.assigneeId;
      if (!assigneeId) throw new Error(`Proposal #${id} has no assignee; approve it with an explicit assignee`);
      if (!this.config.technicians.some((t) => t.id === assigneeId)) {
        throw new Error(`Unknown technician '${assigneeId}'`);
      }
      // The ticket may have changed since the proposal was created; never overwrite newer state.
      const ticket = await this.helpdesk.getTicket(payload.ticketId);
      if (!ticket) throw new Error(`Ticket '${payload.ticketId}' no longer exists; reject proposal #${id}`);
      if (!isOpen(ticket)) throw new Error(`Ticket '${ticket.id}' is already resolved; reject proposal #${id}`);
      if (ticket.assigneeId) {
        throw new Error(`Ticket '${ticket.id}' is already assigned to '${ticket.assigneeId}'; reject proposal #${id}`);
      }
      payload = { ...payload, assigneeId };
    } else if (opts.assigneeOverride) {
      throw new Error('An assignee only applies to ticket assignment proposals');
    }

    if (!this.store.decide(id, 'approved', operator, null, payload)) {
      throw new Error(`Proposal #${id} was decided by someone else in the meantime`);
    }

    try {
      if (payload.kind === 'assign_ticket') {
        await this.helpdesk.assignTicket(payload.ticketId, payload.assigneeId!);
      } else {
        // Ids come from the stored proposal, never from the caller: only what was listed gets marked.
        await this.mail.markRead(payload.messageIds);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.reopenAfterFailure(id, operator, message);
      throw new Error(`Proposal #${id} could not be applied and is pending again: ${message}`);
    }
    this.store.audit('proposal_applied', operator, id, { payload });
    return this.store.getProposal(id)!;
  }

  /** Closes a pending proposal without touching the helpdesk or the mailbox. */
  reject(id: number, by: string, reason: string): Proposal {
    const operator = requireOperator(by);
    const note = reason?.trim();
    if (!note) throw new Error('A reason is required to reject a proposal');
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new Error(`Proposal #${id} not found`);
    if (!this.store.decide(id, 'rejected', operator, note, proposal.payload)) {
      throw new Error(`Proposal #${id} is already ${this.store.getProposal(id)!.status}`);
    }
    return this.store.getProposal(id)!;
  }
}
