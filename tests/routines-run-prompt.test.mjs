import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  saveRoutines, loadRoutines, classifyRoutineIntent, executeRoutine,
} from '../lib/routines.mjs';

const TEST_USER = 'test_user_routine_prompt';

function cleanup() {
  try { fs.rmSync(path.join(USERS_DIR, TEST_USER), { recursive: true, force: true }); } catch {}
}

describe('run_prompt action validation', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('saveRoutines accepts a run_prompt action', () => {
    const next = saveRoutines(TEST_USER, [{
      id: 'news', trigger: 'news',
      actions: [{ type: 'run_prompt', prompt: 'give me the latest news' }],
    }]);
    expect(next.routines).toHaveLength(1);
    expect(next.routines[0].actions[0].type).toBe('run_prompt');
    expect(next.routines[0].actions[0].prompt).toBe('give me the latest news');
  });

  it('drops a run_prompt with empty prompt', () => {
    const next = saveRoutines(TEST_USER, [{
      id: 'bad', trigger: 'bad',
      actions: [{ type: 'run_prompt', prompt: '   ' }],
    }]);
    // Routine has no remaining valid actions → dropped entirely.
    expect(next.routines).toHaveLength(0);
  });

  it('trims and length-caps the prompt', () => {
    const long = 'x'.repeat(2000);
    const next = saveRoutines(TEST_USER, [{
      id: 'long', trigger: 'long',
      actions: [{ type: 'run_prompt', prompt: '  ' + long + '  ' }],
    }]);
    expect(next.routines[0].actions[0].prompt.length).toBe(1024);
  });

  it('drops unknown fields on the run_prompt action', () => {
    const next = saveRoutines(TEST_USER, [{
      id: 'extra', trigger: 'extra',
      actions: [{ type: 'run_prompt', prompt: 'hi', secret: 'do not store' }],
    }]);
    expect(next.routines[0].actions[0]).not.toHaveProperty('secret');
  });
});

describe('executeRoutine surfaces followupPrompt', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns followupPrompt from a run_prompt-only routine', async () => {
    const result = await executeRoutine({
      id: 'news', trigger: 'news', aliases: [],
      actions: [{ type: 'run_prompt', prompt: 'give me the latest news' }],
    }, { userId: TEST_USER, deviceId: 'fake_device' });
    expect(result.followupPrompt).toBe('give me the latest news');
    expect(result.text).toBe('');
    expect(result.errors).toHaveLength(0);
  });

  it('combines tts_say with followupPrompt — text speaks first, prompt runs after', async () => {
    const result = await executeRoutine({
      id: 'morning', trigger: 'morning briefing', aliases: [],
      actions: [
        { type: 'tts_say', text: 'Good morning.' },
        { type: 'run_prompt', prompt: 'what is on my calendar today?' },
      ],
    }, { userId: TEST_USER, deviceId: 'fake_device' });
    expect(result.text).toBe('Good morning.');
    expect(result.followupPrompt).toBe('what is on my calendar today?');
  });

  it('last run_prompt wins when multiple are present', async () => {
    const result = await executeRoutine({
      id: 'double', trigger: 'double', aliases: [],
      actions: [
        { type: 'run_prompt', prompt: 'first prompt' },
        { type: 'run_prompt', prompt: 'second prompt' },
      ],
    }, { userId: TEST_USER, deviceId: 'fake_device' });
    expect(result.followupPrompt).toBe('second prompt');
  });
});

describe('routine matcher unchanged by the new action type', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('matches the trigger phrase regardless of action types', () => {
    saveRoutines(TEST_USER, [{
      id: 'news', trigger: 'news', aliases: ['latest news'],
      actions: [{ type: 'run_prompt', prompt: 'give me the latest news' }],
    }]);
    expect(classifyRoutineIntent('news', TEST_USER)?.id).toBe('news');
    expect(classifyRoutineIntent('latest news', TEST_USER)?.id).toBe('news');
    expect(classifyRoutineIntent('hey ensemble, news', TEST_USER)?.id).toBe('news');
    expect(classifyRoutineIntent('something else entirely', TEST_USER)).toBeNull();
  });
});
