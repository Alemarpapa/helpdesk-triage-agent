import type { Proposal, Technician, Ticket } from './schemas.js';

export interface ReportInput {
  tickets: Ticket[];
  technicians: Technician[];
  proposals: Proposal[];
  now: Date;
}

/** Keeps free text from breaking a Markdown table row. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ');

function describe(p: Proposal): string {
  return p.payload.kind === 'assign_ticket'
    ? `Assign ticket ${p.payload.ticketId} to ${p.payload.assigneeId ?? '(nobody has capacity, pick one)'}`
    : `Mark ${p.payload.messageIds.length} mail message(s) as read`;
}

/** Daily status report in Markdown. Read-only: built from data, changes nothing. */
export function buildDailyReport({ tickets, technicians, proposals, now }: ReportInput): string {
  const open = tickets.filter((t) => t.status !== 'resolved');
  const count = (list: Ticket[], status: Ticket['status']) => list.filter((t) => t.status === status).length;
  const unassigned = open.filter((t) => !t.assigneeId);
  const dayAgo = now.getTime() - 24 * 3_600_000;
  const pending = proposals.filter((p) => p.status === 'pending');
  const recent = proposals.filter((p) => p.status !== 'pending' && p.decidedAt && Date.parse(p.decidedAt) >= dayAgo);

  const lines: string[] = [
    `# Helpdesk daily report: ${now.toISOString().slice(0, 10)}`,
    '',
    `Generated ${now.toISOString()}. Open tickets only (resolved tickets are excluded).`,
    '',
    '## Summary',
    '',
    '| Pending | In progress | Open, unassigned | Proposals awaiting approval |',
    '|--------:|------------:|-----------------:|----------------------------:|',
    `| ${count(open, 'pending')} | ${count(open, 'in_progress')} | ${unassigned.length} | ${pending.length} |`,
    '',
    '## Workload by technician',
    '',
    '| Technician | Pending | In progress | Open total | Limit |',
    '|------------|--------:|------------:|-----------:|------:|'
  ];

  const known = new Set(technicians.map((t) => t.id));
  for (const tech of technicians) {
    const mine = open.filter((t) => t.assigneeId === tech.id);
    const flag = mine.length >= tech.maxOpenTickets ? ' (at limit)' : '';
    lines.push(
      `| ${cell(tech.name)} | ${count(mine, 'pending')} | ${count(mine, 'in_progress')} | ${mine.length}${flag} | ${tech.maxOpenTickets} |`
    );
  }
  // Tickets assigned to someone the config does not know still count; hiding them would understate load.
  const strangers = [...new Set(open.map((t) => t.assigneeId).filter((id): id is string => !!id && !known.has(id)))];
  for (const id of strangers.sort()) {
    const mine = open.filter((t) => t.assigneeId === id);
    lines.push(`| ${cell(id)} (not in config) | ${count(mine, 'pending')} | ${count(mine, 'in_progress')} | ${mine.length} | n/a |`);
  }

  lines.push('', '## Open tickets without an assignee', '');
  if (unassigned.length === 0) lines.push('None.');
  else {
    lines.push('| Ticket | Client | Priority | Subject |', '|--------|--------|----------|---------|');
    for (const t of unassigned) lines.push(`| ${cell(t.id)} | ${cell(t.client)} | ${t.priority} | ${cell(t.subject)} |`);
  }

  lines.push('', '## Proposals awaiting approval', '');
  if (pending.length === 0) lines.push('None.');
  else {
    lines.push('| # | Proposal | Why |', '|--:|----------|-----|');
    for (const p of pending) lines.push(`| ${p.id} | ${cell(describe(p))} | ${cell(p.reason)} |`);
  }

  lines.push('', '## Decisions in the last 24 hours', '');
  if (recent.length === 0) lines.push('None.');
  else {
    lines.push('| # | Proposal | Decision | By | Note |', '|--:|----------|----------|----|------|');
    for (const p of recent) {
      lines.push(`| ${p.id} | ${cell(describe(p))} | ${p.status} | ${cell(p.decidedBy ?? '')} | ${cell(p.decisionNote ?? '')} |`);
    }
  }
  return lines.join('\n') + '\n';
}
