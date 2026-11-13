import { RulesConfigSchema, TicketSchema, MailMessageSchema, type MailMessage, type RulesConfig, type Ticket } from '../src/schemas.js';

export const NOW = new Date('2026-03-10T12:00:00Z');

export function ticket(over: Partial<Ticket> & { id: string }): Ticket {
  return TicketSchema.parse({
    subject: 'Generic question',
    client: 'Cedar Hill Vets',
    createdAt: '2026-03-10T09:00:00Z',
    ...over
  });
}

export function mail(over: Partial<MailMessage> & { id: string }): MailMessage {
  return MailMessageSchema.parse({
    from: 'dana@client.example',
    to: ['lead@helpdesk.example'],
    subject: 'Question',
    body: 'Could you take a look?',
    receivedAt: '2026-03-10T10:00:00Z',
    unread: true,
    ...over
  });
}

export function config(over: Partial<{ technicians: unknown[]; rules: unknown[] }> = {}): RulesConfig {
  return RulesConfigSchema.parse({
    technicians: [
      { id: 'tech-a', name: 'Tech A', maxOpenTickets: 2 },
      { id: 'tech-b', name: 'Tech B', maxOpenTickets: 2 }
    ],
    rules: [
      { id: 'billing', when: { keywords: ['invoice', 'refund'] }, candidates: ['tech-b'] },
      { id: 'vip-urgent', when: { clients: ['Northwind Bakery'], priorities: ['urgent', 'high'] }, candidates: ['tech-a'] }
    ],
    ...over
  });
}
