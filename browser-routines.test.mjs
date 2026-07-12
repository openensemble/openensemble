import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { USERS_DIR } from './lib/paths.mjs';
import {
  BrowserRoutineReplayError,
  BrowserRoutineStoreError,
  canonicalBrowserRoutineOrigin,
  classifyBrowserRoutineRisk,
  deleteBrowserRoutine,
  draftBrowserRoutineFromTeachEvents,
  getBrowserRoutine,
  listBrowserRoutines,
  replayBrowserRoutine,
  saveBrowserRoutine,
  saveBrowserRoutineFromTeachEvents,
} from './lib/browser-routines.mjs';

const OWNER = `browser-routine-owner-${Date.now()}`;
const OTHER = `browser-routine-other-${Date.now()}`;

afterAll(() => {
  for (const userId of [OWNER, OTHER]) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

function safeRoutine(overrides = {}) {
  return {
    name: 'Search the parts catalog',
    description: 'Open the catalog and enter a model name.',
    origin: 'https://shop.example.test',
    steps: [
      { type: 'navigate', path: '/catalog' },
      { type: 'fill', target: { role: 'searchbox', name: 'Search products' }, value: 'electric mower' },
      { type: 'click', target: { role: 'button', name: 'Search' } },
      { type: 'wait_for', target: { role: 'listbox', label: 'Search results' }, state: 'visible' },
    ],
    ...overrides,
  };
}

describe('browser routine semantic contract', () => {
  it('accepts only one exact HTTP(S) origin', () => {
    expect(canonicalBrowserRoutineOrigin('https://Example.test:443/')).toBe('https://example.test');
    expect(() => canonicalBrowserRoutineOrigin('https://example.test/account')).toThrow(/must not contain a path/i);
    expect(() => canonicalBrowserRoutineOrigin('https://*.example.test')).toThrow(/exact host|valid URL/i);
    expect(() => canonicalBrowserRoutineOrigin('file:///tmp/page')).toThrow(/http or https/i);
    expect(() => canonicalBrowserRoutineOrigin('https://user:pass@example.test')).toThrow(/credentials/i);
    expect(() => canonicalBrowserRoutineOrigin('http://127.0.0.1')).toThrow(/private|local/i);
    expect(() => canonicalBrowserRoutineOrigin('https://intranet')).toThrow(/private|intranet/i);
  });

  it('normalizes origin-bound accessibility steps without selectors or coordinates', async () => {
    const routine = await saveBrowserRoutine(OWNER, safeRoutine(), {
      now: Date.parse('2026-07-12T12:00:00Z'),
      idFactory: () => '00000000-0000-4000-8000-000000000001',
    });
    expect(routine.id).toBe('brt_00000000-0000-4000-8000-000000000001');
    expect(routine.steps.every(step => step.origin === 'https://shop.example.test')).toBe(true);
    expect(routine.steps[1].target).toEqual({
      role: 'searchbox', name: 'Search products', label: null, ordinal: 1, exact: true,
    });
    expect(routine.risk).toEqual({ level: 'medium', reasons: ['form_input', 'interactive_click'] });

    await expect(saveBrowserRoutine(OWNER, safeRoutine({
      name: 'Coordinate click',
      steps: [{ type: 'click', x: 10, y: 20, target: { role: 'button', name: 'Go' } }],
    }))).rejects.toThrow(/coordinates/i);
    await expect(saveBrowserRoutine(OWNER, safeRoutine({
      name: 'Selector click',
      steps: [{ type: 'click', target: { role: 'button', name: 'Go', selector: '#go' } }],
    }))).rejects.toThrow(/selectors/i);
    await expect(saveBrowserRoutine(OWNER, safeRoutine({
      name: 'Script step',
      steps: [{ type: 'click', target: { role: 'button', name: 'Go' }, script: 'window.doThing()' }],
    }))).rejects.toThrow(/scripts|code/i);
    await expect(saveBrowserRoutine(OWNER, safeRoutine({
      name: 'Cross origin',
      steps: [{ type: 'navigate', path: '//evil.example.test/' }],
    }))).rejects.toThrow(/same-origin/i);
  });

  it('rejects password, payment, OTP, token, and secret-bearing fields or values', async () => {
    const badTargets = ['Password', 'One-time verification code', 'Credit card number', 'CVV', 'Social Security number', 'Bank routing number', 'Medical record ID', 'API key'];
    for (const label of badTargets) {
      await expect(saveBrowserRoutine(OWNER, safeRoutine({
        name: `Unsafe ${label}`,
        steps: [{ type: 'fill', target: { role: 'textbox', label }, value: 'example' }],
      }))).rejects.toThrow(/password, payment, OTP, token, or secret/i);
    }

    const badValues = [
      'password=hunter2',
      'sk-exampleexampleexample1234',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart',
      '4111 1111 1111 1111',
      '0123456789abcdef0123456789abcdef',
      '123456',
      '123456789',
    ];
    for (const value of badValues) {
      await expect(saveBrowserRoutine(OWNER, safeRoutine({
        name: 'Unsafe literal',
        steps: [{ type: 'fill', target: { role: 'textbox', label: 'Notes' }, value }],
      }))).rejects.toThrow(/secrets|payment data|passwords/i);
    }

    await expect(saveBrowserRoutine(OWNER, safeRoutine({
      name: 'Templated code',
      steps: [{ type: 'fill', target: { role: 'textbox', label: 'Notes' }, value: '${window.secret}' }],
    }))).rejects.toThrow(/templates|executable/i);
  });

  it('classifies consequential semantic actions deterministically', () => {
    expect(classifyBrowserRoutineRisk([
      { type: 'navigate' }, { type: 'wait_for' },
    ])).toEqual({ level: 'low', reasons: [] });
    expect(classifyBrowserRoutineRisk([
      { type: 'fill' }, { type: 'click', target: { name: 'Search' } },
    ])).toEqual({ level: 'medium', reasons: ['form_input', 'interactive_click'] });
    expect(classifyBrowserRoutineRisk([
      { type: 'click', target: { role: 'button', name: 'Place order' } },
      { type: 'click', target: { role: 'button', name: 'Submit' } },
    ])).toEqual({
      level: 'high',
      reasons: ['data_submission', 'financial_action', 'interactive_click'],
    });
    expect(classifyBrowserRoutineRisk([
      { type: 'select', target: { role: 'combobox', label: 'Account action' }, option: 'Delete account' },
    ])).toEqual({ level: 'high', reasons: ['destructive_action', 'form_choice'] });
  });
});

describe('Teach Mode to semantic routine conversion', () => {
  it('collapses input snapshots and never persists selectors, coordinates, or submit events', async () => {
    const events = [
      {
        kind: 'click', tabUrl: 'https://shop.example.test/catalog',
        element: { tag: 'input', type: 'search', role: 'searchbox', ariaLabel: 'Search products', selector: '#search' },
      },
      {
        kind: 'input', value: 'electric', tabUrl: 'https://shop.example.test/catalog',
        element: { tag: 'input', type: 'search', role: 'searchbox', ariaLabel: 'Search products', selector: '#search' },
      },
      {
        kind: 'input', value: 'electric mower', tabUrl: 'https://shop.example.test/catalog',
        element: { tag: 'input', type: 'search', role: 'searchbox', ariaLabel: 'Search products', selector: '#search' },
      },
      {
        kind: 'click', tabUrl: 'https://shop.example.test/catalog',
        element: { tag: 'button', type: 'submit', accessibleName: 'Search', text: 'Search', selector: '#go' },
      },
      {
        kind: 'submit', tabUrl: 'https://shop.example.test/catalog',
        element: { tag: 'form', selector: '#search-form' },
      },
    ];
    const draft = draftBrowserRoutineFromTeachEvents({ name: 'Find a mower', events });
    expect(draft.input.steps).toEqual([
      { type: 'navigate', origin: 'https://shop.example.test', path: '/catalog' },
      {
        type: 'fill', origin: 'https://shop.example.test', value: 'electric mower',
        target: { role: 'searchbox', name: 'Search products', label: null, ordinal: 1, exact: true },
      },
      {
        type: 'click', origin: 'https://shop.example.test',
        target: { role: 'button', name: 'Search', label: null, ordinal: 1, exact: true },
      },
    ]);
    expect(JSON.stringify(draft)).not.toMatch(/selector|#search/);
    expect(draft.warnings.join(' ')).toMatch(/submission/i);

    const saved = await saveBrowserRoutineFromTeachEvents(OWNER, { name: 'Find a mower', events });
    expect(saved.routine.risk).toEqual({ level: 'medium', reasons: ['form_input', 'interactive_click'] });
  });

  it('omits redacted fields and refuses mixed-origin or non-replayable demonstrations', () => {
    expect(() => draftBrowserRoutineFromTeachEvents({
      name: 'Unsafe',
      events: [
        {
          kind: 'input', value: null, tabUrl: 'https://shop.example.test/account',
          element: { tag: 'input', type: 'password', sensitive: true, label: 'Password' },
        },
      ],
    })).toThrow(/replayable|non-sensitive/i);

    expect(() => draftBrowserRoutineFromTeachEvents({
      name: 'Cross site',
      events: [
        { kind: 'click', tabUrl: 'https://shop.example.test/', element: { tag: 'button', text: 'Start' } },
        { kind: 'click', tabUrl: 'https://other.example.test/', element: { tag: 'button', text: 'Finish' } },
      ],
    })).toThrow(/crossed origins/i);
  });
});

describe('safe browser routine replay contract', () => {
  it('requires one exact leased tab on the stored origin and sends owned steps in order', async () => {
    const routine = await saveBrowserRoutine(OWNER, safeRoutine({ name: 'Replay me' }));
    const calls = [];
    const command = async (action, args) => {
      calls.push({ action, args });
      if (action === 'list_tabs') return [{ tabId: 77, url: 'https://shop.example.test/catalog' }];
      return { ok: true, summary: args.step.type };
    };
    const result = await replayBrowserRoutine(OWNER, routine.id, { tabId: 77, command });
    expect(result.completedSteps).toBe(routine.steps.length);
    expect(calls.map(call => call.action)).toEqual(['list_tabs', ...routine.steps.map(() => 'run_routine_step')]);
    expect(calls[1].args).toMatchObject({
      tabId: 77, routineId: routine.id, stepIndex: 0, origin: 'https://shop.example.test',
      step: routine.steps[0],
    });

    await expect(replayBrowserRoutine(OWNER, routine.id, {
      tabId: 88,
      command: async action => action === 'list_tabs'
        ? [{ tabId: 88, url: 'https://other.example.test/' }]
        : null,
    })).rejects.toMatchObject({ code: 'BROWSER_ROUTINE_ORIGIN_MISMATCH' });
  });

  it('stops at the first refused step and never sends later actions', async () => {
    const routine = await saveBrowserRoutine(OWNER, safeRoutine({ name: 'Stop safely' }));
    let stepCalls = 0;
    await expect(replayBrowserRoutine(OWNER, routine.id, {
      tabId: 90,
      command: async action => {
        if (action === 'list_tabs') return [{ tabId: 90, url: 'https://shop.example.test/' }];
        stepCalls += 1;
        if (stepCalls === 2) throw new Error('user declined confirmation');
        return { ok: true };
      },
    })).rejects.toMatchObject({
      code: 'BROWSER_ROUTINE_STEP_FAILED',
      stepIndex: 1,
      completedSteps: 1,
    });
    expect(stepCalls).toBe(2);

    await expect(replayBrowserRoutine(OWNER, 'brt_not_owned', {
      tabId: 90,
      command: async () => [],
    })).rejects.toBeInstanceOf(BrowserRoutineReplayError);
  });
});

describe('owned browser routine persistence', () => {
  it('saves, lists, gets, updates, and deletes only inside the current user store', async () => {
    const created = await saveBrowserRoutine(OTHER, safeRoutine({ name: 'Other user routine' }), {
      now: Date.parse('2026-07-12T13:00:00Z'),
      idFactory: () => '00000000-0000-4000-8000-000000000002',
    });
    expect(listBrowserRoutines(OTHER).map(item => item.id)).toContain(created.id);
    expect(getBrowserRoutine(OWNER, created.id)).toBeNull();
    expect(await deleteBrowserRoutine(OWNER, created.id)).toBe(false);
    expect(getBrowserRoutine(OTHER, created.id)?.name).toBe('Other user routine');

    const updated = await saveBrowserRoutine(OTHER, safeRoutine({
      id: created.id,
      name: 'Updated owned routine',
    }), { now: Date.parse('2026-07-12T14:00:00Z') });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(listBrowserRoutines(OTHER).filter(item => item.id === created.id)).toHaveLength(1);
    expect(await deleteBrowserRoutine(OTHER, created.id)).toBe(true);
    expect(getBrowserRoutine(OTHER, created.id)).toBeNull();
  });

  it('writes atomically with private mode and fails closed without overwriting malformed data', async () => {
    const userId = `browser-routine-corrupt-${Date.now()}`;
    const dir = path.join(USERS_DIR, userId);
    const file = path.join(dir, 'browser-routines.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{ definitely not json', { mode: 0o600 });
    try {
      expect(() => listBrowserRoutines(userId)).toThrow(BrowserRoutineStoreError);
      await expect(saveBrowserRoutine(userId, safeRoutine())).rejects.toMatchObject({
        code: 'BROWSER_ROUTINE_STORE_CORRUPT',
      });
      expect(fs.readFileSync(file, 'utf8')).toBe('{ definitely not json');

      fs.rmSync(file);
      await saveBrowserRoutine(userId, safeRoutine());
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      const malformed = JSON.parse(fs.readFileSync(file, 'utf8'));
      malformed.routines[0].steps[0].origin = 'https://other.example.test';
      fs.writeFileSync(file, JSON.stringify(malformed));
      expect(() => getBrowserRoutine(userId, malformed.routines[0].id)).toThrow(/malformed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
