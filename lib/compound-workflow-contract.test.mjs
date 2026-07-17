import { describe, expect, it } from 'vitest';

import {
  buildCompoundWorkflowContract,
  evaluateCompoundWorkflowContract,
  formatCompoundContractFailure,
} from './compound-workflow-contract.mjs';

function matched(toolName, clause, {
  capability = toolName,
  delivery = false,
  sideEffecting = false,
  dependsOn,
} = {}) {
  return {
    toolName,
    capability,
    clause,
    traits: { delivery, sideEffecting },
    ...(dependsOn ? { dependsOn } : {}),
  };
}

function decision(steps, clauses = steps.map(step => step.clause)) {
  return { shouldBackground: true, clauses, matchedSteps: steps };
}

function done(name, callSeq, resultSeq, extra = {}) {
  return {
    name,
    status: 'done',
    callObserved: true,
    callSeq,
    resultSeq,
    toolCallId: `call_${name}_${callSeq}`,
    text: `${name} completed`,
    ...extra,
  };
}

function researchEmailContract({ exact = false } = {}) {
  return buildCompoundWorkflowContract(decision([
    matched(
      'deep_research_parallel',
      `Run deep research by calling deep_research_parallel${exact ? ' exactly once' : ''}.`,
      { capability: 'deep-research' },
    ),
    matched(
      'email_user',
      `Email the new report with email_user${exact ? ' exactly once' : ''}.`,
      { capability: 'email-send', delivery: true },
    ),
  ]));
}

describe('compound workflow contract construction', () => {
  it('freezes a metadata-only contract and makes delivery depend on every prior step', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('image_generation', 'Generate an image.', { capability: 'visual-maker' }),
      matched('conditions_now', 'Check current conditions.', { capability: 'conditions' }),
      matched('email_user', 'Email both results exactly once.', {
        capability: 'delivery', delivery: true,
      }),
    ]));

    expect(contract).toEqual({
      version: 1,
      source: 'singleton-compound',
      steps: [
        {
          index: 0, toolName: 'image_generation', capability: 'visual-maker',
          delivery: false, sideEffecting: false, exactlyOnce: false, dependsOn: [],
        },
        {
          index: 1, toolName: 'conditions_now', capability: 'conditions',
          delivery: false, sideEffecting: false, exactlyOnce: false, dependsOn: [],
        },
        {
          index: 2, toolName: 'email_user', capability: 'delivery',
          delivery: true, sideEffecting: true, exactlyOnce: true, dependsOn: [0, 1],
        },
      ],
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.steps)).toBe(true);
    expect(contract.steps.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(contract.steps[2].dependsOn)).toBe(true);
  });

  it('honors explicit causal dependencies without imposing total order', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('producer_a', 'Produce A.'),
      matched('producer_b', 'Produce B.'),
      matched('consumer', 'Consume only A.', { dependsOn: [0] }),
    ]));
    expect(contract.steps[2].dependsOn).toEqual([0]);
  });

  it('rejects partial clause coverage and malformed dependencies before admission', () => {
    expect(() => buildCompoundWorkflowContract(decision([
      matched('research', 'Research.'),
      matched('email_user', 'Email.', { delivery: true }),
    ], ['Research.', 'Email.', 'Upload.']))).toThrow(/every instruction clause/i);

    expect(() => buildCompoundWorkflowContract(decision([
      matched('research', 'Research.'),
      matched('email_user', 'Email.', { delivery: true, dependsOn: [1] }),
    ]))).toThrow(/invalid dependency/i);
  });
});

