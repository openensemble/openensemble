/**
 * Core chat loop for OpenEnsemble — public facade.
 *
 *   chat/preview.mjs                — tool-result previews, drainToolResult
 *   chat/compress.mjs               — LoopGuard + context compression
 *   chat/provider-consumer.mjs      — consumeProvider, usage merge, tool-call identity
 *   chat/history.mjs                — buildLlmHistory, adaptLlmHistoryForProvider
 *   chat/persist.mjs                — session persist + desktop artifacts
 *   chat/tool-plan.mjs              — applyUserToolPlan, buildCurrentUserTurn
 *   chat/recovery.mjs               — missing-tool / in-progress recovery helpers
 *   chat/stream-chat.mjs            — streamChat generator
 *   chat/providers/*                — provider streams
 */

export { OPENAI_COMPAT_PROVIDERS } from './chat/providers/_shared.mjs';
export {
  consumeProvider,
  mergeProviderUsage,
  isProviderCallOrdinal,
} from './chat/provider-consumer.mjs';
export {
  buildLlmHistory,
  adaptLlmHistoryForProvider,
} from './chat/history.mjs';
export {
  persist,
  saveDesktopArtifact,
  buildDesktopFoldersBlock,
  documentArtifactContent,
  _modelContextWindow,
} from './chat/persist.mjs';
export {
  applyUserToolPlan,
  buildUserToolPlanSystemBlock,
  buildCurrentUserTurn,
} from './chat/tool-plan.mjs';
export {
  MISSING_TOOL_REPLY_RE,
  IN_PROGRESS_REPLY_RE,
  MISSING_TOOL_NOTICE,
  IN_PROGRESS_NOTICE,
  withRetryNote,
  RECOVERY_NOTE_EXCLUDED_TOOLS,
  AUTONOMOUS_TASK_CREATION_TOOLS,
} from './chat/recovery.mjs';
export { streamChat } from './chat/stream-chat.mjs';
