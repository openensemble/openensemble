import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildProfile,
  validateProfile,
  saveProfile,
  loadProfile,
  listProfilesForNode,
  deleteProfile,
  findOperation,
  findOperationsByCapability,
  substituteTemplate,
  markOperationVerified,
  setTrustState,
  renderProfileMd,
  profilesDir,
  profilePath,
  profileMdPath,
  ProfileValidationError,
} from '../lib/service-profile.mjs';
import { nodeDir } from '../lib/op-record.mjs';
import { BASE_DIR } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_proftest';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() { return JSON.parse(JSON.stringify(PIHOLE_FIXTURE)); }

describe('validateProfile', () => {
  it('accepts the canonical Pi-hole fixture', () => {
    expect(() => validateProfile(fixture())).not.toThrow();
  });

  it('rejects missing service_id', () => {
    const p = fixture(); delete p.service_id;
    expect(() => validateProfile(p)).toThrow(/service_id/);
  });

  it('rejects unknown trust_state', () => {
    const p = fixture(); p.trust_state = 'wishful';
    expect(() => validateProfile(p)).toThrow(/trust_state/);
  });

  it('rejects unknown auth_method', () => {
    const p = fixture(); p.control_surface.api.auth_method = 'magic';
    expect(() => validateProfile(p)).toThrow(/auth_method/);
  });

  it('rejects http operation missing http.write', () => {
    const p = fixture();
    p.operations[0].http = {};
    expect(() => validateProfile(p)).toThrow(/http.write/);
  });

  it('rejects unknown operation mechanism', () => {
    const p = fixture();
    p.operations[0].mechanism = 'astral_projection';
    expect(() => validateProfile(p)).toThrow(/mechanism/);
  });

  it('rejects parameter missing type', () => {
    const p = fixture();
    p.operations.push({
      id: 'bad', mechanism: 'http', risk: 'low', readonly: true,
      parameters: [{ name: 'x' }],
      http: { write: { url: 'http://x' } },
      verified: false,
    });
    expect(() => validateProfile(p)).toThrow(/parameter\.type/);
  });
});

describe('buildProfile defaults', () => {
  it('fills schema_version + profile_version + trust_state when omitted', () => {
    const p = buildProfile({
      service_id: 'pihole', node_id: NODE,
      identity: { what_it_is: 'thing' },
      control_surface: {},
      operations: [],
    });
    expect(p.schema_version).toBeGreaterThan(0);
    expect(p.profile_version).toMatch(/^\d{4}-\d{2}-\d{2}_/);
    expect(p.trust_state).toBe('unverified');
  });
});

describe('saveProfile + loadProfile', () => {
  it('round-trips the fixture through disk', () => {
    saveProfile(USER, NODE, fixture());
    const loaded = loadProfile(USER, NODE, 'pihole');
    expect(loaded.service_id).toBe('pihole');
    expect(loaded.operations).toHaveLength(PIHOLE_FIXTURE.operations.length);
    expect(loaded.endpoint).toBe('http://192.0.2.10/admin');
  });

  it('writes a sibling Markdown file', () => {
    saveProfile(USER, NODE, fixture());
    const md = fs.readFileSync(profileMdPath(USER, NODE, 'pihole'), 'utf8');
    expect(md).toContain('# pihole on pihole-test');
    expect(md).toContain('| `dns_block` |');
  });

  it('loadProfile returns null for unknown service', () => {
    expect(loadProfile(USER, NODE, 'no-such-service')).toBeNull();
  });

  it('rejects saving an invalid profile', () => {
    const bad = fixture();
    bad.trust_state = 'questionable';
    expect(() => saveProfile(USER, NODE, bad)).toThrow(ProfileValidationError);
  });

  it('canonicalizes drifted health_signals on save (check.type → mechanism, nested expect lifted)', () => {
    const drifted = fixture();
    drifted.health_signals = [{
      kind: 'exec', // legacy non-descriptive kind
      check: { type: 'exec', command: 'systemctl is-active foo', expect: 'active' }, // type instead of mechanism, nested expect
    }];
    saveProfile(USER, NODE, drifted);
    const reloaded = loadProfile(USER, NODE, 'pihole');
    const sig = reloaded.health_signals[0];
    expect(sig.check.mechanism).toBe('cli'); // exec → cli
    expect(sig.check.type).toBeUndefined();
    expect(sig.expect).toBe('active');       // lifted out of check
    expect(sig.check.expect).toBeUndefined();
    expect(sig.check.command).toBe('systemctl is-active foo');
  });

  it('auto-fills missing profile_version on save (no more "vundefined" surfaces)', () => {
    const noVersion = fixture();
    delete noVersion.profile_version;
    saveProfile(USER, NODE, noVersion);
    const reloaded = loadProfile(USER, NODE, 'pihole');
    expect(reloaded.profile_version).toBeTruthy();
    expect(reloaded.profile_version).toMatch(/\w/);
  });
});

