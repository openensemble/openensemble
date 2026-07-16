import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: vi.fn(),
  hiddenTools: vi.fn(),
  resolveHaAlias: vi.fn(),
  classifyCalendar: vi.fn(),
  classifyCalendarFollowup: vi.fn(),
  executeCalendar: vi.fn(),
  getProfileFilePath: vi.fn(),
  sttUpload: vi.fn(),
}));

vi.mock('../sessions.mjs', () => ({
  appendToSession: vi.fn(),
  failPendingTurn: vi.fn(),
}));

vi.mock('../lib/routines.mjs', () => ({
  classifyRoutineIntent: vi.fn(),
  executeRoutine: vi.fn(),
  resolveRoutineDeviceId: vi.fn(),
  runDeferredAmbient: vi.fn(),
}));

vi.mock('../lib/voice-reminder.mjs', () => ({ speakRoutineTts: vi.fn() }));

vi.mock('../roles.mjs', () => ({
  isSkillRuntimeEnabledForUser: mocks.runtimeEnabled,
}));

vi.mock('../lib/skill-overrides.mjs', () => ({
  getHiddenTools: mocks.hiddenTools,
}));

vi.mock('../lib/ha-aliases.mjs', () => ({ resolveAlias: mocks.resolveHaAlias }));

vi.mock('../lib/calendar-fastpath.mjs', () => ({
  classifyCalendarIntent: mocks.classifyCalendar,
  classifyCalendarFollowup: mocks.classifyCalendarFollowup,
  executeCalendarIntent: mocks.executeCalendar,
}));

vi.mock('../lib/profile-files.mjs', () => ({
  getProfileFilePath: mocks.getProfileFilePath,
}));

vi.mock('../skills/transcribe/execute.mjs', () => ({
  extractAudio: vi.fn(),
  sttUpload: mocks.sttUpload,
  MAX_BYTES: 1024,
}));

import {
  tryCalendarFastpath,
  tryHaFastpath,
  tryTranscribeAttachmentFastpath,
} from './fastpaths.mjs';

function baseCtx(overrides = {}) {
  return {
    userId: 'user_fastpath_auth',
    agentId: 'coordinator',
    userText: '',
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe('pre-LLM fastpath authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeEnabled.mockReturnValue(false);
    mocks.hiddenTools.mockReturnValue([]);
  });

  it('denies HA before alias/entity resolution when the skill is unavailable', async () => {
    const result = await tryHaFastpath(baseCtx({ userText: 'turn on kitchen lights' }));

    expect(result).toBeNull();
    expect(mocks.runtimeEnabled).toHaveBeenCalledWith('role_home_assistant', 'user_fastpath_auth');
    expect(mocks.resolveHaAlias).not.toHaveBeenCalled();
  });

  it('denies calendar before importing/classifying or reading the mirror', async () => {
    const result = await tryCalendarFastpath(baseCtx({ userText: "what's on my calendar today" }));

    expect(result).toBeNull();
    expect(mocks.runtimeEnabled).toHaveBeenCalledWith('gcal', 'user_fastpath_auth');
    expect(mocks.classifyCalendar).not.toHaveBeenCalled();
    expect(mocks.executeCalendar).not.toHaveBeenCalled();
  });

  it('denies transcription before resolving a file or invoking STT', async () => {
    const result = await tryTranscribeAttachmentFastpath(baseCtx({
      attachment: { file_id: 'audio-1', name: 'private.wav', mimeType: 'audio/wav' },
    }));

    expect(result).toBeNull();
    expect(mocks.runtimeEnabled).toHaveBeenCalledWith('transcribe', 'user_fastpath_auth');
    expect(mocks.getProfileFilePath).not.toHaveBeenCalled();
    expect(mocks.sttUpload).not.toHaveBeenCalled();
  });

  it('applies hidden-tool overrides to all three shortcuts before capability use', async () => {
    mocks.runtimeEnabled.mockReturnValue(true);
    mocks.hiddenTools.mockImplementation((_userId, skillId) => ({
      role_home_assistant: ['ha_call_service'],
      gcal: ['calendar_snapshot'],
      transcribe: ['transcribe_file'],
    })[skillId] ?? []);

    await tryHaFastpath(baseCtx({ userText: 'turn on kitchen lights' }));
    await tryCalendarFastpath(baseCtx({ userText: "what's on my calendar today" }));
    await tryTranscribeAttachmentFastpath(baseCtx({
      attachment: { file_id: 'audio-1', name: 'private.wav', mimeType: 'audio/wav' },
    }));

    expect(mocks.resolveHaAlias).not.toHaveBeenCalled();
    expect(mocks.classifyCalendar).not.toHaveBeenCalled();
    expect(mocks.getProfileFilePath).not.toHaveBeenCalled();
    expect(mocks.sttUpload).not.toHaveBeenCalled();
  });
});
