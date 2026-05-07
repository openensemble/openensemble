import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import { renderActivity, activityMdPath } from '../lib/activity-render.mjs';
import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperation } from '../lib/rollback.mjs';
import { nodeDir, pinSnapshot } from '../lib/op-record.mjs';

const USER = 'user_render';
const NODE = 'rendernode';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const intent = (text = 'do thing') => ({ user_text: text, agent: 'tester' });

async function setOp(world, key, value) {
  return dispatchOperation({
    userId: USER, nodeId: NODE, serviceId: 'noop',
    intent: intent(`set ${key}=${value}`),
    opSpec: {
      id: 'noop_set', mechanism: 'noop', mechanism_subtype: 'set',
      parameters: { key, value }, declared_risk: 'low',
    },
    ctx: { world },
  });
}

describe('renderActivity', () => {
  it('returns the empty-state message when there are no records', () => {
    const md = renderActivity(USER, NODE);
    expect(md).toContain('No operations yet');
    expect(fs.existsSync(activityMdPath(USER, NODE))).toBe(true);
  });

  it('renders rows for each record in most-recent-first order', async () => {
    const world = new Map();
    await setOp(world, 'a', 1);
    await setOp(world, 'b', 2);
    await setOp(world, 'c', 3);

    const md = renderActivity(USER, NODE);
    expect(md).toContain('| When | Service | Operation |');
    // Row count: header + separator + 3 rows
    expect(md.split('\n').filter(l => l.startsWith('|')).length).toBe(5);
    // c was written last → should appear before a in the rendered table
    const idxA = md.indexOf('"a"');
    const idxC = md.indexOf('"c"');
    expect(idxC).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(idxC);
  });

  it('shows summary counts in the header', async () => {
    const world = new Map();
    await setOp(world, 'a', 1);
    await setOp(world, 'b', 2);
    const md = renderActivity(USER, NODE);
    expect(md).toMatch(/2 total/);
    expect(md).toMatch(/2 ok/);
  });

  it('marks an op as rolled-back once its rollback record exists', async () => {
    const world = new Map();
    const { record } = await setOp(world, 'k', 'orig');
    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id, intent: intent('undo'), ctx: { world },
    });
    const md = renderActivity(USER, NODE);
    expect(md).toContain('rolled back at');
    expect(md).toContain('rollback of');
  });

  it('marks pinned snapshots in the rollback column', async () => {
    const world = new Map();
    const { record } = await setOp(world, 'k', 'v');
    pinSnapshot(USER, NODE, record.id);
    const md = renderActivity(USER, NODE);
    expect(md).toContain('available (pinned)');
  });

  it('respects opts.limit', async () => {
    const world = new Map();
    for (let i = 0; i < 5; i++) await setOp(world, `k${i}`, i);
    const md = renderActivity(USER, NODE, { limit: 2 });
    // 2 rows + header + separator = 4 table lines
    expect(md.split('\n').filter(l => l.startsWith('|')).length).toBe(4);
  });

  it('does NOT write to disk when write:false', () => {
    const md = renderActivity(USER, NODE, { write: false });
    expect(md).toContain('No operations yet');
    expect(fs.existsSync(activityMdPath(USER, NODE))).toBe(false);
  });
});
