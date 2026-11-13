import { describe, expect, it } from 'vitest';
import { containsKeyword, ruleMatches, suggestAssignee } from '../src/rules.js';
import { RulesConfigSchema, TicketSchema } from '../src/schemas.js';
import { config, ticket } from './helpers.js';

describe('keyword matching', () => {
  it('matches whole words only, ignoring case', () => {
    expect(containsKeyword('The INVOICE is wrong', 'invoice')).toBe(true);
    expect(containsKeyword('Invoices are late', 'invoice')).toBe(false);
    expect(containsKeyword('our position changed', 'pos')).toBe(false);
  });

  it('supports multi-word phrases and keywords with regex characters', () => {
    expect(containsKeyword('I am locked out again', 'locked out')).toBe(true);
    expect(containsKeyword('error in c++ build', 'c++')).toBe(true);
    expect(containsKeyword('anything at all', '.*')).toBe(false);
  });
});

describe('rule matching', () => {
  const [billing, vip] = config().rules;

  it('requires every present condition to match', () => {
    expect(ruleMatches(vip, ticket({ id: 't', client: 'northwind bakery', priority: 'urgent' }))).toBe(true);
    expect(ruleMatches(vip, ticket({ id: 't', client: 'Northwind Bakery', priority: 'low' }))).toBe(false);
    expect(ruleMatches(vip, ticket({ id: 't', client: 'Other Co', priority: 'urgent' }))).toBe(false);
  });

  it('looks for keywords in subject and description', () => {
    expect(ruleMatches(billing, ticket({ id: 't', subject: 'Help', description: 'I want a refund' }))).toBe(true);
    expect(ruleMatches(billing, ticket({ id: 't', subject: 'Help', description: 'printer' }))).toBe(false);
  });
});

describe('suggestAssignee', () => {
  it('uses the first matching rule in config order', () => {
    const t = ticket({ id: 't', subject: 'Invoice problem', client: 'Northwind Bakery', priority: 'urgent' });
    const s = suggestAssignee(t, config(), new Map());
    expect(s).toMatchObject({ assigneeId: 'tech-b', ruleId: 'billing' });
  });

  it('falls back to the least-loaded technician when no rule matches', () => {
    const s = suggestAssignee(ticket({ id: 't' }), config(), new Map([['tech-a', 1]]));
    expect(s).toMatchObject({ assigneeId: 'tech-b', ruleId: null });
  });

  it('breaks load ties by listing order', () => {
    const s = suggestAssignee(ticket({ id: 't' }), config(), new Map([['tech-a', 1], ['tech-b', 1]]));
    expect(s.assigneeId).toBe('tech-a');
  });

  it('skips technicians at their open-ticket limit', () => {
    const s = suggestAssignee(ticket({ id: 't' }), config(), new Map([['tech-a', 2], ['tech-b', 1]]));
    expect(s.assigneeId).toBe('tech-b');
  });

  it('returns no assignee (not a random one) when every candidate is full', () => {
    const t = ticket({ id: 't', subject: 'refund please' });
    const s = suggestAssignee(t, config(), new Map([['tech-b', 2]]));
    expect(s.assigneeId).toBeNull();
    expect(s.ruleId).toBe('billing');
    expect(s.reason).toContain('human must pick');
  });
});

describe('schema guardrails', () => {
  it('rejects a rule that points at an unknown technician', () => {
    const res = RulesConfigSchema.safeParse({
      technicians: [{ id: 'tech-a', name: 'A' }],
      rules: [{ id: 'r', candidates: ['ghost'] }]
    });
    expect(res.success).toBe(false);
  });

  it('rejects duplicate technician ids and unknown rule conditions', () => {
    expect(RulesConfigSchema.safeParse({ technicians: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] }).success).toBe(false);
    expect(
      RulesConfigSchema.safeParse({
        technicians: [{ id: 'x', name: 'A' }],
        rules: [{ id: 'r', when: { keyword: ['typo'] }, candidates: ['x'] }]
      }).success
    ).toBe(false);
  });

  it('rejects tickets with a bad priority, date or empty subject', () => {
    const base = { id: 't', subject: 's', client: 'c', createdAt: '2026-03-10T09:00:00Z' };
    expect(TicketSchema.safeParse(base).success).toBe(true);
    expect(TicketSchema.safeParse({ ...base, priority: 'critical' }).success).toBe(false);
    expect(TicketSchema.safeParse({ ...base, createdAt: 'yesterday' }).success).toBe(false);
    expect(TicketSchema.safeParse({ ...base, subject: '   ' }).success).toBe(false);
  });
});
