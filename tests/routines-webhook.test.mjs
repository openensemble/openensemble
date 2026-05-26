import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  saveRoutines, loadRoutines, findRoutineByWebhookToken,
  regenerateWebhookToken, resolveRoutineDeviceId,
} from '../lib/routines.mjs';

const USER_A = 'test_user_webhook_a';
const USER_B = 'test_user_webhook_b';

function cleanup() {
  for (const u of [USER_A, USER_B]) {
    try { fs.rmSync(path.join(USERS_DIR, u), { recursive: true, force: true }); } catch {}
  }
}

describe('webhook_token lifecycle', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('auto-generates a webhook_token on first save', () => {
    const saved = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    const token = saved.routines[0].webhook_token;
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  it('preserves webhook_token across re-saves of the same routine', () => {
    const first = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    const original = first.routines[0].webhook_token;

    const updated = saveRoutines(USER_A, [{
      ...first.routines[0],
      actions: [{ type: 'tts_say', text: 'Different text.' }],
    }]);
    expect(updated.routines[0].webhook_token).toBe(original);
  });

  it('generates a NEW token if the existing one is malformed', () => {
    const saved = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight', webhook_token: 'not-hex!',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    expect(saved.routines[0].webhook_token).toMatch(/^[a-f0-9]{32}$/);
    expect(saved.routines[0].webhook_token).not.toBe('not-hex!');
  });

  it('regenerateWebhookToken issues a fresh token and revokes the old one', () => {
    const first = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    const original = first.routines[0].webhook_token;
    const updated = regenerateWebhookToken(USER_A, 'goodnight');
    expect(updated.webhook_token).toMatch(/^[a-f0-9]{32}$/);
    expect(updated.webhook_token).not.toBe(original);
    expect(findRoutineByWebhookToken(original)).toBeNull();
    expect(findRoutineByWebhookToken(updated.webhook_token)?.routine.id).toBe('goodnight');
  });

  it('regenerateWebhookToken returns null for unknown routine id', () => {
    saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    expect(regenerateWebhookToken(USER_A, 'no_such_routine')).toBeNull();
  });
});

describe('findRoutineByWebhookToken', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('resolves a token to the owning user + routine', () => {
    saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    const token = loadRoutines(USER_A).routines[0].webhook_token;
    const hit = findRoutineByWebhookToken(token);
    expect(hit?.userId).toBe(USER_A);
    expect(hit?.routine.id).toBe('goodnight');
  });

  it('finds the right routine when two users have routines with different tokens', () => {
    saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    saveRoutines(USER_B, [{
      id: 'morning', trigger: 'morning',
      actions: [{ type: 'tts_say', text: 'Good morning.' }],
    }]);
    const tokenA = loadRoutines(USER_A).routines[0].webhook_token;
    const tokenB = loadRoutines(USER_B).routines[0].webhook_token;
    expect(findRoutineByWebhookToken(tokenA)?.userId).toBe(USER_A);
    expect(findRoutineByWebhookToken(tokenB)?.userId).toBe(USER_B);
  });

  it('returns null for non-existent token', () => {
    expect(findRoutineByWebhookToken('0123456789abcdef0123456789abcdef')).toBeNull();
  });

  it('rejects malformed tokens without scanning disk', () => {
    expect(findRoutineByWebhookToken('not hex')).toBeNull();
    expect(findRoutineByWebhookToken('')).toBeNull();
    expect(findRoutineByWebhookToken(null)).toBeNull();
    expect(findRoutineByWebhookToken('a')).toBeNull();  // too short
  });
});

describe('device_id field', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('persists a valid device_id across save', () => {
    const saved = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight', device_id: 'vdev_abcd1234',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    expect(saved.routines[0].device_id).toBe('vdev_abcd1234');
  });

  it('drops a malformed device_id (defends against injection / typos)', () => {
    const saved = saveRoutines(USER_A, [{
      id: 'goodnight', trigger: 'goodnight', device_id: '../../etc/passwd',
      actions: [{ type: 'tts_say', text: 'Sleep well.' }],
    }]);
    expect(saved.routines[0].device_id).toBeNull();
  });

  it('resolveRoutineDeviceId: routine.device_id wins over originating device', () => {
    const routine = { device_id: 'vdev_bound' };
    expect(resolveRoutineDeviceId(routine, 'vdev_originating')).toBe('vdev_bound');
  });

  it('resolveRoutineDeviceId: falls back to originating when routine has none', () => {
    const routine = { device_id: null };
    expect(resolveRoutineDeviceId(routine, 'vdev_originating')).toBe('vdev_originating');
  });

  it('resolveRoutineDeviceId: returns null when neither side has a device', () => {
    expect(resolveRoutineDeviceId({ device_id: null }, null)).toBeNull();
  });
});
