import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

let dir: string;
const run = async (...args: string[]) => {
  const lines: string[] = [];
  await main([...args, '--data', dir], (l) => lines.push(l));
  return lines.join('\n');
};
const tickets = () => JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8')) as Array<{ id: string; assigneeId?: string | null }>;
// The raw example file omits assigneeId for unassigned tickets, hence the ?? null.
const assignee = (id: string) => tickets().find((t) => t.id === id)?.assigneeId ?? null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cli-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('CLI end to end (example data, state persisted between commands)', () => {
  it('propose -> approve -> reject keeps the helpdesk file in step with decisions', async () => {
    await run('init');
    expect(await run('propose')).toContain('6 proposal(s) queued. Nothing has been applied.');
    expect(assignee('T-1001')).toBeNull();

    expect(await run('approve', '1', '--by', 'alex')).toContain('assign T-1001 -> tech-lin');
    expect(assignee('T-1001')).toBe('tech-lin');

    await run('reject', '2', '--by', 'alex', '--reason', 'client asked to wait');
    expect(assignee('T-1002')).toBeNull();

    const queue = await run('queue');
    expect(queue).not.toContain('#1 ');
    expect(queue).toContain('#3 [pending]');
    expect(await run('audit')).toContain('proposal_rejected');
  });

  it('digest lists only actionable mail and marks it read only after approval', async () => {
    await run('init');
    const out = await run('digest', '--for', 'lead@helpdesk.example', '--now', '2026-03-10T12:00:00Z');
    expect(out).toContain('m-01');
    expect(out).toContain('m-02');
    for (const skipped of ['m-03', 'm-04', 'm-05', 'm-06', 'm-07']) expect(out).not.toContain(skipped);

    const unread = () =>
      (JSON.parse(fs.readFileSync(path.join(dir, 'mail.json'), 'utf8')) as Array<{ id: string; unread: boolean }>)
        .filter((m) => m.unread)
        .map((m) => m.id);
    expect(unread()).toContain('m-01');
    await run('approve', '1', '--by', 'alex');
    expect(unread()).toEqual(['m-03', 'm-04', 'm-05', 'm-06']);
  });

  it('writes the Markdown report to a file', async () => {
    await run('init');
    const file = path.join(dir, 'report.md');
    await run('report', '--out', file, '--now', '2026-03-10T12:00:00Z');
    expect(fs.readFileSync(file, 'utf8')).toContain('| Rosa Lima | 1 | 1 | 2 | 4 |');
  });

  it('ingest rejects the whole file when one ticket is invalid, and refuses duplicate ids', async () => {
    await run('init');
    const before = tickets().length;
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(
      bad,
      JSON.stringify([
        { id: 'N-1', subject: 'ok', client: 'c', createdAt: '2026-03-10T09:00:00Z' },
        { id: 'N-2', subject: '', client: 'c', createdAt: 'nope' }
      ])
    );
    await expect(run('ingest', bad)).rejects.toThrow(/nothing imported: 1\.subject/);
    expect(tickets()).toHaveLength(before);

    const dup = path.join(dir, 'dup.json');
    fs.writeFileSync(dup, JSON.stringify([{ id: 'T-1001', subject: 'again', client: 'c', createdAt: '2026-03-10T09:00:00Z' }]));
    await expect(run('ingest', dup)).rejects.toThrow(/already exists/);
    expect(tickets()).toHaveLength(before);
  });

  it('fails loudly on missing operator, bad ids, bad dates and unknown commands', async () => {
    await run('init');
    await run('propose');
    await expect(run('approve', '1')).rejects.toThrow(/operator id is required/);
    await expect(run('approve', '1; DROP TABLE proposals', '--by', 'alex')).rejects.toThrow(/numeric proposal id/);
    await expect(run('report', '--now', 'not-a-date')).rejects.toThrow(/not a valid date/);
    await expect(run('ingest', path.join(dir, 'missing.json'))).rejects.toThrow(/Cannot read .*missing\.json/);
    await expect(run('explode')).rejects.toThrow(/Unknown command/);
    await expect(run('init')).rejects.toThrow(/already has data/);
  });
});
