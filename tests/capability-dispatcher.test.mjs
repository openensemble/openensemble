import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  dispatchCapabilityCall,
  resolveParameters,
  resolveAuth,
  buildOpSpec,
  verifyProfileReadonly,
} from '../lib/capability-dispatcher.mjs';
import { saveProfile, findOperation, loadProfile } from '../lib/service-profile.mjs';
import { readOpRecords, nodeDir, getRollbackStatus } from '../lib/op-record.mjs';
import { rollbackOperation } from '../lib/rollback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_capdisp';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Save a fresh fixture for every test.
  saveProfile(USER, NODE, JSON.parse(JSON.stringify(PIHOLE_FIXTURE)));
});

// ── helpers: synthetic Pi-hole API server ────────────────────────────────────

function makeMockPihole() {
  const blocklist = new Set(['existing.bad.com']);
  const fetchFn = async (url) => {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    const add = u.searchParams.get('add');
    const sub = u.searchParams.get('sub');
    const status = u.searchParams.has('status');
    const auth = u.searchParams.get('auth');
    if (auth !== 'good-token') {
      return new Response(JSON.stringify({ error: 'bad auth' }), { status: 401 });
    }
    if (status) return new Response(JSON.stringify({ status: 'enabled' }), { status: 200 });
    if (list === 'black' && !add && !sub) {
      return new Response(JSON.stringify({ data: [...blocklist] }), { status: 200 });
    }
    if (add) { blocklist.add(add); return new Response(JSON.stringify({ added: add }), { status: 200 }); }
    if (sub) { blocklist.delete(sub); return new Response(JSON.stringify({ removed: sub }), { status: 200 }); }
    return new Response('bad', { status: 400 });
  };
  return { blocklist, fetchFn };
}

const intent = (text) => ({ user_text: text, agent: 'coordinator' });

// ── resolveParameters ────────────────────────────────────────────────────────

describe('resolveParameters', () => {
  const op = {
    id: 'x', parameters: [
      { name: 'domain', type: 'string', required: true },
      { name: 'cadence', type: 'number', default: 30 },
    ],
  };

  it('passes through supplied params', () => {
    expect(resolveParameters(op, { domain: 'a.com' })).toEqual({ domain: 'a.com', cadence: 30 });
  });

  it('throws on missing required', () => {
    expect(() => resolveParameters(op, {})).toThrow(/required parameter/);
  });

  it('uses defaults', () => {
    const r = resolveParameters(op, { domain: 'a' });
    expect(r.cadence).toBe(30);
  });
});

// ── resolveAuth ──────────────────────────────────────────────────────────────

describe('resolveAuth', () => {
  it('returns auth_override when supplied', async () => {
    const profile = loadProfile(USER, NODE, 'pihole');
    const v = await resolveAuth(profile, { auth_override: 'override-token' });
    expect(v).toBe('override-token');
  });

  it('calls resolveAuth fn with token_storage ref', async () => {
    const profile = loadProfile(USER, NODE, 'pihole');
    let seen = null;
    const v = await resolveAuth(profile, { resolveAuth: (ref) => { seen = ref; return 'fn-token'; } });
    expect(seen).toBe('config_field:pihole_api_token');
    expect(v).toBe('fn-token');
  });

  it('returns "" for auth_method=none', async () => {
    const profile = loadProfile(USER, NODE, 'pihole');
    profile.control_surface.api.auth_method = 'none';
    expect(await resolveAuth(profile, {})).toBe('');
  });
});

// ── buildOpSpec ──────────────────────────────────────────────────────────────

describe('buildOpSpec (http)', () => {
  it('substitutes endpoint, auth, and parameters into the call templates', () => {
    const profile = loadProfile(USER, NODE, 'pihole');
    const op = findOperation(profile, 'dns_block');
    const spec = buildOpSpec(op, {
      endpoint: 'http://pi/admin',
      auth: 'tok',
      domain: 'ads.example.com',
    }, { profile_version: profile.profile_version });

    expect(spec.mechanism).toBe('http');
    expect(spec.write.url).toBe('http://pi/admin/api.php?list=black&add=ads.example.com&auth=tok');
    expect(spec.pre_capture.url).toBe('http://pi/admin/api.php?list=black&auth=tok');
    expect(spec.inverse.url).toBe('http://pi/admin/api.php?list=black&sub=ads.example.com&auth=tok');
    expect(spec.declared_risk).toBe('low');
  });

  it('builds a cli opSpec from profile.cli', () => {
    const profile = loadProfile(USER, NODE, 'pihole');
    const op = findOperation(profile, 'pihole_restart'); // mechanism: 'cli'
    const spec = buildOpSpec(op, { endpoint: 'http://x', auth: '' });
    expect(spec.mechanism).toBe('cli');
    expect(spec.write.command).toBe('pihole restartdns');
  });

  it('throws for genuinely unsupported mechanisms', () => {
    const op = {
      id: 'x', mechanism: 'sqlite', risk: 'low', readonly: true,
      parameters: [], verified: false,
    };
    expect(() => buildOpSpec(op, {})).toThrow(/not yet supported/);
  });
});

// ── dispatchCapabilityCall: end-to-end ───────────────────────────────────────

