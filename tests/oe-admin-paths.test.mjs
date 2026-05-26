import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  assertWritablePath, assertConfigPathAllowed, validateRecipe,
  applyCredentialTemplates,
} from '../lib/oe-admin-paths.mjs';
import { BASE_DIR } from '../lib/paths.mjs';

const inBase = (rel) => path.join(BASE_DIR, rel);

describe('assertWritablePath', () => {
  it('accepts config.json', () => {
    expect(() => assertWritablePath(inBase('config.json'))).not.toThrow();
  });
  it('accepts config/user-providers.json', () => {
    expect(() => assertWritablePath(inBase('config/user-providers.json'))).not.toThrow();
  });
  it('accepts a snapshot file', () => {
    expect(() => assertWritablePath(inBase('config/oe-admin-snapshots/ent_abc/config.json'))).not.toThrow();
  });
  it('accepts an integration recipe', () => {
    expect(() => assertWritablePath(inBase('skills/oe-admin/integrations/tailscale.json'))).not.toThrow();
  });
  it('REJECTS the master key', () => {
    expect(() => assertWritablePath(inBase('users/_system/.master-key'))).toThrow(/deny list/);
  });
  it('REJECTS a lib/ source file', () => {
    expect(() => assertWritablePath(inBase('lib/credentials.mjs'))).toThrow(/deny list/);
  });
  it('REJECTS a routes/ source file', () => {
    expect(() => assertWritablePath(inBase('routes/config.mjs'))).toThrow(/deny list/);
  });
  it('REJECTS path traversal', () => {
    expect(() => assertWritablePath('/etc/passwd')).toThrow(/escapes/);
  });
  it('REJECTS a random unlisted path inside BASE_DIR', () => {
    expect(() => assertWritablePath(inBase('foo/bar.json'))).toThrow(/not on .* allowlist/);
  });
});

describe('assertConfigPathAllowed', () => {
  it('accepts enabledProviders.<name>', () => {
    expect(() => assertConfigPathAllowed('enabledProviders.cerebras')).not.toThrow();
  });
  it('accepts integrations.tailscale.enabled', () => {
    expect(() => assertConfigPathAllowed('integrations.tailscale.enabled')).not.toThrow();
  });
  it('accepts featureFlags.experimentalThing', () => {
    expect(() => assertConfigPathAllowed('featureFlags.experimentalThing')).not.toThrow();
  });
  it('REJECTS *ApiKey paths', () => {
    expect(() => assertConfigPathAllowed('cerebrasApiKey')).toThrow(/denied/);
    expect(() => assertConfigPathAllowed('cortex.openaiApiKey')).toThrow(/denied/);
  });
  it('REJECTS owner/userIds (privilege escalation guard)', () => {
    expect(() => assertConfigPathAllowed('owner')).toThrow(/denied/);
    expect(() => assertConfigPathAllowed('userIds')).toThrow(/denied/);
  });
  it('REJECTS *Token / *Password / *Secret', () => {
    expect(() => assertConfigPathAllowed('homeAssistant.token')).toThrow(/denied/);
    expect(() => assertConfigPathAllowed('foo.bar.password')).toThrow(/denied/);
    expect(() => assertConfigPathAllowed('clientSecret')).toThrow(/denied/);
  });
  it('REJECTS unlisted top-level fields', () => {
    expect(() => assertConfigPathAllowed('arbitraryField')).toThrow(/not on .* allowlist/);
  });
});

describe('validateRecipe', () => {
  it('accepts a minimal recipe', () => {
    const r = validateRecipe({
      name: 'tailscale',
      description: 'Install tailscale',
      steps: [{ id: 'up', cmd: ['tailscale', 'up'], requiresRoot: true }],
    });
    expect(r.name).toBe('tailscale');
  });

  it('rejects bad name', () => {
    expect(() => validateRecipe({
      name: 'Bad Name', description: 'x', steps: [{ id: 's', cmd: ['ls'] }],
    })).toThrow(/lowercase letters/);
  });

  it('rejects shell metacharacters in cmd[0]', () => {
    expect(() => validateRecipe({
      name: 'bad', description: 'x',
      steps: [{ id: 's', cmd: ['ls; rm -rf /', '-la'] }],
    })).toThrow(/not a safe binary name/);
  });

  it('rejects undeclared credential references', () => {
    expect(() => validateRecipe({
      name: 'bad', description: 'x',
      steps: [{ id: 's', cmd: ['curl', '-H', 'Authorization: Bearer {{credentials.ghost_key}}'] }],
    })).toThrow(/undeclared credential/);
  });

  it('accepts declared credential references', () => {
    const r = validateRecipe({
      name: 'good', description: 'x',
      credentials: [{ id: 'my_key', label: 'My Key' }],
      steps: [{ id: 's', cmd: ['curl', '-H', 'Authorization: Bearer {{credentials.my_key}}'] }],
    });
    expect(r.credentials).toHaveLength(1);
  });

  it('enforces configWrites path allowlist', () => {
    expect(() => validateRecipe({
      name: 'bad', description: 'x',
      steps: [{ id: 's', cmd: ['true'] }],
      configWrites: [{ path: 'someApiKey', value: 'sneaky' }],
    })).toThrow(/denied/);
  });
});

describe('applyCredentialTemplates', () => {
  it('substitutes declared credential values', () => {
    const out = applyCredentialTemplates(['curl', '-H', 'X: {{credentials.foo}}'], { foo: 'secret' });
    expect(out).toEqual(['curl', '-H', 'X: secret']);
  });
  it('throws on missing credential value', () => {
    expect(() => applyCredentialTemplates(['curl', '-H', '{{credentials.foo}}'], {})).toThrow(/missing credential/);
  });
  it('leaves cmd[0] untouched', () => {
    const out = applyCredentialTemplates(['echo', 'plain'], {});
    expect(out[0]).toBe('echo');
  });
  it('substitutes env templates', () => {
    const out = applyCredentialTemplates(['echo', 'base={{env.OE_BASE_DIR}}'], {}, { OE_BASE_DIR: '/x' });
    expect(out).toEqual(['echo', 'base=/x']);
  });
  it('throws on missing env value', () => {
    expect(() => applyCredentialTemplates(['echo', '{{env.OE_NOPE}}'], {}, {})).toThrow(/missing env/);
  });
  it('handles both credential and env templates in the same arg', () => {
    const out = applyCredentialTemplates(
      ['curl', '-H', 'Auth: Bearer {{credentials.k}}', '-d', 'who={{env.OE_USER}}'],
      { k: 'sk-123' }, { OE_USER: 'alex' });
    expect(out).toEqual(['curl', '-H', 'Auth: Bearer sk-123', '-d', 'who=alex']);
  });
});

describe('validateRecipe — stdin field', () => {
  it('accepts a step with stdin string', () => {
    const r = validateRecipe({
      name: 'unit', description: 'x',
      steps: [{ id: 'write', cmd: ['tee', '/etc/foo'], stdin: 'hello' }],
    });
    expect(r.steps[0].stdin).toBe('hello');
  });
  it('rejects non-string stdin', () => {
    expect(() => validateRecipe({
      name: 'bad', description: 'x',
      steps: [{ id: 'write', cmd: ['tee', '/etc/foo'], stdin: { not: 'a string' } }],
    })).toThrow(/stdin must be a string/);
  });
});
