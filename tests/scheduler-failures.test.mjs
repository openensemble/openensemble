/**
 * Tests for the cross-fire failure handling shipped 2026-05-10:
 *   1. runAgentWithRetry classifies LoopGuard "Stopped: …" content as failure.
 *   2. runAgentWithRetry retries on error events and surfaces lastError.
 *   3. runAgentWithRetry passes through successful content.
 *   4. Scheduler increments consecutiveFailures + auto-disables at the cap.
 *   5. Successful fire clears the failure streak.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runAgentWithRetry } from '../lib/run-agent-with-retry.mjs';
import { USERS_DIR } from '../lib/paths.mjs';

const USER = 'user_schedfail_test';

// Fake agent shape — runAgentWithRetry passes the whole record through to
// streamChat without inspecting it. We feed a plain object.
const FAKE_AGENT = { id: `${USER}_fake-agent`, name: 'fake' };

afterAll(() => {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runAgentWithRetry — failure classification', () => {
  it('flags LoopGuard "Stopped: …" content as failure even without an error event', async () => {
    // Mirrors what chat/compress.mjs LoopGuard emits when the same tool call
    // is repeated 4× — a plain token with the "Stopped: <reason>." string and
    // no error event. Pre-fix, this looked like a successful empty reply.
    async function* fakeStream() {
      yield { type: 'token', text: 'Stopped: same tool call repeated 4 times.' };
      yield { type: '__content', content: 'Stopped: same tool call repeated 4 times.' };
      yield { type: 'done' };
    }
    const { succeeded, lastError } = await runAgentWithRetry({
      scopedAgent: FAKE_AGENT, userText: 'go', systemNote: '[TEST]',
      userId: USER, streamChat: fakeStream,
      maxAttempts: 1, retryDelayMs: 0,
    });
    expect(succeeded).toBe(false);
    expect(lastError).toMatch(/Stopped: same tool call repeated 4 times/);
  });

  it('retries on error events and reports the underlying message', async () => {
    let attempts = 0;
    async function* fakeStream() {
      attempts++;
      yield { type: 'error', message: `boom #${attempts}` };
    }
    const { succeeded, lastError } = await runAgentWithRetry({
      scopedAgent: FAKE_AGENT, userText: 'go', systemNote: '[TEST]',
      userId: USER, streamChat: fakeStream,
      maxAttempts: 2, retryDelayMs: 0,
    });
    expect(succeeded).toBe(false);
    expect(attempts).toBe(2);
    expect(lastError).toMatch(/boom #2/);
  });

  it('returns succeeded=true with assistantContent when the stream completes cleanly', async () => {
    async function* fakeStream() {
      yield { type: 'token', text: 'all good' };
      yield { type: '__content', content: 'all good' };
      yield { type: 'done' };
    }
    const { succeeded, assistantContent, lastError } = await runAgentWithRetry({
      scopedAgent: FAKE_AGENT, userText: 'go', systemNote: '[TEST]',
      userId: USER, streamChat: fakeStream,
      maxAttempts: 1, retryDelayMs: 0,
    });
    expect(succeeded).toBe(true);
    expect(assistantContent).toBe('all good');
    expect(lastError).toBe(null);
  });

  it('does not misclassify a long answer that happens to start with "Stopped:" as a stall', async () => {
    // Real agent output that legitimately starts with "Stopped:" (e.g. a
    // status report) shouldn't be flagged. The detector requires <200 chars.
    const long = 'Stopped: ' + 'x'.repeat(300);
    async function* fakeStream() {
      yield { type: '__content', content: long };
      yield { type: 'done' };
    }
    const { succeeded, lastError } = await runAgentWithRetry({
      scopedAgent: FAKE_AGENT, userText: 'go', systemNote: '[TEST]',
      userId: USER, streamChat: fakeStream,
      maxAttempts: 1, retryDelayMs: 0,
    });
    expect(succeeded).toBe(true);
    expect(lastError).toBe(null);
  });
});

describe('scheduler — consecutiveFailures cross-fire counter', () => {
  // Mirror the patch-building branch from scheduler.mjs runTask. Keeping this
  // pure (no agent run) so the test stays fast and free of provider deps. If
  // the production logic drifts from this, that's the bug — ports here.
  const MAX_CONSECUTIVE_FAILURES = 5;
  function buildPatch(task, { succeeded, lastError, assistantContent }) {
    const patch = { lastRun: new Date().toISOString() };
    const prevStreak = Number(task.consecutiveFailures) || 0;
    if (!succeeded) {
      patch.lastError = lastError || 'unknown';
      patch.consecutiveFailures = prevStreak + 1;
      if (patch.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        patch.enabled = false;
        patch.disabledReason = `auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failed fires; last error: ${lastError || 'unknown'}`;
      }
    } else {
      patch.lastError = null;
      if (prevStreak) patch.consecutiveFailures = 0;
      patch.lastOutput = (assistantContent || '').trim().slice(0, 280);
    }
    return patch;
  }

  it('increments the streak on a failed fire below the cap', () => {
    const task = { id: 't1', enabled: true, consecutiveFailures: 2 };
    const patch = buildPatch(task, { succeeded: false, lastError: 'still broken' });
    expect(patch.consecutiveFailures).toBe(3);
    expect(patch.enabled).toBeUndefined();
    expect(patch.disabledReason).toBeUndefined();
  });

  it('auto-disables on the Nth consecutive failure', () => {
    const task = { id: 't2', enabled: true, consecutiveFailures: 4 };
    const patch = buildPatch(task, { succeeded: false, lastError: 'API key expired' });
    expect(patch.consecutiveFailures).toBe(5);
    expect(patch.enabled).toBe(false);
    expect(patch.disabledReason).toMatch(/auto-disabled after 5 consecutive failed fires/);
    expect(patch.disabledReason).toMatch(/API key expired/);
  });

  it('clears the streak on a successful fire after prior failures', () => {
    const task = { id: 't3', enabled: true, consecutiveFailures: 3 };
    const patch = buildPatch(task, { succeeded: true, assistantContent: 'done' });
    expect(patch.consecutiveFailures).toBe(0);
    expect(patch.lastError).toBe(null);
    expect(patch.lastOutput).toBe('done');
  });

  it('does not write a consecutiveFailures patch on success when there was no prior streak', () => {
    // Avoids unnecessary writes on the happy path.
    const task = { id: 't4', enabled: true };
    const patch = buildPatch(task, { succeeded: true, assistantContent: 'fine' });
    expect(patch.consecutiveFailures).toBeUndefined();
  });
});

describe('routes/misc — re-enabling an auto-disabled task resets the streak', () => {
  // Mirrors the if-block from routes/misc.mjs PATCH handler. Same fidelity-
  // ports approach as above — tests the policy, not the route plumbing.
  function applyEnableReset(existing, patch) {
    const out = { ...patch };
    if (out.enabled === true && (existing.consecutiveFailures || existing.disabledReason)) {
      out.consecutiveFailures = 0;
      out.disabledReason = null;
    }
    return out;
  }

  it('clears consecutiveFailures and disabledReason when user toggles enabled back on', () => {
    const existing = {
      id: 't5', enabled: false, consecutiveFailures: 5,
      disabledReason: 'auto-disabled after 5 consecutive failed fires; last error: ENOTFOUND',
    };
    const out = applyEnableReset(existing, { enabled: true });
    expect(out.consecutiveFailures).toBe(0);
    expect(out.disabledReason).toBe(null);
  });

  it('does not touch streak when enable patch lands on a healthy task', () => {
    const existing = { id: 't6', enabled: false }; // user just paused it manually
    const out = applyEnableReset(existing, { enabled: true });
    expect(out).toEqual({ enabled: true });
  });

  it('does not touch streak when patch is unrelated to enable', () => {
    const existing = { id: 't7', enabled: false, consecutiveFailures: 5 };
    const out = applyEnableReset(existing, { label: 'new label' });
    expect(out.consecutiveFailures).toBeUndefined();
    expect(out.disabledReason).toBeUndefined();
  });
});
