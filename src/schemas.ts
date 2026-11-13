import { z } from 'zod';

const Id = z.string().trim().min(1).max(64);
const IsoDateTime = z.string().datetime({ offset: true });

export const PrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const TicketStatusSchema = z.enum(['pending', 'in_progress', 'resolved']);

export const TicketSchema = z.object({
  id: Id,
  subject: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  client: z.string().trim().min(1).max(100),
  priority: PrioritySchema.default('normal'),
  status: TicketStatusSchema.default('pending'),
  assigneeId: Id.nullable().default(null),
  createdAt: IsoDateTime
});
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TechnicianSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(100),
  // Technician stops receiving proposals once open tickets reach this number.
  maxOpenTickets: z.number().int().positive().default(8)
});
export type Technician = z.infer<typeof TechnicianSchema>;

export const RuleSchema = z.object({
  id: Id,
  // Every condition that is present must match. A rule with no conditions matches everything.
  when: z
    .object({
      clients: z.array(z.string().min(1)).min(1).optional(),
      keywords: z.array(z.string().min(1)).min(1).optional(),
      priorities: z.array(PrioritySchema).min(1).optional()
    })
    .strict()
    .default({}),
  candidates: z.array(Id).min(1)
});
export type Rule = z.infer<typeof RuleSchema>;

export const RulesConfigSchema = z
  .object({
    technicians: z.array(TechnicianSchema).min(1),
    rules: z.array(RuleSchema).default([])
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const t of cfg.technicians) {
      if (ids.has(t.id)) ctx.addIssue({ code: 'custom', message: `Duplicate technician id '${t.id}'` });
      ids.add(t.id);
    }
    for (const r of cfg.rules) {
      for (const c of r.candidates) {
        if (!ids.has(c)) ctx.addIssue({ code: 'custom', message: `Rule '${r.id}' references unknown technician '${c}'` });
      }
    }
  });
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

export const MailMessageSchema = z.object({
  id: Id,
  from: z.string().trim().min(1).max(200),
  to: z.array(z.string().trim().min(1)).default([]),
  cc: z.array(z.string().trim().min(1)).default([]),
  subject: z.string().max(300).default(''),
  body: z.string().max(20000).default(''),
  receivedAt: IsoDateTime,
  unread: z.boolean()
});
export type MailMessage = z.infer<typeof MailMessageSchema>;

// What a pending proposal would do once a human approves it.
export const ProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign_ticket'),
    ticketId: Id,
    assigneeId: Id.nullable(), // null = no technician had capacity; the approver must pick one
    ruleId: z.string().nullable()
  }),
  z.object({
    kind: z.literal('mark_mail_read'),
    messageIds: z.array(Id).min(1)
  })
]);
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: number;
  payload: ProposalPayload;
  reason: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

/** Formats Zod issues as "path: message" lines for CLI / error output. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
