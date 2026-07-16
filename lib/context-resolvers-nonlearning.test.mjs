import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { USERS_DIR } from './paths.mjs';
import { buildContextHints } from './context-resolvers.mjs';
import {
  registerAliasCatalog,
  resolveFromMessage,
  setAliasExternal,
  unregisterAliasCatalog,
} from './skill-alias-framework.mjs';
import { runWithTurnContext } from './turn-abort-context.mjs';

const cleanup = [];

function fixture({ entityKind, userId, entries }) {
  cleanup.push({ entityKind, userId });
  registerAliasCatalog({
    entity_kind: entityKind,
    noun_singular: 'widget',
    noun_plural: 'widgets',
    catalog_source: { type: 'inline_function', fn: async () => entries },
    id_field: 'id',
    name_fields: ['name'],
    id_arg_names: ['widget_id'],
  });
  return path.join(USERS_DIR, userId, `${entityKind}-aliases.json`);
}

afterEach(() => {
  for (const { entityKind, userId } of cleanup.splice(0)) {
    unregisterAliasCatalog(entityKind);
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

describe('context alias non-learning reads', () => {
  it('resolves an existing alias without changing its storage', async () => {
    const entityKind = 'readonly_existing_widget';
    const userId = 'readonly-existing-user';
    const aliasFile = fixture({
      entityKind,
      userId,
      entries: [{ id: 'widget-1', name: 'Kitchen' }],
    });
    await setAliasExternal(userId, entityKind, 'cooking area', 'widget-1');
    const before = fs.readFileSync(aliasFile, 'utf8');

    const result = await resolveFromMessage(
      userId,
      'Check the cooking area widget',
      { readOnly: true },
    );

    expect(result?.id).toBe('widget-1');
    expect(fs.readFileSync(aliasFile, 'utf8')).toBe(before);
  });

  it('retains a stale alias in read-only mode while normal resolution deletes it', async () => {
    const entityKind = 'readonly_stale_widget';
    const userId = 'readonly-stale-user';
    const aliasFile = fixture({
      entityKind,
      userId,
      entries: [{ id: 'widget-2', name: 'Office' }],
    });
    await setAliasExternal(userId, entityKind, 'kitchen', 'deleted-widget');

    expect(await resolveFromMessage(
      userId,
      'Check the kitchen widget',
      { suppressLearning: true },
    )).toBeNull();
    expect(JSON.parse(fs.readFileSync(aliasFile, 'utf8'))).toEqual({ kitchen: 'deleted-widget' });

    expect(await resolveFromMessage(userId, 'Check the kitchen widget')).toBeNull();
    expect(JSON.parse(fs.readFileSync(aliasFile, 'utf8'))).toEqual({});
  });

  it('builds the same catalog hint without auto-saving a fallback alias', async () => {
    const entityKind = 'readonly_catalog_widget';
    const userId = 'readonly-catalog-user';
    const aliasFile = fixture({
      entityKind,
      userId,
      entries: [{ id: 'widget-3', name: 'Kitchen' }],
    });

    const readOnly = await buildContextHints(
      userId,
      'Check the kitchen widget',
      { suppressLearning: true },
    );
    expect(readOnly.resolutions[0]?.resolution?.id).toBe('widget-3');
    expect(readOnly.hints).toContain('id="widget-3"');
    expect(fs.existsSync(aliasFile)).toBe(false);

    const normal = await buildContextHints(userId, 'Check the kitchen widget');
    expect(normal).toEqual(readOnly);
    expect(JSON.parse(fs.readFileSync(aliasFile, 'utf8'))).toEqual({ kitchen: 'widget-3' });
  });

  it('inherits read-only alias resolution across indirect delegate-style calls', async () => {
    const entityKind = 'ambient_readonly_catalog_widget';
    const userId = 'ambient-readonly-catalog-user';
    const aliasFile = fixture({
      entityKind,
      userId,
      entries: [{ id: 'widget-4', name: 'Kitchen' }],
    });

    const inherited = await runWithTurnContext(
      { suppressLearning: true },
      () => buildContextHints(userId, 'Check the kitchen widget'),
    );
    expect(inherited.resolutions[0]?.resolution?.id).toBe('widget-4');
    expect(inherited.hints).toContain('id="widget-4"');
    expect(fs.existsSync(aliasFile)).toBe(false);

    const normal = await buildContextHints(userId, 'Check the kitchen widget');
    expect(normal).toEqual(inherited);
    expect(JSON.parse(fs.readFileSync(aliasFile, 'utf8'))).toEqual({ kitchen: 'widget-4' });
  });
});
