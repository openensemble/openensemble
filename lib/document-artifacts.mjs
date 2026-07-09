const DOCUMENT_TOOL_NAMES = new Set([
  'list_documents',
  'read_document',
  'update_document',
  'create_document',
  'list_document_versions',
  'restore_document_version',
]);

const DOCUMENT_CONTENT_TOOLS = new Set(['update_document', 'create_document']);
const DOCUMENT_MUTATION_TOOLS = new Set([
  'update_document', 'create_document', 'restore_document_version',
]);

export function isDocumentTool(name) {
  return DOCUMENT_TOOL_NAMES.has(String(name ?? ''));
}

export function normalizeDocumentRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id ?? '').trim();
  if (!/^doc_[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  const filename = String(value.filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  if (!filename) return null;
  const source = value.source === 'research' ? 'research' : '';
  const mimeType = String(value.mimeType ?? (source ? 'text/markdown' : 'text/plain'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  const requestId = String(value.requestId ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80);
  return {
    id,
    filename,
    mimeType: mimeType || 'text/plain',
    source,
    ...(requestId ? { requestId } : {}),
  };
}

export function compactDocumentToolArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  if (DOCUMENT_CONTENT_TOOLS.has(String(name ?? '')) && typeof out.content === 'string') {
    out.content = `[document body omitted: ${out.content.length} characters]`;
  }
  return out;
}

function compactReadResult(text) {
  const raw = String(text ?? '');
  if (/^(?:Error:|Document\s+"|No editable documents)/i.test(raw.trim())) return raw.slice(0, 1000);
  const header = raw.match(/^\[Document:\s*(.*?)\s*\|\s*id:\s*([^|\]]+?)(?:\s*\|\s*v(\d+))?\]\s*(?:\r?\n|$)/);
  if (!header) return '[Document body omitted from chat history]';
  return JSON.stringify({
    success: true,
    action: 'read',
    filename: header[1].trim(),
    id: header[2].trim(),
    version: header[3] ? Number(header[3]) : null,
    message: 'Document content was read for this turn and omitted from chat history.',
  });
}

export function compactDocumentToolResult(name, text) {
  if (name === 'read_document') return compactReadResult(text);
  return String(text ?? '').slice(0, 10_000);
}

export function parseDocumentMutationResult(name, text) {
  if (!DOCUMENT_MUTATION_TOOLS.has(String(name ?? '')) || !text) return null;
  try {
    const value = JSON.parse(String(text));
    if (!value?.success) return null;
    const docId = String(value.docId ?? value.id ?? '').replace(/^research:/, '');
    if (!/^doc_[A-Za-z0-9_-]{1,120}$/.test(docId)) return null;
    const filename = String(value.filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
    return {
      success: true,
      action: String(value.action ?? (name === 'create_document' ? 'created' : name === 'restore_document_version' ? 'restored' : 'updated')).slice(0, 32),
      docId,
      filename,
      mimeType: String(value.mimeType ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
      source: value.source === 'research' || String(value.id ?? '').startsWith('research:') ? 'research' : '',
      version: Number(value.version) || null,
      previousVersion: Number(value.previousVersion) || null,
      note: String(value.note ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240),
    };
  } catch {
    return null;
  }
}

export function findDocumentMutation(tools) {
  if (!Array.isArray(tools)) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    const outcome = parseDocumentMutationResult(tools[i]?.name, tools[i]?.text);
    if (outcome) return outcome;
  }
  return null;
}

export function compactDocumentToolPreview(name, preview) {
  if (name === 'read_document') return 'Document loaded';
  return String(preview ?? '').slice(0, 500);
}

export function compactDocumentFallback(text, maxChars = 500) {
  const value = String(text ?? '').trim();
  const lines = value.split(/\r?\n/).filter(line => line.trim());
  const looksLikeShortMessage = /\?\s*$/.test(value)
    || /^(?:please\b|could you\b|would you\b|which\b|what\b|where\b|when\b|who\b|how\b|i (?:need|cannot|can't|couldn't|was unable)\b|unable\b|cannot\b|can't\b|couldn't\b|error\b|no changes?\b|document\b.*\b(?:not found|read-only|too large)\b)/i.test(value);
  const looksLikeDocumentBody = lines.some(line => /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|>\s|\|.*\|)/.test(line.trim()));
  if (value.length <= maxChars && lines.length <= 3 && looksLikeShortMessage && !looksLikeDocumentBody) return value;
  return 'No changes were saved. The agent returned a long draft instead of updating the document; please retry the edit.';
}

export function sanitizeDocumentToolEvent(event) {
  if (!event || !isDocumentTool(event.name)) return event;
  if (event.type === 'tool_call') {
    return { ...event, args: compactDocumentToolArgs(event.name, event.args) };
  }
  if (event.type === 'tool_result') {
    const text = compactDocumentToolResult(event.name, event.text);
    const preview = compactDocumentToolPreview(event.name, event.preview).slice(0, 240);
    return { ...event, text, preview };
  }
  return event;
}
