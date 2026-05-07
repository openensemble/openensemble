import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperation } from '../lib/rollback.mjs';
import {
  readOpRecords,
  getRollbackStatus,
  nodeDir,
} from '../lib/op-record.mjs';

const USER = 'user_disptest';
const NODE = 'noopnode';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const intent = (text = 'test op', agent = 'test-agent') => ({ user_text: text, agent });

// ────────────────────────────────────────────────────────────────────────────
// noop set — the canonical reversible operation
// ────────────────────────────────────────────────────────────────────────────

describe('dispatcher: noop set (reversible)', () => {
  it('captures pre-state, executes, writes a record, world is updated', async () => {
    const world = new Map([['k', 'orig']]);
    const { record, error } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent('change k'),
      opSpec: {
        id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'updated' },
        declared_risk: 'low',
      },
      ctx: { world },
    });

    expect(error).toBeNull();
    expect(record.outcome).toBe('success');
    expect(record.pre_state.snapshots).toHaveLength(1);
    expect(record.pre_state.snapshots[0].metadata.oldValue).toBe('orig');
    expect(record.rollback.available).toBe(true);
    expect(record.rollback.method).toBe('noop');
    expect(record.operation.risk_class).toBe('low');
    expect(world.get('k')).toBe('updated');
  });

  it('rollback restores the original value', async () => {
    const world = new Map([['k', 'orig']]);
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'updated' },
        declared_risk: 'low',
      },
      ctx: { world },
    });
    expect(world.get('k')).toBe('updated');

    const result = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'), ctx: { world },
    });

    expect(result.outcome).toBe('success');
    expect(world.get('k')).toBe('orig');

    const status = getRollbackStatus(USER, NODE, record.id);
    expect(status.invoked).toBe(true);
    expect(status.invocation_outcome).toBe('success');
    expect(status.available).toBe(false);
  });

  it('rollback of a previously-absent key removes it', async () => {
    const world = new Map();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'newkey', value: 'newval' },
        declared_risk: 'low',
      },
      ctx: { world },
    });
    expect(world.get('newkey')).toBe('newval');

    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent(), ctx: { world },
    });
    expect(world.has('newkey')).toBe(false);
  });

  it('writes both forward and rollback records to activity.jsonl', async () => {
    const world = new Map();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'v' },
        declared_risk: 'low',
      },
      ctx: { world },
    });
    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent(), ctx: { world },
    });

    const all = readOpRecords(USER, NODE);
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(record.id);
    expect(all[1].rolls_back_op_id).toBe(record.id);
    expect(all[1].operation.id).toBe('rollback_noop_set');
  });

  it('rejects rolling back the same op twice', async () => {
    const world = new Map([['k', 'orig']]);
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'new' },
        declared_risk: 'low',
      },
      ctx: { world },
    });
    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent(), ctx: { world },
    });

    const second = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent(), ctx: { world },
    });
    expect(second.outcome).toBe('aborted');
    expect(second.message).toMatch(/already rolled back/);
  });

  it('rejects rollback of unknown op id', async () => {
    const result = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: 'op_never_existed',
      intent: intent(), ctx: { world: new Map() },
    });
    expect(result.outcome).toBe('aborted');
    expect(result.message).toMatch(/not found/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// noop destructive — the safety floor
// ────────────────────────────────────────────────────────────────────────────

describe('dispatcher: noop destructive (no rollback)', () => {
  it('escalates to risk:high regardless of declared risk', async () => {
    const world = new Map([['k', 'v']]);
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent('clear it'),
      opSpec: {
        id: 'noop_destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {},
        declared_risk: 'low', // LLM lying — should still end up high
      },
      ctx: { world },
    });
    expect(record.operation.risk_class).toBe('high');
    expect(record.rollback.available).toBe(false);
    expect(record.rollback.method).toBe('manual');
    expect(world.size).toBe(0);
  });

  it('rejects rollback of a destructive op', async () => {
    const world = new Map([['k', 'v']]);
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'medium',
      },
      ctx: { world },
    });
    const result = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent(), ctx: { world },
    });
    expect(result.outcome).toBe('aborted');
    expect(result.message).toMatch(/method=manual/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// http with a mocked fetch — simulates the Pi-hole-shape pattern
// ────────────────────────────────────────────────────────────────────────────

describe('dispatcher: http with mocked fetch', () => {
  function makeMockBlocklistServer() {
    const blocklist = new Set(['ads.example.com']);
    const fetchFn = async (url) => {
      const u = new URL(url);
      const list = u.searchParams.get('list');
      const add = u.searchParams.get('add');
      const sub = u.searchParams.get('sub');
      if (list === 'black' && !add && !sub) {
        return new Response(JSON.stringify({ data: [...blocklist] }), { status: 200 });
      }
      if (add) { blocklist.add(add); return new Response('added', { status: 200 }); }
      if (sub) { blocklist.delete(sub); return new Response('removed', { status: 200 }); }
      return new Response('bad', { status: 400 });
    };
    return { blocklist, fetchFn };
  }

  it('dispatches a write with paired pre_capture and inverse, supports rollback', async () => {
    const { blocklist, fetchFn } = makeMockBlocklistServer();

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('block doubleclick'),
      opSpec: {
        id: 'dns_block',
        mechanism: 'http',
        capability: 'dns',
        parameters: { domain: 'doubleclick.net' },
        declared_risk: 'low',
        pre_capture: { method: 'GET', url: 'http://pi/api?list=black' },
        write:       { method: 'GET', url: 'http://pi/api?list=black&add=doubleclick.net' },
        inverse:     { method: 'GET', url: 'http://pi/api?list=black&sub=doubleclick.net' },
      },
      ctx: { fetchFn },
    });

    expect(record.outcome).toBe('success');
    expect(record.rollback.available).toBe(true);
    expect(record.rollback.method).toBe('http');
    expect(record.pre_state.snapshots[0].type).toBe('http_response');
    expect(blocklist.has('doubleclick.net')).toBe(true);

    const rb = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'), ctx: { fetchFn },
    });
    expect(rb.outcome).toBe('success');
    expect(blocklist.has('doubleclick.net')).toBe(false);
  });

  it('marks rollback unavailable when neither pre_capture nor inverse is provided', async () => {
    const { fetchFn } = makeMockBlocklistServer();

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('one-shot'),
      opSpec: {
        id: 'dns_blind_write',
        mechanism: 'http',
        parameters: {},
        declared_risk: 'low',
        write: { method: 'GET', url: 'http://pi/api?list=black&add=x' },
      },
      ctx: { fetchFn },
    });

    expect(record.outcome).toBe('success');
    expect(record.rollback.available).toBe(false);
    expect(record.rollback.method).toBe('manual');
    expect(record.operation.risk_class).toBe('high'); // escalated due to no snapshot
  });

  it('records failures honestly when the write returns non-OK', async () => {
    const fetchFn = async (url) => {
      if (url.includes('list=black') && !url.includes('add=') && !url.includes('sub=')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('boom', { status: 500 });
    };

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'dns_block', mechanism: 'http', parameters: {},
        declared_risk: 'low',
        pre_capture: { method: 'GET', url: 'http://pi/api?list=black' },
        write:       { method: 'GET', url: 'http://pi/api?list=black&add=x' },
        inverse:     { method: 'GET', url: 'http://pi/api?list=black&sub=x' },
      },
      ctx: { fetchFn },
    });

    expect(record.outcome).toBe('failure');
    expect(record.rollback.available).toBe(false); // failed ops never auto-rollback
    expect(record.rollback.method).toBe('none');   // had a path, but op didn't succeed
  });
});

// ────────────────────────────────────────────────────────────────────────────
// invariants
// ────────────────────────────────────────────────────────────────────────────

describe('invariants', () => {
  it('LLM cannot downgrade risk below mechanism floor', async () => {
    const world = new Map();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'noop',
      intent: intent(),
      opSpec: {
        id: 'noop_destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'low',
      },
      ctx: { world },
    });
    expect(record.operation.risk_class).toBe('high');
  });

  it('every dispatch produces exactly one record', async () => {
    const world = new Map();
    for (let i = 0; i < 5; i++) {
      await dispatchOperation({
        userId: USER, nodeId: NODE, serviceId: 'noop',
        intent: intent(`op ${i}`),
        opSpec: {
          id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
          parameters: { key: `k${i}`, value: i },
          declared_risk: 'low',
        },
        ctx: { world },
      });
    }
    expect(readOpRecords(USER, NODE)).toHaveLength(5);
  });
});