describe('listProfilesForNode', () => {
  it('returns all profiles saved under a node', () => {
    saveProfile(USER, NODE, fixture());
    const second = fixture();
    second.service_id = 'home_assistant';
    saveProfile(USER, NODE, second);

    const list = listProfilesForNode(USER, NODE).map(p => p.service_id).sort();
    expect(list).toEqual(['home_assistant', 'pihole']);
  });

  it('returns empty for a node with no profiles dir', () => {
    expect(listProfilesForNode(USER, 'nope')).toEqual([]);
  });

  it('canonicalizes hostname → nodeId so list works regardless of which the caller passes', () => {
    // Plant a fake nodes.json with a hostname/nodeId mismatch.
    const nodesJsonPath = path.join(BASE_DIR, 'nodes.json');
    const prevContent = fs.existsSync(nodesJsonPath) ? fs.readFileSync(nodesJsonPath, 'utf8') : null;
    fs.writeFileSync(nodesJsonPath, JSON.stringify({ nodes: { [NODE]: { userId: USER, nodeId: NODE, hostname: 'pihole-host' } } }));
    try {
      saveProfile(USER, NODE, fixture()); // saves under canonical NODE
      // Listing by hostname should still find the profile.
      const byHost = listProfilesForNode(USER, 'pihole-host').map(p => p.service_id).sort();
      const byCanonical = listProfilesForNode(USER, NODE).map(p => p.service_id).sort();
      expect(byHost).toEqual(byCanonical);
      expect(byHost).toContain('pihole');
    } finally {
      if (prevContent !== null) fs.writeFileSync(nodesJsonPath, prevContent);
      else fs.unlinkSync(nodesJsonPath);
    }
  });
});

describe('deleteProfile', () => {
  it('removes json + md', () => {
    saveProfile(USER, NODE, fixture());
    expect(fs.existsSync(profilePath(USER, NODE, 'pihole'))).toBe(true);
    expect(fs.existsSync(profileMdPath(USER, NODE, 'pihole'))).toBe(true);
    deleteProfile(USER, NODE, 'pihole');
    expect(fs.existsSync(profilePath(USER, NODE, 'pihole'))).toBe(false);
    expect(fs.existsSync(profileMdPath(USER, NODE, 'pihole'))).toBe(false);
  });
});

describe('finders', () => {
  it('findOperation by id', () => {
    const p = fixture();
    expect(findOperation(p, 'dns_block').description).toMatch(/blocklist/);
    expect(findOperation(p, 'no_such')).toBeNull();
  });

  it('findOperationsByCapability returns all ops with that capability', () => {
    const p = fixture();
    const ops = findOperationsByCapability(p, 'dns');
    expect(ops.map(o => o.id).sort()).toEqual(['dns_block', 'dns_unblock', 'list_blocked', 'status']);
  });
});

describe('substituteTemplate', () => {
  it('replaces ${name} in strings', () => {
    expect(substituteTemplate('hello ${who}', { who: 'world' })).toBe('hello world');
  });

  it('walks objects recursively', () => {
    const tpl = { url: '${endpoint}/api?x=${y}', headers: { 'X-Auth': '${auth}' } };
    const out = substituteTemplate(tpl, { endpoint: 'http://x', y: '1', auth: 'abc' });
    expect(out).toEqual({ url: 'http://x/api?x=1', headers: { 'X-Auth': 'abc' } });
  });

  it('walks arrays', () => {
    expect(substituteTemplate(['${a}', '${b}'], { a: '1', b: '2' })).toEqual(['1', '2']);
  });

  it('throws on unresolved variables', () => {
    expect(() => substituteTemplate('${missing}', {})).toThrow(/unresolved/);
  });

  it('passes through non-template strings unchanged', () => {
    expect(substituteTemplate('plain text', {})).toBe('plain text');
  });
});

