import { describe, expect, it } from 'vitest';
import { applyUserToolPlan, buildUserToolPlanSystemBlock } from './chat.mjs';

describe('server tool-plan prompt follows orchestration mode', () => {
  const selected = { mode: 'selected', selected: ['web_search'] };
  const tool = name => ({ type: 'function', function: { name, parameters: {} } });

  it('does not instruct a single assistant to call ask_agent', () => {
    const block = buildUserToolPlanSystemBlock({ _rosterSolo: true }, selected);
    expect(block).toContain('request_tools');
    expect(block).toContain('background worker');
    expect(block).not.toContain('ask_agent');
    expect(block).not.toContain('delegate');
  });

  it('does not resurrect ask_agent wording from a cached single-mode tool plan', () => {
    const block = buildUserToolPlanSystemBlock(
      { _rosterSolo: true },
      { mode: 'selected', selected: ['ask_agent'] },
    );
    expect(block).toContain('None of the requested action tools are available');
    expect(block).toContain('request_tools');
    expect(block).not.toContain('ask_agent');
  });

  it('intersects cached selections with the live mode-gated tool surface', () => {
    const single = {
      _rosterSolo: true,
      skillCategory: 'coordinator',
      tools: [tool('request_tools'), tool('spawn_worker')],
    };
    const singleResult = applyUserToolPlan(single, {
      mode: 'selected',
      selectedTools: ['ask_agent', 'request_tools'],
    });
    expect(singleResult.selected).toEqual(['request_tools']);
    expect(single.tools.map(entry => entry.function.name)).not.toContain('ask_agent');
    expect(buildUserToolPlanSystemBlock(single, singleResult)).not.toContain('ask_agent');

    const ensemble = {
      _rosterSolo: false,
      skillCategory: 'coordinator',
      tools: [tool('ask_agent'), tool('request_tools'), tool('spawn_worker')],
    };
    const ensembleResult = applyUserToolPlan(ensemble, {
      mode: 'selected',
      selectedTools: ['ask_agent', 'request_tools'],
    });
    expect(ensembleResult.selected).toEqual(['ask_agent', 'request_tools']);
    expect(ensemble.tools.map(entry => entry.function.name)).toContain('ask_agent');
    expect(buildUserToolPlanSystemBlock(ensemble, ensembleResult)).toContain('ask_agent');
  });

  it('restores delegation guidance for ensemble, including a one-agent ensemble flag', () => {
    const block = buildUserToolPlanSystemBlock({ _rosterSolo: false }, selected);
    expect(block).toContain('ask_agent/request_tools');
    expect(block).toContain('delegate');
  });
});
