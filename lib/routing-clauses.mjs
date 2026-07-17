// Conservative instruction-clause splitter shared by pre-LLM routing layers.
// It recognizes explicit sequencing and sentence boundaries, not ordinary
// noun conjunctions, so "current weather and forecast" stays one operation
// while "check the weather, then email it" is treated as a workflow.

import { directiveText, instructionText } from './instruction-text.mjs';

const CLAUSE_BOUNDARY_RE = /(?:[!?;\n]+|\.+(?=\s|$)|,\s*(?=(?:then|also)\b)|\b(?:and\s+then|then|after\s+that|before\s+that)\b|\b(?:and|also)\s+(?=(?:add|attach|book|buy|call|cancel|check|compose|create|delete|download|draft|email|fetch|find|forward|generate|get|list|look|make|open|order|play|post|read|remove|reply|research|save|schedule|search|send|set|show|summari[sz]e|text|turn|update|upload|write)\b))/i;
const INSTRUCTION_CLAUSE_START_RE = /^(?:please\s+)?(?:add|attach|book|buy|call|cancel|check|compose|create|delete|download|draft|email|fetch|find|forward|generate|get|list|look|make|open|order|play|post|read|remove|reply|research|save|schedule|search|send|set|show|summari[sz]e|text|turn|update|upload|write|what(?:'s|\s+is)?|how|when|where|which|who|is|are|am|do|does|did|can|could|will|would|should)\b/i;
const INLINE_PAYLOAD_DIRECTIVE_RE = /^(?:(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?|i\s+need\s+you\s+to\s+)(?:analy[sz]e|classify|compose|create|critique|draft|edit|email|extract|prepare|proofread|read|review|rewrite|send|summari[sz]e|translate|write)\b[^\n]{0,160}\b(?:this\b|(?:the\s+)?(?:following|pasted)\b|\bbelow\b)/i;

function inlinePayloadInstruction(text) {
  const directive = directiveText(text);
  if (!directive) return null;
  // A qualifying colon is an explicit body boundary even when the body starts
  // on the same line: "Summarize this report: Check the weather...".
  for (let colon = directive.indexOf(':'); colon >= 0 && colon <= 240; colon = directive.indexOf(':', colon + 1)) {
    const head = directive.slice(0, colon).trim();
    const suffix = directive.slice(colon + 1);
    // A body delimiter is followed by whitespace/end. Colons inside 3:00,
    // https://, or :8443 therefore cannot truncate a legitimate workflow.
    if (colon + 1 < directive.length && !/\s/.test(directive[colon + 1])) continue;
    // An explicit sequence tail is an instruction, even when the writer used
    // a colon before it rather than a comma.
    if (/^\s*(?:and\s+then|then|also)\b/i.test(suffix)) continue;
    if (INLINE_PAYLOAD_DIRECTIVE_RE.test(head)) return `${head}:`;
  }
  // Without a colon, only a blank-line boundary can introduce inline data.
  // "attached report" intentionally does not match: the attachment is not the
  // later text, so following blank-line actions remain genuine workflow steps.
  const blank = directive.search(/\n\s*\n/);
  if (blank >= 0) {
    const head = directive.slice(0, blank).trim();
    if (INLINE_PAYLOAD_DIRECTIVE_RE.test(head)) return head;
  }
  return null;
}

export function routingClauses(text, { max = 6 } = {}) {
  // directiveText preserves blank-line/list workflow steps. instructionText is
  // intentionally lossy for model routing and would hide a second operation
  // from this safety boundary.
  const directive = directiveText(text);
  if (!directive) return [];
  return directive
    .split(CLAUSE_BOUNDARY_RE)
    .map(clause => clause
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*(?:and|also|first|next|finally)\b[,:-]?\s*/i, '')
      .trim())
    .filter(Boolean)
    .slice(0, Math.max(1, max));
}

// Routing needs more than instructionText's first paragraph for an explicit
// multi-step list, but less than directiveText's arbitrary payload prose. Keep
// the first instruction clause plus later clauses that begin like an action or
// a direct question. A pasted paragraph such as "Weather trends rose..." stays
// data; a later "Check the weather" remains an instruction.
export function routingInstructionClauses(text, { max = 6 } = {}) {
  const payloadInstruction = inlinePayloadInstruction(text);
  if (payloadInstruction) return [payloadInstruction];
  const clauses = routingClauses(text, { max });
  if (clauses.length <= 1) return clauses;
  const head = instructionText(text);
  const selected = [];
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index];
    if (index === 0 || INSTRUCTION_CLAUSE_START_RE.test(clause)) selected.push(clause);
  }
  return selected.length ? selected.slice(0, Math.max(1, max)) : (head ? [head] : []);
}

export function isStandaloneRoutingRequest(text) {
  return routingClauses(text).length <= 1;
}