describe('dispatchCapabilityCall: end-to-end', () => {
  it('runs dns_block through the pipeline and writes an op record', async () => {
    const { blocklist, fetchFn } = makeMockPihole();

    const result = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'tracker.example.com' },
      intent: intent('block tracker.example.com'),
      ctx: { fetchFn, auth_override: 'good-token' },
    });

    expect(result.error).toBeNull();
    expect(result.record.outcome).toBe('success');
    expect(result.record.rollback.available).toBe(true);
    expect(blocklist.has('tracker.example.com')).toBe(true);

    const records = readOpRecords(USER, NODE);
    expect(records).toHaveLength(1);
    expect(records[0].operation.capability).toBe('dns');
  });

  it('rollback works through the dispatcher', async () => {
    const { blocklist, fetchFn } = makeMockPihole();

    const { record } = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'doubleclick.net' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'good-token' },
    });
    expect(blocklist.has('doubleclick.net')).toBe(true);

    const rb = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'),
      ctx: { fetchFn },
    });
    expect(rb.outcome).toBe('success');
    expect(blocklist.has('doubleclick.net')).toBe(false);

    const status = getRollbackStatus(USER, NODE, record.id);
    expect(status.invoked).toBe(true);
  });

  it('records a failure when auth is wrong', async () => {
    const { fetchFn } = makeMockPihole();
    const { record } = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'x.com' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'wrong-token' },
    });
    expect(record.outcome).toBe('failure');
    expect(record.rollback.available).toBe(false);
  });

  it('rejects missing required parameter', async () => {
    const { fetchFn } = makeMockPihole();
    await expect(dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: {}, // missing domain
      intent: intent(),
      ctx: { fetchFn, auth_override: 'good-token' },
    })).rejects.toThrow(/required parameter/);
  });

  it('rejects unknown opId', async () => {
    await expect(dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'no_such_op',
      intent: intent(),
      ctx: {},
    })).rejects.toThrow(/not found in profile/);
  });

  it('rejects when no profile exists for the service', async () => {
    await expect(dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'home_assistant', opId: 'dns_block',
      intent: intent(),
      ctx: {},
    })).rejects.toThrow(/no profile/);
  });

  it('redacts the raw auth token from the recorded parameters', async () => {
    const { fetchFn } = makeMockPihole();
    const { record } = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'redact-test.com' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'good-token' },
    });
    // The op record's parameters should not contain the auth token literal.
    const paramsJson = JSON.stringify(record.operation.parameters);
    expect(paramsJson).not.toContain('good-token');
    expect(paramsJson).toContain('"_redacted_auth":true');
  });

  it('auto-flips verified=true on a successful run of an unverified op', async () => {
    const { fetchFn } = makeMockPihole();
    // dns_block starts as verified: false in the fixture; running it
    // successfully should auto-mark it verified.
    const before = findOperation(loadProfile(USER, NODE, 'pihole'), 'dns_block');
    expect(before.verified).toBe(false);

    await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'autoverify.example.com' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'good-token' },
    });

    const after = findOperation(loadProfile(USER, NODE, 'pihole'), 'dns_block');
    expect(after.verified).toBe(true);
  });

  it('does NOT demote a verified op when a single run fails (transient blip)', async () => {
    const { fetchFn } = makeMockPihole();
    // First run: success → flips verified true.
    await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'first.example.com' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'good-token' },
    });
    expect(findOperation(loadProfile(USER, NODE, 'pihole'), 'dns_block').verified).toBe(true);

    // Second run: failure (wrong auth) — verified should STAY true.
    await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'dns_block',
      parameters: { domain: 'second.example.com' },
      intent: intent(),
      ctx: { fetchFn, auth_override: 'wrong-token' },
    });
    expect(findOperation(loadProfile(USER, NODE, 'pihole'), 'dns_block').verified).toBe(true);
  });
});

// ── verifyProfileReadonly ────────────────────────────────────────────────────

describe('verifyProfileReadonly', () => {
  it('runs all read-only ops and updates verification flags', async () => {
    const { fetchFn } = makeMockPihole();
    const summary = await verifyProfileReadonly({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      ctx: { fetchFn, auth_override: 'good-token' },
    });

    expect(summary.tested).toBeGreaterThan(0);
    expect(summary.passed).toBe(summary.tested);
    expect(summary.failed).toBe(0);

    const profile = loadProfile(USER, NODE, 'pihole');
    const status = findOperation(profile, 'status');
    const list = findOperation(profile, 'list_blocked');
    expect(status.verified).toBe(true);
    expect(list.verified).toBe(true);

    // Non-readonly ops should NOT have been touched
    const block = findOperation(profile, 'dns_block');
    expect(block.verified).toBe(false);
  });

  it('marks ops as failed when auth is wrong', async () => {
    const { fetchFn } = makeMockPihole();
    const summary = await verifyProfileReadonly({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      ctx: { fetchFn, auth_override: 'wrong' },
    });
    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.passed).toBe(0);

    const profile = loadProfile(USER, NODE, 'pihole');
    expect(findOperation(profile, 'status').verified).toBe(false);
    expect(findOperation(profile, 'status').last_failure).toBeTruthy();
  });

  it('skips ops with required-no-default parameters', async () => {
    // Add a synthetic op with required param to the profile
    const profile = loadProfile(USER, NODE, 'pihole');
    profile.operations.push({
      id: 'lookup_x', capability: 'dns',
      description: 'lookup that requires a domain',
      mechanism: 'http', risk: 'low', readonly: true,
      parameters: [{ name: 'domain', type: 'string', required: true }],
      http: { write: { method: 'GET', url: '${endpoint}/api.php?lookup=${domain}&auth=${auth}' } },
      verified: false, last_tested: null, last_failure: null,
    });
    saveProfile(USER, NODE, profile);

    const { fetchFn } = makeMockPihole();
    const summary = await verifyProfileReadonly({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      ctx: { fetchFn, auth_override: 'good-token' },
    });
    expect(summary.skipped).toBeGreaterThan(0);
    expect(summary.results.find(r => r.op_id === 'lookup_x').status).toBe('skipped');
  });
});
