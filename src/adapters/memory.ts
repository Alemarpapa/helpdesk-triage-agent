import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { HelpdeskAdapter, MailAdapter } from '../ports.js';
import { MailMessageSchema, TicketSchema, type MailMessage, type Ticket } from '../schemas.js';

/** Example helpdesk kept in memory. Good for tests, the demo and as a template for a real adapter. */
export class InMemoryHelpdesk implements HelpdeskAdapter {
  protected tickets = new Map<string, Ticket>();

  constructor(tickets: Ticket[] = []) {
    for (const t of tickets) this.tickets.set(t.id, { ...t });
  }

  /** Adds new tickets. Throws on an id that already exists, so an import never overwrites state. */
  addTickets(tickets: Ticket[]): void {
    const seen = new Set<string>();
    for (const t of tickets) {
      if (this.tickets.has(t.id) || seen.has(t.id)) throw new Error(`Ticket '${t.id}' already exists`);
      seen.add(t.id);
    }
    for (const t of tickets) this.tickets.set(t.id, { ...t });
  }

  async listTickets(): Promise<Ticket[]> {
    return [...this.tickets.values()].map((t) => ({ ...t }));
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    const t = this.tickets.get(id);
    return t ? { ...t } : undefined;
  }

  async assignTicket(ticketId: string, technicianId: string): Promise<void> {
    const t = this.tickets.get(ticketId);
    if (!t) throw new Error(`Ticket '${ticketId}' not found`);
    t.assigneeId = technicianId;
  }
}

/** Example mailbox kept in memory. */
export class InMemoryMail implements MailAdapter {
  protected messages = new Map<string, MailMessage>();

  constructor(messages: MailMessage[] = []) {
    for (const m of messages) this.messages.set(m.id, { ...m });
  }

  async listMessages(): Promise<MailMessage[]> {
    return [...this.messages.values()].map((m) => ({ ...m }));
  }

  async markRead(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      const m = this.messages.get(id);
      if (!m) throw new Error(`Message '${id}' not found`);
    }
    for (const id of messageIds) this.messages.get(id)!.unread = false;
  }
}

function readJsonArray<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
  if (!fs.existsSync(file)) return [];
  return z.array(schema).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated state file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The in-memory helpdesk plus a JSON file, so state survives between CLI runs.
 * shortcut: single-process only (no file locking), swap for a real helpdesk adapter in production.
 */
export class JsonFileHelpdesk extends InMemoryHelpdesk {
  constructor(private readonly file: string) {
    super(readJsonArray(file, TicketSchema));
  }

  override addTickets(tickets: Ticket[]): void {
    super.addTickets(tickets);
    this.save();
  }

  override async assignTicket(ticketId: string, technicianId: string): Promise<void> {
    await super.assignTicket(ticketId, technicianId);
    this.save();
  }

  private save(): void {
    writeJson(this.file, [...this.tickets.values()]);
  }
}

/** The in-memory mailbox plus a JSON file. Same single-process limit as JsonFileHelpdesk. */
export class JsonFileMail extends InMemoryMail {
  constructor(private readonly file: string) {
    super(readJsonArray(file, MailMessageSchema));
  }

  override async markRead(messageIds: string[]): Promise<void> {
    await super.markRead(messageIds);
    writeJson(this.file, [...this.messages.values()]);
  }
}
