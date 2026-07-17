import { beforeAll, describe, expect, it } from 'vitest';
import { addRoleManifest, getSelectedPlanKeepTools, loadRoleManifests } from './roles.mjs';

beforeAll(() => {
  loadRoleManifests({ runMigrations: false });
  addRoleManifest({
    id: 'test-calendar',
    tools: [
      { function: { name: 'gcal_list' } },
      { function: { name: 'gcal_create' } },
      { function: { name: 'gcal_update' } },
    ],
    selected_plan_keep: ['gcal_create', 'gcal_update'],
  });
  addRoleManifest({
    id: 'test-research',
    tools: [
      { function: { name: 'research_search' } },
      { function: { name: 'save_research' } },
    ],
    selected_plan_keep: ['save_research'],
  });
  addRoleManifest({
    id: 'test-foreign-skill',
    tools: [{ function: { name: 'foreign_action' } }, { function: { name: 'foreign_finish' } }],
    selected_plan_keep: ['foreign_finish'],
  }, 'foreign_user');
  addRoleManifest({
    id: 'test-first-owner',
    tools: [{ function: { name: 'shared_action' } }, { function: { name: 'first_finish' } }],
    selected_plan_keep: ['first_finish'],
  });
  addRoleManifest({
    id: 'test-later-owner',
    tools: [{ function: { name: 'shared_action' } }, { function: { name: 'later_finish' } }],
    selected_plan_keep: ['later_finish'],
  });
  addRoleManifest({
    id: 'test-malformed-keep',
    tools: [{ function: { name: 'malformed_action' } }],
    selected_plan_keep: ['tool_owned_by_someone_else'],
  });
});

describe('selected-plan terminal tool scoping', () => {
  it('keeps terminal tools only for manifests represented by selected tools', () => {
    expect([...getSelectedPlanKeepTools(new Set(['gcal_list']))].sort())
      .toEqual(['gcal_create', 'gcal_update']);
    expect([...getSelectedPlanKeepTools(new Set(['research_search']))])
      .toEqual(['save_research']);
    expect([...getSelectedPlanKeepTools(new Set(['unknown_tool']))]).toEqual([]);
    expect([...getSelectedPlanKeepTools(new Set())]).toEqual([]);
  });

  it('preserves the legacy all-manifest union when no selection is supplied', () => {
    expect([...getSelectedPlanKeepTools()]).toEqual(expect.arrayContaining([
      'gcal_create', 'save_research',
    ]));
  });

  it('does not apply another user custom terminal declaration', () => {
    expect([...getSelectedPlanKeepTools(new Set(['foreign_action']), 'current_user')]).toEqual([]);
    expect([...getSelectedPlanKeepTools(new Set(['foreign_action']), 'foreign_user')])
      .toEqual(['foreign_finish']);
  });

  it('uses the first tool owner and ignores malformed cross-skill keep entries', () => {
    expect([...getSelectedPlanKeepTools(new Set(['shared_action']))]).toEqual(['first_finish']);
    expect([...getSelectedPlanKeepTools(new Set(['malformed_action']))]).toEqual([]);
  });
});