describe('markOperationVerified', () => {
  it('sets verified=true and last_tested on success', () => {
    saveProfile(USER, NODE, fixture());
    const updated = markOperationVerified(USER, NODE, 'pihole', 'list_blocked', true);
    const op = findOperation(updated, 'list_blocked');
    expect(op.verified).toBe(true);
    expect(op.last_tested).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(op.last_failure).toBeNull();
  });

  it('records last_failure on failure', () => {
    saveProfile(USER, NODE, fixture());
    const updated = markOperationVerified(USER, NODE, 'pihole', 'status', false, 'auth required');
    const op = findOperation(updated, 'status');
    expect(op.verified).toBe(false);
    expect(op.last_failure.error).toBe('auth required');
  });

  it('throws for unknown operation', () => {
    saveProfile(USER, NODE, fixture());
    expect(() => markOperationVerified(USER, NODE, 'pihole', 'no_op', true)).toThrow(/not in profile/);
  });
});

describe('setTrustState', () => {
  it('updates state and changed-by', () => {
    saveProfile(USER, NODE, fixture());
    const updated = setTrustState(USER, NODE, 'pihole', 'reviewed', 'shawn');
    expect(updated.trust_state).toBe('reviewed');
    expect(updated.trust_state_changed_by).toBe('shawn');
  });

  it('rejects invalid state', () => {
    saveProfile(USER, NODE, fixture());
    expect(() => setTrustState(USER, NODE, 'pihole', 'magic')).toThrow(/invalid trust_state/);
  });
});

describe('agent_requirements (validation)', () => {
  it('accepts a profile with no agent_requirements', () => {
    expect(() => validateProfile(fixture())).not.toThrow();
  });

  it('accepts a well-formed group requirement', () => {
    const p = fixture();
    p.agent_requirements = [
      { type: 'group', name: 'pihole', rationale: 'pihole v6 CLI writes' },
    ];
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('accepts multiple requirement types', () => {
    const p = fixture();
    p.agent_requirements = [
      { type: 'group', name: 'pihole' },
      { type: 'sudoers', name: '/usr/local/bin/pihole', rationale: 'alt to group' },
      { type: 'access_level', name: 'full', rationale: 'pct/qm need root' },
      { type: 'capability', name: 'CAP_NET_BIND_SERVICE' },
    ];
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('rejects unknown requirement type', () => {
    const p = fixture();
    p.agent_requirements = [{ type: 'magic_perms', name: 'x' }];
    expect(() => validateProfile(p)).toThrow(/type must be one of/);
  });

  it('rejects missing name on non-access_level types', () => {
    const p = fixture();
    p.agent_requirements = [{ type: 'group' }];
    expect(() => validateProfile(p)).toThrow(/name required/);
  });

  it('rejects invalid access_level values', () => {
    const p = fixture();
    p.agent_requirements = [{ type: 'access_level', name: 'demigod' }];
    expect(() => validateProfile(p)).toThrow(/access_level name must be/);
  });

  it('renders agent_requirements in Markdown', () => {
    const p = fixture();
    p.agent_requirements = [
      { type: 'group', name: 'pihole', rationale: 'Pi-hole v6 CLI writes' },
    ];
    const md = renderProfileMd(p);
    expect(md).toContain('## Agent requirements');
    expect(md).toContain('Member of group `pihole`');
    expect(md).toContain('Pi-hole v6 CLI writes');
  });
});

describe('renderProfileMd', () => {
  it('contains key fields for the Pi-hole profile', () => {
    const md = renderProfileMd(fixture());
    expect(md).toContain('# pihole on pihole-test');
    expect(md).toContain('## Operations');
    expect(md).toContain('## Health signals');
    expect(md).toContain('## Known failure modes');
    expect(md).toContain('## Log sources');
    expect(md).toContain('## Research sources');
    expect(md).toContain('http://192.0.2.10/admin');
  });

  it('shows trust badge', () => {
    const p = fixture(); p.trust_state = 'reviewed';
    expect(renderProfileMd(p)).toContain('reviewed');
  });

  it('marks unverified operations', () => {
    const md = renderProfileMd(fixture());
    expect(md).toContain('| —'); // unverified marker in operations table
  });
});
