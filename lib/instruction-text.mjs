// Shared instruction extraction.
//
// Routing (per-turn tool selection) and recipe match/learn must key on WHAT a
// turn asks the agent to DO, not on a pasted payload that rides along with it —
// a 10 KB briefing to email, a long document to summarize, an inline list to
// process. Embedding/token-matching the whole blob drowns the actual intent
// (that is what dropped an email specialist's compose tool on big-payload
// sends, and what lets a stale "sort inbox" recipe match a "send" task).
//
//   directiveText   — strips known body markers (Subject:/Body:/---/…) and caps.
//   instructionText — tighter: keep only the leading directive (cut at the first
//                     blank line or markdown block) so the embed/token vector is
//                     the instruction alone. Falls back to the directive slice
//                     when the message is a single block.

export function directiveText(userText) {
  return String(userText || '')
    .split(/\n\s*(?:Subject:|Body:|Content:|Plain[- ]text body:|HTML body:|---|<background_task\b)/i)[0]
    .slice(0, 1200);
}

export function instructionText(userText) {
  const directive = directiveText(userText);
  const head = directive.split(/\n\s*\n|\n(?=\s*(?:[#>*+`\-]|\d+[.)]))/)[0].trim();
  return ((head.length >= 8 ? head : directive).slice(0, 320)) || directive;
}
