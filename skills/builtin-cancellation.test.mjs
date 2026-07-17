import { describe, expect, it } from 'vitest';
import { executeSkillTool as executeCoderTool } from './coder/execute.mjs';
import { executeSkillTool as executeTranscribeTool } from './transcribe/execute.mjs';

function cancelledContext(message) {
  const controller = new AbortController();
  const reason = new Error(message);
  reason.name = 'AbortError';
  controller.abort(reason);
  return { ctx: { signal: controller.signal }, reason };
}

describe('built-in skill cooperative cancellation', () => {
  it('stops coder command admission before workspace or process work', async () => {
    const { ctx, reason } = cancelledContext('cancel coder');
    const events = executeCoderTool(
      'coder_run_command',
      { command: 'sleep 30' },
      'cancel-test-user',
      'cancel-test-agent',
      ctx,
    );

    await expect(events.next()).rejects.toBe(reason);
  });

  it('stops transcription before touching the requested file', async () => {
    const { ctx, reason } = cancelledContext('cancel transcription');

    await expect(executeTranscribeTool(
      'transcribe_file',
      { path: '/definitely/not/read.wav' },
      'cancel-test-user',
      'cancel-test-agent',
      ctx,
    )).rejects.toBe(reason);
  });
});
