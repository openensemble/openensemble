import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkerStandingMemoryContext,
  filterWorkerLeafTools,
  WORKER_LEAF_FORBIDDEN_TOOL_NAMES,
  workerStandingMemoryOwner,
} from './worker-memory-policy.mjs';

describe('task-scoped worker memory contract', () => {
  const worker = {
    id: 'ephemeral_worker_1_a_jarvis',
    ephemeral: true,
    workerOwnerId: 'jarvis',
    systemPrompt: 'Owner persona, child safety, and assigned skill rules.',
  };
  const opts = { isolatedTaskRun: true, workerMemoryAgentId: 'jarvis' };

  it('loads relevant standing context through the stable owned agent with episodes disabled', async () => {
    const resolveOwnedAgent = vi.fn(async (agentId, userId) => ({ id: agentId, userId }));
    const buildContext = vi.fn(async () => ({
      systemInstructions: 'Pinned standing rule',
      userContext: 'Confirmed constraint',
      episodeHistory: '',
    }));
    const result = await buildWorkerStandingMemoryContext({
      agent: worker,
      turnOpts: opts,
      userId: 'user_a',
      query: 'Prepare the allergy-safe grocery order',
      resolveOwnedAgent,
      buildContext,
    });

    expect(resolveOwnedAgent).toHaveBeenCalledWith('jarvis', 'user_a');
    expect(buildContext).toHaveBeenCalledWith(
      'jarvis',
      'Prepare the allergy-safe grocery order',
      'user_a',
      { includeEpisodes: false },
    );
    expect(result).toMatchObject({ episodeHistory: '' });
  });

  it('denies generic ephemerals, non-isolated turns, and mismatched owner ids without reading memory', async () => {
    const resolveOwnedAgent = vi.fn(async agentId => ({ id: agentId }));
    const buildContext = vi.fn(async () => ({ systemInstructions: 'must not load' }));
    const denied = [
      { agent: { ...worker, workerOwnerId: undefined }, turnOpts: opts },
      { agent: worker, turnOpts: { ...opts, isolatedTaskRun: false } },
      { agent: worker, turnOpts: { ...opts, workerMemoryAgentId: 'parked-agent' } },
      { agent: { ...worker, ephemeral: false }, turnOpts: opts },
    ];
    for (const value of denied) {
      expect(workerStandingMemoryOwner(value.agent, value.turnOpts)).toBeNull();
      expect(await buildWorkerStandingMemoryContext({
        ...value,
        userId: 'user_a', query: 'private task', resolveOwnedAgent, buildContext,
      })).toBeNull();
    }
    expect(resolveOwnedAgent).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
  });

  it('fails closed when the requested owner is not visible to that user', async () => {
    const resolveOwnedAgent = vi.fn(async () => null);
    const buildContext = vi.fn();
    expect(await buildWorkerStandingMemoryContext({
      agent: worker,
      turnOpts: opts,
      userId: 'user_b',
      query: 'private task',
      resolveOwnedAgent,
      buildContext,
    })).toBeNull();
    expect(resolveOwnedAgent).toHaveBeenCalledWith('jarvis', 'user_b');
    expect(buildContext).not.toHaveBeenCalled();
  });

  it('removes every durable control-plane mutator while retaining read and task-action tools', () => {
    const retained = [
      'report_progress',
      'request_tools',
      'recall_facts',
      'skill_list_rules',
      'list_roles',
      'mcp_list_servers',
      'profile_load',
      'node_check_agent_permissions',
      'email_send',
      'create_document',
      'dispatch_op',
    ];
    const tools = [...WORKER_LEAF_FORBIDDEN_TOOL_NAMES, ...retained]
      .map(name => ({ type: 'function', function: { name } }));
    expect(filterWorkerLeafTools(tools, worker, opts).map(tool => tool.function.name))
      .toEqual(retained);
    expect(filterWorkerLeafTools(tools, { ...worker, workerOwnerId: 'other' }, opts)).toBe(tools);
  });

  it('publishes an exact duplicate-free deny contract for schema regressions', () => {
    expect(new Set(WORKER_LEAF_FORBIDDEN_TOOL_NAMES).size)
      .toBe(WORKER_LEAF_FORBIDDEN_TOOL_NAMES.length);
    expect(WORKER_LEAF_FORBIDDEN_TOOL_NAMES).toEqual(expect.arrayContaining([
      'remember_fact',
      'skill_add_rule',
      'set_orchestration_mode',
      'manage_user',
      'create_agent',
      'skill_create',
      'mcp_assign_server',
      'install_integration',
      'profile_verify_readonly',
      'node_grant_permission',
      'schedule_task',
      'create_watch',
    ]));
  });
});
