import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REFEREE, run, setup } from './helpers.mjs';

// A seat marked "blocked" in seats.json is defined but unusable: doctor reports it unavailable
// with the reason, and naming it as a co-chair refuses with SEAT_BLOCKED. The test reads the real
// seat table, so it checks every blocked seat that exists and passes vacuously when none is.
test('a blocked seat is reported unavailable and refused when named', () => {
  const ctx = setup();
  const table = JSON.parse(fs.readFileSync(path.join(path.dirname(REFEREE), 'seats.json'), 'utf8'));
  const entries = Object.entries(table.seats);
  const blocked = entries.filter(([, s]) => s.blocked);
  const doc = run(['doctor'], ctx);
  assert.equal(doc.status, 0, doc.stdout);
  for (const [id, s] of blocked) {
    const row = doc.json.seats.find((r) => r.id === id);
    assert.ok(row, `doctor lists ${id}`);
    assert.equal(row.available, false, `${id} must be unavailable while blocked`);
    assert.ok(String(row.reason).includes(s.blocked), `${id} reason carries the blocked text`);
    const chair = entries.find(([oid, o]) => oid !== id && o.vendor !== s.vendor && !o.blocked);
    if (chair) {
      const started = run([
        'start', '--mode', 'full', '--chair', chair[0], '--cochair', id,
        '--project', ctx.project, '--goal', ctx.goal,
      ], ctx);
      assert.equal(started.status, 2, started.stdout);
      assert.equal(started.json.code, 'SEAT_BLOCKED');
    }
  }
});
