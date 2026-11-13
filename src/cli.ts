#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { JsonFileHelpdesk, JsonFileMail } from './adapters/memory.js';
import { buildDailyReport } from './report.js';
import { RulesConfigSchema, TicketSchema, describeIssues, type Proposal } from './schemas.js';
import { TriageStore } from './store.js';
import { TriageService } from './triage.js';

const USAGE = `helpdesk-triage-agent: proposals first, changes only after human approval

Usage: triage <command> [options]

  init                               Copy the synthetic example data into the data directory
  ingest <tickets.json>              Validate and add tickets (rejects the whole file on any error)
  propose                            Create assignment proposals for open, unassigned tickets
  queue                              List proposals awaiting approval
  approve <id> --by <operator> [--assignee <technician-id>]
  reject <id> --by <operator> --reason <text>
  digest --for <email>               Show mail that needs action; queue a mark-as-read proposal
  report [--out <file.md>]           Daily Markdown report
  audit                              Print the audit log

Options:
  --config <file>   Rules file (default: examples/rules.json)
  --data <dir>      State directory (default: ./data, or $TRIAGE_DATA_DIR)
  --now <iso-date>  digest/report only: evaluate as of this moment (the example data is dated
                    2026-03-10). Stored timestamps and the audit log always use the real clock.
`;

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

function describeProposal(p: Proposal): string {
  const what =
    p.payload.kind === 'assign_ticket'
      ? `assign ${p.payload.ticketId} -> ${p.payload.assigneeId ?? '(nobody has capacity: use --assignee)'}`
      : `mark as read: ${p.payload.messageIds.join(', ')}`;
  return `#${p.id} [${p.status}] ${what}\n     why: ${p.reason}`;
}

function parseProposalId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error('Expected a numeric proposal id');
  return Number(raw);
}

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: path.join(EXAMPLES, 'rules.json') },
      data: { type: 'string', default: process.env.TRIAGE_DATA_DIR ?? 'data' },
      now: { type: 'string' },
      by: { type: 'string' },
      reason: { type: 'string' },
      assignee: { type: 'string' },
      for: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const [command, arg] = positionals;
  if (values.help || !command) return out(USAGE);

  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid date: ${values.now}`);

  const dataDir = path.resolve(values.data);
  const ticketsFile = path.join(dataDir, 'tickets.json');
  const mailFile = path.join(dataDir, 'mail.json');

  if (command === 'init') {
    if (fs.existsSync(ticketsFile) || fs.existsSync(mailFile)) {
      throw new Error(`${dataDir} already has data; delete it first if you want to start over`);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(EXAMPLES, 'tickets.json'), ticketsFile);
    fs.copyFileSync(path.join(EXAMPLES, 'mail.json'), mailFile);
    return out(`Example data copied to ${dataDir}`);
  }

  const configParse = RulesConfigSchema.safeParse(readJson(values.config));
  if (!configParse.success) throw new Error(`Invalid rules config: ${describeIssues(configParse.error)}`);
  const config = configParse.data;

  const helpdesk = new JsonFileHelpdesk(ticketsFile);
  const mail = new JsonFileMail(mailFile);
  const store = new TriageStore(path.join(dataDir, 'triage.sqlite'));
  const service = new TriageService(helpdesk, mail, store, config);

  try {
    switch (command) {
      case 'ingest': {
        if (!arg) throw new Error('Usage: triage ingest <tickets.json>');
        const parsed = z.array(TicketSchema).safeParse(readJson(arg));
        if (!parsed.success) throw new Error(`Invalid tickets file, nothing imported: ${describeIssues(parsed.error)}`);
        helpdesk.addTickets(parsed.data);
        out(`Imported ${parsed.data.length} ticket(s)`);
        break;
      }
      case 'propose': {
        const created = await service.proposeAssignments();
        out(created.length ? created.map(describeProposal).join('\n') : 'No open unassigned tickets without a proposal.');
        if (created.length) out(`\n${created.length} proposal(s) queued. Nothing has been applied.`);
        break;
      }
      case 'queue': {
        const pending = store.listProposals('pending');
        out(pending.length ? pending.map(describeProposal).join('\n') : 'The approval queue is empty.');
        break;
      }
      case 'approve': {
        const p = await service.approve(parseProposalId(arg), values.by ?? '', { assigneeOverride: values.assignee });
        out(`Applied. ${describeProposal(p)}`);
        break;
      }
      case 'reject': {
        const p = service.reject(parseProposalId(arg), values.by ?? '', values.reason ?? '');
        out(`Rejected, nothing was changed. ${describeProposal(p)}`);
        break;
      }
      case 'digest': {
        if (!values.for) throw new Error('Usage: triage digest --for <email>');
        const { items, proposal } = await service.proposeMailDigest(values.for, now);
        if (!items.length) out('No unread mail from the last 48 hours is asking you for action.');
        for (const i of items) out(`${i.id}  ${i.receivedAt}  ${i.from}\n     ${i.subject}  (cue: "${i.cue}")`);
        if (proposal) out(`\nQueued proposal #${proposal.id} to mark these as read. Nothing is marked until you approve it.`);
        break;
      }
      case 'report': {
        const md = buildDailyReport({
          tickets: await helpdesk.listTickets(),
          technicians: config.technicians,
          proposals: store.listProposals(),
          now
        });
        if (values.out) {
          fs.writeFileSync(values.out, md);
          out(`Report written to ${values.out}`);
        } else out(md);
        break;
      }
      case 'audit': {
        for (const e of store.listAudit()) {
          out(`${e.at}  ${e.actor.padEnd(10)} ${e.event.padEnd(18)} proposal=${e.proposalId ?? '-'}  ${JSON.stringify(e.detail)}`);
        }
        break;
      }
      default:
        throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
