import type { MailMessage, Ticket } from './schemas.js';

/** Boundary to the ticketing system. Swap the in-memory example for a real helpdesk client. */
export interface HelpdeskAdapter {
  listTickets(): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | undefined>;
  assignTicket(ticketId: string, technicianId: string): Promise<void>;
}

/** Boundary to the mailbox. `markRead` is only ever called from an approved proposal. */
export interface MailAdapter {
  listMessages(): Promise<MailMessage[]>;
  markRead(messageIds: string[]): Promise<void>;
}
