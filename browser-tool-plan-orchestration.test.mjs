import { describe, expect, it } from 'vitest';
import fs from 'fs';

const chatSource = fs.readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');
const websocketSource = fs.readFileSync(new URL('./public/websocket.js', import.meta.url), 'utf8');

const catalogStart = chatSource.indexOf('const TOOL_PLAN_CATALOG = [');
const stateStart = chatSource.indexOf('\nlet toolPlanState =', catalogStart);
if (catalogStart < 0 || stateStart < 0) throw new Error('Unable to locate tool-plan catalog/policy helpers');

const catalogAndPolicySource = chatSource.slice(catalogStart, stateStart);
const buildCatalog = new Function('_currentUser', `${catalogAndPolicySource}\nreturn {\n  names: availableToolPlanCatalog().map(tool => tool.name),\n  filtered: names => availableToolPlanNames(names),\n};`);

const sendStart = chatSource.indexOf('function selectedToolPlanForSend(text) {');
const sendEnd = chatSource.indexOf('\nfunction resetToolPlanPicker()', sendStart);
if (sendStart < 0 || sendEnd < 0) throw new Error('Unable to locate final tool-plan send helper');
const selectedToolPlanForSendSource = chatSource.slice(sendStart, sendEnd);
const buildFinalSender = new Function('_currentUser', 'selectedValues', [
  catalogAndPolicySource,
  `let toolPlanState = { mode: 'selected', selected: new Set(selectedValues), recipe: null, remember: false };`,
  'const rememberToolRecipe = () => {};',
  selectedToolPlanForSendSource,
  'return selectedToolPlanForSend;',
].join('\n'));

describe('browser tool-plan orchestration visibility', () => {
  it('hides ask_agent only for stored single mode and preserves worker controls', () => {
    const single = buildCatalog({ orchestration: { mode: 'single', primaryAgentId: 'primary' } });
    expect(single.names).not.toContain('ask_agent');
    expect(single.names).toContain('request_tools');
    expect(single.filtered(['ask_agent', 'request_tools', 'spawn_worker']))
      .toEqual(['request_tools', 'spawn_worker']);
    expect(single.filtered(new Set(['ask_agent', 'request_tools', 'spawn_worker'])))
      .toEqual(['request_tools', 'spawn_worker']);

    // Deliberately no roster input: one-agent ensemble behavior is driven by
    // the setting alone and restores named delegation.
    const ensemble = buildCatalog({ orchestration: { mode: 'ensemble', primaryAgentId: 'primary' } });
    expect(ensemble.names).toContain('ask_agent');
    expect(ensemble.filtered(['ask_agent', 'request_tools']))
      .toEqual(['ask_agent', 'request_tools']);
    expect(ensemble.filtered(new Set(['ask_agent', 'request_tools'])))
      .toEqual(['ask_agent', 'request_tools']);
  });

  it('filters Set-backed picker state on the final send path', () => {
    const selected = ['ask_agent', 'request_tools'];
    const singleSend = buildFinalSender(
      { orchestration: { mode: 'single', primaryAgentId: 'primary' } },
      selected,
    );
    expect(singleSend('finish this task')).toMatchObject({
      mode: 'selected',
      selectedTools: ['request_tools'],
    });

    const ensembleSend = buildFinalSender(
      { orchestration: { mode: 'ensemble', primaryAgentId: 'primary' } },
      selected,
    );
    expect(ensembleSend('delegate this task')).toMatchObject({
      mode: 'selected',
      selectedTools: ['ask_agent', 'request_tools'],
    });
  });

  it('applies the policy filter to every picker ingress and the final send payload', () => {
    expect(chatSource).toContain('for (const item of availableToolPlanCatalog())');
    expect(chatSource).toContain('for (const name of availableToolPlanNames(recipe.selectedTools))');
    expect(chatSource).toContain("!toolPlanToolAvailable(raw)");
    expect(chatSource).toContain('const selectedTools = availableToolPlanNames(toolPlanState.selected);');
  });

  it('refreshes browser policy from the authoritative agent-list broadcast before rendering the picker', () => {
    const policyUpdate = websocketSource.indexOf('_currentUser.orchestration = msg.orchestration;');
    const pickerRender = websocketSource.indexOf("if (typeof renderToolPlanPicker === 'function') renderToolPlanPicker();", policyUpdate);
    expect(policyUpdate).toBeGreaterThan(-1);
    expect(pickerRender).toBeGreaterThan(policyUpdate);
  });
});
