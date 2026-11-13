import type { Rule, RulesConfig, Ticket } from './schemas.js';

export interface AssignmentSuggestion {
  assigneeId: string | null;
  ruleId: string | null;
  reason: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match so "vpn" does not fire on "vpnless" and "pos" not on "position". */
export function containsKeyword(text: string, keyword: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword.trim())}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function ruleMatches(rule: Rule, ticket: Ticket): boolean {
  const { clients, keywords, priorities } = rule.when;
  if (clients && !clients.some((c) => c.trim().toLowerCase() === ticket.client.toLowerCase())) return false;
  if (priorities && !priorities.includes(ticket.priority)) return false;
  if (keywords && !keywords.some((k) => containsKeyword(`${ticket.subject}\n${ticket.description}`, k))) return false;
  return true;
}

/**
 * Picks who should get a ticket. Pure: same inputs, same answer.
 * First matching rule (in config order) supplies the candidates; with no match every technician is a
 * candidate. Among candidates under their limit, the one with the fewest open tickets wins; ties go
 * to whoever is listed first.
 */
export function suggestAssignee(
  ticket: Ticket,
  config: RulesConfig,
  openLoad: ReadonlyMap<string, number>
): AssignmentSuggestion {
  const rule = config.rules.find((r) => ruleMatches(r, ticket));
  const candidateIds = rule ? rule.candidates : config.technicians.map((t) => t.id);
  const source = rule ? `rule '${rule.id}'` : 'no rule matched (fallback: whole team)';

  let best: { id: string; load: number } | undefined;
  for (const id of candidateIds) {
    const tech = config.technicians.find((t) => t.id === id);
    if (!tech) continue;
    const load = openLoad.get(id) ?? 0;
    if (load >= tech.maxOpenTickets) continue;
    if (!best || load < best.load) best = { id, load };
  }

  if (!best) {
    return {
      assigneeId: null,
      ruleId: rule?.id ?? null,
      reason: `${source}; every candidate is at their open-ticket limit, a human must pick the assignee`
    };
  }
  return {
    assigneeId: best.id,
    ruleId: rule?.id ?? null,
    reason: `${source}; lowest load among candidates (${best.load} open)`
  };
}
