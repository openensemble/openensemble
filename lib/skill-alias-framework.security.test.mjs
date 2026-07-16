import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const { saveUser, modifyUser } = await import('../routes/_helpers.mjs');
const { addRoleManifest } = await import('../roles.mjs');
const {
  registerAliasCatalog,
  unregisterAliasCatalog,
  resolveFromMessage,
} = await import('./skill-alias-framework.mjs');

const registrations = [];

function register(spec, importer = null, options = {}) {
  registerAliasCatalog(spec, importer, options);
  registrations.push({ entityKind: spec.entity_kind, userScope: options.userScope ?? null });
}

function seedChild(userId, skillId, allowedSkills) {
  saveUser({
    id: userId,
    name: userId,
    role: 'child',
    skills: [skillId],
    allowedSkills,
    skillAssignments: {},
  });
  addRoleManifest({
    id: skillId,
    name: skillId,
    custom: true,
    createdBy: userId,
    category: 'utility',
    tools: [],
  }, userId);
}

function configCatalog(entityKind, noun, relativePath) {
  return {
    entity_kind: entityKind,
    noun_singular: noun,
    noun_plural: `${noun}s`,
    catalog_source: {
      type: 'config_file',
      path: relativePath,
      format: 'array',
    },
    id_field: 'id',
    name_fields: ['name'],
    id_arg_names: ['id'],
  };
}

afterEach(() => {
  while (registrations.length) {
    const { entityKind, userScope } = registrations.pop();
    unregisterAliasCatalog(entityKind, userScope);
  }
});

describe('skill alias catalog authorization boundary', () => {
  it('checks child authorization before returning a cached config-file catalog after revoke', async () => {
    const userId = 'alias_cache_revoke_child';
    const skillId = 'alias_cache_revoke_skill';
    const entityKind = 'alias_cache_revoke_widget';
    seedChild(userId, skillId, [skillId]);
    fs.writeFileSync(
      path.join(USERS_DIR, userId, 'widgets.json'),
      JSON.stringify([{ id: 'alpha-id', name: 'alpha' }]),
    );
    register(
      configCatalog(entityKind, 'widget', 'users/{userId}/widgets.json'),
      null,
      { userScope: userId, skillId },
    );

    const permitted = await resolveFromMessage(userId, 'show me the alpha widget');
    expect(permitted).toMatchObject({ entity_kind: entityKind, id: 'alpha-id' });

    await modifyUser(userId, profile => { profile.allowedSkills = []; });

    // The first lookup populated both the five-minute catalog cache and a
    // learned alias. Revocation must win over both without waiting for TTL.
    const revoked = await resolveFromMessage(userId, 'show me the alpha widget');
    expect(revoked).toBeNull();
  });

  it('scopes same-kind catalogs per user and rejects traversal and symlink escapes', async () => {
    const userA = 'alias_scope_child_a';
    const userB = 'alias_scope_child_b';
    const skillA = 'alias_scope_skill_a';
    const skillB = 'alias_scope_skill_b';
    const sharedKind = 'alias_scoped_widget';
    seedChild(userA, skillA, [skillA]);
    seedChild(userB, skillB, [skillB]);

    fs.writeFileSync(
      path.join(USERS_DIR, userA, 'widgets.json'),
      JSON.stringify([{ id: 'a-id', name: 'alpha' }]),
    );
    fs.writeFileSync(
      path.join(USERS_DIR, userB, 'widgets.json'),
      JSON.stringify([{ id: 'b-id', name: 'bravo' }]),
    );

    register(
      configCatalog(sharedKind, 'widget', 'users/{userId}/widgets.json'),
      null,
      { userScope: userA, skillId: skillA },
    );
    register(
      configCatalog(sharedKind, 'widget', 'users/{userId}/widgets.json'),
      null,
      { userScope: userB, skillId: skillB },
    );

    expect(await resolveFromMessage(userA, 'show me the alpha widget'))
      .toMatchObject({ id: 'a-id' });
    expect(await resolveFromMessage(userA, 'show me the bravo widget')).toBeNull();
    expect(await resolveFromMessage(userB, 'show me the bravo widget'))
      .toMatchObject({ id: 'b-id' });
    expect(await resolveFromMessage(userB, 'show me the alpha widget')).toBeNull();

    const traversalKind = 'alias_traversal_escape_item';
    register(
      configCatalog(
        traversalKind,
        'escapeitem',
        `users/{userId}/../${userB}/widgets.json`,
      ),
      null,
      { userScope: userA, skillId: skillA },
    );
    expect(await resolveFromMessage(userA, 'show me the bravo escapeitem')).toBeNull();

    const linkedPath = path.join(USERS_DIR, userA, 'linked-widgets.json');
    fs.symlinkSync(path.join(USERS_DIR, userB, 'widgets.json'), linkedPath);
    const symlinkKind = 'alias_symlink_escape_item';
    register(
      configCatalog(symlinkKind, 'linkeditem', 'users/{userId}/linked-widgets.json'),
      null,
      { userScope: userA, skillId: skillA },
    );
    expect(await resolveFromMessage(userA, 'show me the bravo linkeditem')).toBeNull();
  });

  it('does not invoke an exported-function importer for a denied child skill', async () => {
    const userId = 'alias_denied_export_child';
    const skillId = 'alias_denied_export_skill';
    const entityKind = 'alias_denied_export_widget';
    seedChild(userId, skillId, []);
    const importer = vi.fn(async () => ({
      listAliasEntries: async () => [{ id: 'secret-id', name: 'secret' }],
    }));
    register({
      entity_kind: entityKind,
      noun_singular: 'secretwidget',
      noun_plural: 'secretwidgets',
      catalog_source: { type: 'exported_function', function: 'listAliasEntries' },
      id_field: 'id',
      name_fields: ['name'],
      id_arg_names: ['id'],
    }, importer, { userScope: userId, skillId });

    expect(await resolveFromMessage(userId, 'show me the secret secretwidget')).toBeNull();
    expect(importer).not.toHaveBeenCalled();
  });
});
