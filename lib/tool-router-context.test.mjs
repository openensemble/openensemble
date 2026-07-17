import { describe, expect, it } from 'vitest';

import {
  bindToolRouterContext,
  getToolRouterContext,
  toolRouterContext,
} from './tool-router-context.mjs';
import executeCoordinatorTool from '../skills/coordinator/execute.mjs';

describe('bindToolRouterContext', () => {
  it('restores the same store on every async-generator resume', async () => {
    const store = { marker: 'router-turn' };
    async function* probe() {
      yield getToolRouterContext()?.marker ?? null;
      await Promise.resolve();
      yield getToolRouterContext()?.marker ?? null;
      return getToolRouterContext()?.marker ?? null;
    }

    const iterator = bindToolRouterContext(probe(), store);
    const resumeWithoutStore = () => toolRouterContext.run(null, () => iterator.next());

    expect(getToolRouterContext()).toBeNull();
    expect(await resumeWithoutStore()).toEqual({ done: false, value: 'router-turn' });
    expect(getToolRouterContext()).toBeNull();
    expect(await resumeWithoutStore()).toEqual({ done: false, value: 'router-turn' });
    expect(await resumeWithoutStore()).toEqual({ done: true, value: 'router-turn' });
    expect(getToolRouterContext()).toBeNull();
  });

  it('keeps request_tools out of the false full-toolset fallback after a yield', async () => {
    const store = {
      agent: { tools: [] },
      fullTools: [],
      initiallyIncludedSkills: new Set(),
      addedSkills: new Set(),
      recoveryLoads: [],
    };
    async function* providerLikeLoop() {
      yield { type: 'token', text: 'model round one' };
      yield* executeCoordinatorTool(
        'request_tools',
        { groups: ['not-a-real-skill'] },
        'router-context-user',
        'router-context-agent',
      );
    }

    const iterator = bindToolRouterContext(providerLikeLoop(), store);
    const first = await toolRouterContext.run(null, () => iterator.next());
    const second = await toolRouterContext.run(null, () => iterator.next());

    expect(first.value?.text).toBe('model round one');
    expect(second.value?.text).toMatch(/^No additional tools matched/);
    expect(second.value?.text).not.toContain('full toolset is already available');
    expect(store.recoveryLoads).toHaveLength(1);
  });
});
