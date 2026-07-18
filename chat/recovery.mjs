/**
 * Chat recovery regexes/notices and small helpers for streamChat retries.
 */

export const MISSING_TOOL_REPLY_RE = /\b(?:i\s+(?:can(?:not|'t)|do\s+not|don't)\s+(?:have|see|access|use)|i\s+(?:can(?:not|'t))\s+(?:do|access|read|open|control|check)|no\s+(?:tool|access|browser|permission)|(?:not|isn't)\s+available\s+to\s+me|i\s+don'?t\s+have\s+access)\b/i;

export const IN_PROGRESS_REPLY_RE = /\b(?:already\s+(?:in\s+progress|under\s?way|working|running|on\s+it)|still\s+(?:working|running|in\s+progress|going)|(?:is|are|['’]s)\s+(?:currently\s+)?working\s+on\s+(?:it|that|this)|(?:i|we)(?:['’]ll|\s+will)\s+(?:let\s+you\s+know|update\s+you|report\s+back|ping\s+you|follow\s+up)\s+(?:when|once|as\s+soon\s+as)|(?:hasn['’]?t|haven['’]?t)\s+(?:finished|completed)\s+yet|not\s+(?:done|finished)\s+yet)\b/i;

export const MISSING_TOOL_NOTICE = 'Sorry, I misspoke — let me do that now.';
export const IN_PROGRESS_NOTICE = 'One moment — let me check the actual status.';

export function withRetryNote(userTurn, retryNote) {
  return Array.isArray(userTurn.content)
    ? {
        ...userTurn,
        content: userTurn.content.map((part, idx, arr) =>
          idx === arr.length - 1 && part?.type === 'text'
            ? { ...part, text: `${part.text || ''}${retryNote}` }
            : part
        ),
      }
    : { ...userTurn, content: `${String(userTurn.content || '')}${retryNote}` };
}

export const RECOVERY_NOTE_EXCLUDED_TOOLS = new Set(['request_tools', 'web_search', 'email_user']);
export const AUTONOMOUS_TASK_CREATION_TOOLS = new Set(['schedule_task', 'set_reminder', 'set_alarm']);
