import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import {
  openIncident,
  loadIncident,
  appendIncidentEvent,
  recordDiagnostic,
  recordFixAttempt,
  setIncidentStatus,
  closeIncident,
  listIncidents,
  findOpenIncidentForSignal,
  generateIncidentId,
  IncidentValidationError,
} from '../lib/incident.mjs';
import { nodeDir } from '../lib/op-record.mjs';

const USER = 'user_inctest';
const NODE = 'inc-node';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const SIG = (kind = 'service_up_failed', extra = {}) => ({
  kind, value: 'inactive', expected: 'active', fired_at: new Date().toISOString(), ...extra,
});

describe('openIncident', () => {
  it('creates an incident with status=open and an "opened" event', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    expect(inc.id).toMatch(/^inc_/);
    expect(inc.status).toBe('open');
    expect(inc.events).toHaveLength(1);
    expect(inc.events[0].type).toBe('opened');
  });

  it('persists to disk and round-trips', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const loaded = loadIncident(USER, NODE, inc.id);
    expect(loaded.id).toBe(inc.id);
  });

  it('de-dups: opening a second incident with same service+kind returns the first', () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const b = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    expect(b.id).toBe(a.id);
    expect(listIncidents(USER, NODE)).toHaveLength(1);
  });

  it('does NOT de-dup across different signal kinds', () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('service_up_failed') });
    const b = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('blocking_disabled') });
    expect(b.id).not.toBe(a.id);
  });

  it('rejects missing triggering_signal.kind', () => {
    expect(() =>
      openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: { value: 'x' } })
    ).toThrow(/triggering_signal/);
  });
});

describe('event appending', () => {
  it('records a diagnostic and transitions open → investigating', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const updated = recordDiagnostic(USER, NODE, inc.id, {
      recipe_step: 'systemctl status pihole-FTL',
      output_excerpt: 'Active: failed (Result: exit-code)',
      interpretation: 'service has crashed',
    });
    expect(updated.status).toBe('investigating');
    expect(updated.diagnostics_collected).toHaveLength(1);
    expect(updated.events.find(e => e.type === 'diagnostic_run')).toBeTruthy();
  });

  it('records a successful fix attempt and moves status to fix_applied', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    recordDiagnostic(USER, NODE, inc.id, { recipe_step: 'x', output_excerpt: 'y' });
    const updated = recordFixAttempt(USER, NODE, inc.id, {
      op_id_in_profile: 'pihole_restart',
      op_record_id: 'op_2026-05-06T18-00-00-000Z_aaaaaa',
      outcome: 'success',
      message: 'restartdns ok',
    });
    expect(updated.status).toBe('fix_applied');
    expect(updated.fix_attempts).toHaveLength(1);
  });

  it('records a failed fix as fix_failed event without changing status', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    recordDiagnostic(USER, NODE, inc.id, { recipe_step: 'x' });
    const before = loadIncident(USER, NODE, inc.id).status;
    const updated = recordFixAttempt(USER, NODE, inc.id, {
      op_id_in_profile: 'pihole_restart', outcome: 'failure', message: 'still failing',
    });
    expect(updated.status).toBe(before); // unchanged on failure
    expect(updated.events.find(e => e.type === 'fix_failed')).toBeTruthy();
  });

  it('rejects unknown event types', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    expect(() => appendIncidentEvent(USER, NODE, inc.id, { type: 'magic' })).toThrow(/event\.type/);
  });
});

describe('status transitions', () => {
  it('rejects illegal transition without force', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    expect(() => setIncidentStatus(USER, NODE, inc.id, 'fix_applied'))
      .toThrow(/transition .* not allowed/);
  });

  it('allows force-override to any status', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const updated = setIncidentStatus(USER, NODE, inc.id, 'fix_applied', { force: true });
    expect(updated.status).toBe('fix_applied');
  });

  it('always allows resolved/abandoned transitions', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const updated = setIncidentStatus(USER, NODE, inc.id, 'resolved', { summary: 'self-healed' });
    expect(updated.status).toBe('resolved');
    expect(updated.ts_closed).toBeTruthy();
    expect(updated.resolution_summary).toBe('self-healed');
  });

  it('records status_changed and closed events on resolution', () => {
    const inc = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG() });
    const updated = closeIncident(USER, NODE, inc.id, 'resolved by restart');
    expect(updated.events.find(e => e.type === 'closed')).toBeTruthy();
    expect(updated.events.find(e => e.type === 'status_changed')).toBeTruthy();
  });
});

describe('listIncidents', () => {
  it('returns most-recent first when timestamps differ', async () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('a') });
    // Sleep 5ms so the second incident has a strictly-greater ts_opened.
    await new Promise(r => setTimeout(r, 5));
    const b = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('b') });
    const list = listIncidents(USER, NODE);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('filters by openOnly', () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('a') });
    const b = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('b') });
    closeIncident(USER, NODE, a.id, 'fixed');
    const open = listIncidents(USER, NODE, { openOnly: true });
    expect(open.map(i => i.id)).toEqual([b.id]);
  });
});

describe('findOpenIncidentForSignal', () => {
  it('returns matching open incident', () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('xx') });
    const found = findOpenIncidentForSignal(USER, NODE, 'pihole', 'xx');
    expect(found?.id).toBe(a.id);
  });

  it('does not return resolved incidents', () => {
    const a = openIncident(USER, NODE, { service_id: 'pihole', triggering_signal: SIG('xx') });
    closeIncident(USER, NODE, a.id, 'fixed');
    expect(findOpenIncidentForSignal(USER, NODE, 'pihole', 'xx')).toBeNull();
  });
});

describe('generateIncidentId', () => {
  it('produces a sortable inc_ id', () => {
    const a = generateIncidentId(1000);
    const b = generateIncidentId(2000);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^inc_/);
  });
});
