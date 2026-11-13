import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ProposalPayloadSchema, type Proposal, type ProposalPayload, type ProposalStatus } from './schemas.js';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  event: string;
  proposalId: number | null;
  detail: unknown;
}

interface ProposalRow {
  id: number;
  payload_json: string;
  reason: string;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

/** SQLite persistence for the approval queue and the append-only audit log. */
export class TriageStore {
  readonly db: Database.Database;

  /** `clock` exists so tests can pin time; timestamps are never taken from callers. */
  constructor(dbPath = ':memory:', private readonly clock: () => Date = () => new Date()) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ticket_id TEXT,
        payload_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT
      );
      -- At most one open proposal per ticket, enforced by the database rather than by callers.
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_ticket
        ON proposals(ticket_id) WHERE status = 'pending' AND ticket_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        proposal_id INTEGER,
        detail_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `);
  }

  /** Inserts a pending proposal and its audit entry in one transaction. */
  createProposal(payload: ProposalPayload, reason: string): Proposal {
    const at = this.clock().toISOString();
    const ticketId = payload.kind === 'assign_ticket' ? payload.ticketId : null;
    const id = this.db.transaction(() => {
      const res = this.db
        .prepare('INSERT INTO proposals (kind, ticket_id, payload_json, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(payload.kind, ticketId, JSON.stringify(payload), reason, at);
      const newId = Number(res.lastInsertRowid);
      this.audit('proposal_created', 'system', newId, { payload, reason });
      return newId;
    })();
    return this.getProposal(id)!;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row && toProposal(row);
  }

  listProposals(status?: ProposalStatus): Proposal[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY id').all(status)
        : this.db.prepare('SELECT * FROM proposals ORDER BY id').all()
    ) as ProposalRow[];
    return rows.map(toProposal);
  }

  /**
   * Moves a proposal out of 'pending' and writes the audit entry atomically.
   * Returns false if it was no longer pending, so two concurrent decisions cannot both win.
   */
  decide(
    id: number,
    status: 'approved' | 'rejected',
    by: string,
    note: string | null,
    payload: ProposalPayload
  ): boolean {
    return this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, payload_json = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(status, this.clock().toISOString(), by, note, JSON.stringify(payload), id);
      if (res.changes !== 1) return false;
      this.audit(`proposal_${status}`, by, id, { payload, note });
      return true;
    })();
  }

  /** Puts an approved proposal back in the queue after the adapter failed to apply it. */
  reopenAfterFailure(id: number, by: string, error: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE proposals SET status = 'pending', decided_at = NULL, decided_by = NULL, decision_note = NULL
           WHERE id = ? AND status = 'approved'`
        )
        .run(id);
      this.audit('apply_failed', by, id, { error });
    })();
  }

  audit(event: string, actor: string, proposalId: number | null, detail: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, event, proposal_id, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(this.clock().toISOString(), actor, event, proposalId, JSON.stringify(detail));
  }

  listAudit(): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<{
      id: number;
      at: string;
      actor: string;
      event: string;
      proposal_id: number | null;
      detail_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      event: r.event,
      proposalId: r.proposal_id,
      detail: JSON.parse(r.detail_json)
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    payload: ProposalPayloadSchema.parse(JSON.parse(row.payload_json)),
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note
  };
}
