import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const authSource = fs.readFileSync(new URL('./auth.js', import.meta.url), 'utf8');

function loadExecutionUi() {
  const storage = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Map,
    JSON,
    Date,
    activeAgent: 'jarvis',
    allAvailableModels: () => [
      { provider: 'openai-oauth', name: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini' },
      { provider: 'openai-oauth', name: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
      { provider: 'fireworks', name: 'flux-1', displayName: 'Flux' },
      { provider: 'grok', name: 'grok-imagine-image', displayName: 'Grok Imagine' },
      { provider: 'grok', name: 'grok-4', displayName: 'Grok 4' },
    ],
    escHtml: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
      body: {},
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(authSource, sandbox, { filename: 'public/auth.js' });
  return sandbox;
}

describe('role and skill execution settings UI', () => {
  it('keeps inheritance distinct from an explicit Auto effort', () => {
    const ui = loadExecutionUi();

    expect(ui._normalizeSkillExecution(null)).toEqual({
      provider: null, model: null, reasoningEffort: null,
    });
    expect(ui._skillExecutionSummary(null)).toBe('Inherit agent');
    expect(ui._skillExecutionSummary({ reasoningEffort: 'auto' })).toBe('Agent model · Auto');

    const html = ui._skillExecutionEffortOptionsHtml('auto', [
      { value: 'auto', label: 'Auto' },
      { value: 'high', label: 'High' },
    ]);
    expect(html).toContain('<option value="">Inherit requesting agent</option>');
    expect(html).toContain('<option value="auto" selected>Auto</option>');
  });

  it('encodes provider and model as one lossless selection', () => {
    const ui = loadExecutionUi();
    const encoded = ui._skillExecutionModelValue('openai-oauth', 'model||with-delimiter');
    expect(ui._parseSkillExecutionModelValue(encoded)).toEqual({
      provider: 'openai-oauth', model: 'model||with-delimiter',
    });
    expect(ui._parseSkillExecutionModelValue('broken')).toEqual({ provider: null, model: null });
  });

  it('offers text models while excluding image-only providers and models', () => {
    const ui = loadExecutionUi();
    const html = ui._skillExecutionModelOptionsHtml({
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });

    expect(html).toContain('Inherit requesting agent');
    expect(html).toContain('GPT-5.6 Sol');
    expect(html).toContain('Grok 4');
    expect(html).not.toContain('Flux');
    expect(html).not.toContain('Grok Imagine');
  });

  it('keeps a saved unavailable model visible instead of silently inheriting', () => {
    const ui = loadExecutionUi();
    const html = ui._skillExecutionModelOptionsHtml({
      provider: 'openai-oauth', model: 'retired-coding-model', reasoningEffort: 'high',
    });

    expect(html).toContain('retired-coding-model (unavailable)');
    expect(html).toContain('selected');
  });

  it('renders execution controls for a routed skill with inherited-agent context', () => {
    const ui = loadExecutionUi();
    const html = ui._renderSkillExecutionControls({
      id: 'coder',
      assignment: 'jarvis',
      execution: { provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    }, [{ id: 'jarvis', provider: 'openai-oauth', model: 'gpt-5.4-mini' }]);

    expect(html).toContain('class="skill-execution-settings"');
    expect(html).toContain('data-change-action="saveSkillExecution"');
    expect(html).toContain('gpt-5.6-sol · High');
    expect(html).toContain('Local shortcuts and tool execution may not call a model.');
  });
});