describe('compound workflow completion evaluation', () => {
  it('accepts a completed research then delivery workflow', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2),
      done('email_user', 3, 4),
    ]);

    expect(audit.ok).toBe(true);
    expect(audit.code).toBe('ok');
    expect(audit.completed.map(step => step.toolName)).toEqual([
      'deep_research_parallel', 'email_user',
    ]);
    expect(audit.completedSideEffects.map(step => step.toolName)).toEqual(['email_user']);
  });

  it('fails when a required routed step was never called', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2),
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual([expect.objectContaining({
      stepIndex: 1, toolName: 'email_user', reason: 'tool was not called',
    })]);
  });

  it.each([
    [{ status: 'error', text: 'provider rejected the request' }, 'structural error'],
    [{ status: 'done', text: 'Tool error: provider rejected the request' }, 'text-normalized error'],
    [{ status: 'done', isError: true, text: 'provider rejected the request' }, 'explicit error flag'],
    [{ status: 'done', text: 'Unknown tool: deep_research_parallel' }, 'dispatcher refusal'],
  ])('fails a required tool with a %s result (%s)', (failure) => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2, failure),
      done('email_user', 3, 4),
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.failed).toEqual([expect.objectContaining({
      stepIndex: 0, toolName: 'deep_research_parallel',
    })]);
    // Delivery cannot prove its prerequisite, even if an unsafe call appeared.
    expect(audit.missing).toEqual([expect.objectContaining({ toolName: 'email_user' })]);
  });

  it('treats the observed synthetic auto-background result as pending, never success', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2, {
        text: 'deep_research_parallel is running in the background (task watcher_123). The result will arrive later.',
      }),
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.pending).toEqual([expect.objectContaining({
      stepIndex: 0, toolName: 'deep_research_parallel',
    })]);
    expect(audit.missing).toEqual([expect.objectContaining({ toolName: 'email_user' })]);
    expect(audit.completed).toEqual([]);
  });

  it.each(['queued', 'running', 'streaming'])('fails a required %s call that never settled', status => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      {
        name: 'deep_research_parallel', status, callObserved: true,
        callSeq: 1, resultSeq: 2, text: 'work remains active',
      },
    ]);
    expect(audit.ok).toBe(false);
    expect(audit.running).toEqual([expect.objectContaining({ toolName: 'deep_research_parallel' })]);
  });

  it('fails delivery that started before its producer returned', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 4),
      done('email_user', 2, 3),
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.outOfOrder).toEqual([expect.objectContaining({
      stepIndex: 1,
      toolName: 'email_user',
      dependencyResultSeq: 4,
      observedCallSeq: 2,
    })]);
    expect(audit.completed.map(step => step.toolName)).toEqual(['deep_research_parallel']);
  });

  it('allows independent producers to run in parallel before their delivery barrier', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('image_generation', 'Generate an image.'),
      matched('conditions_now', 'Check the weather.'),
      matched('email_user', 'Email both.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      // Both calls begin before either result; completion order is irrelevant.
      done('image_generation', 1, 4, { native: true }),
      done('conditions_now', 2, 3),
      done('email_user', 5, 6),
    ]);
    expect(audit.ok).toBe(true);
  });

  it('consumes distinct successful events for repeated required tool names', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('conditions_now', 'Check conditions at location A.'),
      matched('conditions_now', 'Check conditions at location B.'),
      matched('email_user', 'Email both results.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      done('conditions_now', 1, 3, { toolCallId: 'weather_a' }),
      done('conditions_now', 2, 4, { toolCallId: 'weather_b' }),
      done('email_user', 5, 6),
    ]);
    expect(audit.ok).toBe(true);
    expect(audit.completed.slice(0, 2).map(step => step.toolCallId)).toEqual([
      'weather_a', 'weather_b',
    ]);
  });

  it('fails repeated required names when one event is reused as two steps', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('conditions_now', 'Check conditions at location A.'),
      matched('conditions_now', 'Check conditions at location B.'),
      matched('email_user', 'Email both results.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      done('conditions_now', 1, 2),
      done('email_user', 3, 4),
    ]);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepIndex: 1, toolName: 'conditions_now' }),
      expect.objectContaining({ stepIndex: 2, toolName: 'email_user' }),
    ]));
  });

  it('enforces explicit exactly-once cardinality without retrying anything', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract({ exact: true }), [
      done('deep_research_parallel', 1, 2, { toolCallId: 'research_first' }),
      done('deep_research_parallel', 3, 4, { toolCallId: 'research_duplicate' }),
      done('email_user', 5, 6),
    ]);
    expect(audit.ok).toBe(false);
    expect(audit.overInvoked).toEqual([{
      toolName: 'deep_research_parallel', expected: 1, observed: 2,
    }]);
  });

  it('permits a recovered non-exact read failure while retaining audit evidence', () => {
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2, {
        status: 'error', text: 'Tool error: transient failure', toolCallId: 'research_failed',
      }),
      done('deep_research_parallel', 3, 4, { toolCallId: 'research_recovered' }),
      done('email_user', 5, 6),
    ]);
    expect(audit.ok).toBe(true);
    expect(audit.recoveredFailures).toEqual([expect.objectContaining({
      toolName: 'deep_research_parallel', count: 1,
    })]);
  });

  it('accepts provider-native image call/result evidence and ignores helper tools', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('image_generation', 'Generate an image.', { capability: 'visual-maker' }),
      matched('email_user', 'Email the image.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      done('request_tools', 0, 0),
      done('image_generation', 1, 2, {
        native: true,
        toolCallId: 'provider_image_1',
        text: 'Generated image and saved attachment images:cat.png.',
      }),
      done('report_progress', 2, 2),
      done('email_user', 3, 4),
    ]);
    expect(audit.ok).toBe(true);
    expect(audit.completed[0]).toMatchObject({
      toolName: 'image_generation', native: true, toolCallId: 'provider_image_1',
    });
  });

  it('does not accept a provider-native image/result record with no observed call', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('image_generation', 'Generate an image.'),
      matched('email_user', 'Email the image.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      {
        name: 'image_generation', status: 'done', native: true,
        callObserved: false, resultSeq: 2, text: 'Generated image.',
      },
      done('email_user', 3, 4),
    ]);
    expect(audit.ok).toBe(false);
    expect(audit.unverifiable).toEqual([expect.objectContaining({
      stepIndex: 0,
      toolName: 'image_generation',
      reason: 'tool call was not observed',
    })]);
  });

  it('supports the explicit progress-only evidence shape for provider-hosted search', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('web_search', 'Search the web.'),
      matched('email_user', 'Email the findings.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      {
        name: 'web_search', status: 'done', native: true,
        completionEvidence: 'provider-progress', callSeq: 1, resultSeq: 1,
        text: 'provider-hosted web search',
      },
      done('email_user', 2, 3),
    ]);
    expect(audit.ok).toBe(true);
  });

  it('fails closed when progress-only hosted evidence cannot prove exactly-once cardinality', () => {
    const contract = buildCompoundWorkflowContract(decision([
      matched('web_search', 'Search the web exactly once.'),
      matched('email_user', 'Email the findings.', { delivery: true }),
    ]));
    const audit = evaluateCompoundWorkflowContract(contract, [
      {
        name: 'web_search', status: 'done', native: true,
        completionEvidence: 'provider-progress', callSeq: 1, resultSeq: 1,
        text: 'provider-hosted web search',
      },
      done('email_user', 2, 3),
    ]);
    expect(audit.ok).toBe(false);
    expect(audit.unverifiable).toEqual([expect.objectContaining({
      toolName: 'web_search',
      reason: expect.stringContaining('exact invocation count'),
    })]);
  });

  it('fails closed when sequence evidence or the contract itself is malformed', () => {
    const missingSequence = evaluateCompoundWorkflowContract(researchEmailContract(), [
      {
        name: 'deep_research_parallel', status: 'done', callObserved: true,
        text: 'Research complete.',
      },
      done('email_user', 3, 4),
    ]);
    expect(missingSequence.ok).toBe(false);
    expect(missingSequence.unverifiable).toEqual([expect.objectContaining({
      toolName: 'deep_research_parallel', reason: 'tool call sequence is missing',
    })]);

    const malformed = evaluateCompoundWorkflowContract({ version: 99, steps: [] }, []);
    expect(malformed).toMatchObject({
      ok: false,
      code: 'completion_contract_unverifiable',
      unverifiable: [expect.objectContaining({ reason: expect.stringContaining('version') })],
    });
  });
});

describe('compound contract failure reporting', () => {
  it('reports partial execution without suggesting an automatic retry or leaking result text', () => {
    const secret = 'PRIVATE_RESULT_BODY_SHOULD_NOT_APPEAR';
    const audit = evaluateCompoundWorkflowContract(researchEmailContract(), [
      done('deep_research_parallel', 1, 2, { text: secret }),
    ]);
    const message = formatCompoundContractFailure(audit);

    expect(message).toContain('Background workflow incomplete');
    expect(message).toContain('step 2 (email_user)');
    expect(message).toContain('Completed required steps: 1 of 2');
    expect(message).toContain('No missing or failed step was retried automatically');
    expect(message).toContain('Any external action that already completed was left in place');
    expect(message).not.toContain(secret);
    expect(formatCompoundContractFailure({ ok: true })).toBe('');
  });
});
