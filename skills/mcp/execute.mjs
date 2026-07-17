// @ts-check
/**
 * MCP skill dispatcher.
 *
 * Tool names handled here are namespaced `mcp_<serverId>_<bareTool>`. We
 * split the prefix to find the user's server config, then call lib/mcp-client
 * to talk to the server. Result is normalized to OE's tool-result text shape.
 *
 * No static tools live in this skill's manifest — the runtime MCP tools are
 * injected into agent.tools by routes/_helpers/agent-resolver.mjs. The shim
 * dispatched here just routes the call.
 */
import { getServerById } from '../../lib/mcp-config.mjs';
import { callTool } from '../../lib/mcp-client.mjs';
import { abortError } from '../../lib/abort-utils.mjs';

// Split an MCP result into:
//   - text:   the LLM-facing string (truncated previews + resource links;
//             image items become a "[image rendered inline]" placeholder so
//             the LLM knows an image was returned without seeing the data).
//   - images: array of {base64, mimeType, filename} that the dispatcher
//             yields as separate `image` events so the chat UI renders
//             each one as its own inline bubble (same flow as the image
//             generator skill uses).
function formatToolResult(result, serverId, toolName) {
  if (!result) return { text: '(no result)', images: [] };
  if (result.isError) {
    const text = Array.isArray(result.content)
      ? result.content.map(c => c.text ?? '').join('\n')
      : (result.content?.text ?? String(result.content ?? ''));
    return { text: `MCP tool error: ${text || 'unknown error'}`, images: [] };
  }
  if (!Array.isArray(result.content)) {
    if (typeof result.content === 'string') return { text: result.content, images: [] };
    return { text: JSON.stringify(result.content), images: [] };
  }
  const textParts = [];
  const images = [];
  let imageCounter = 0;
  for (const c of result.content) {
    if (c.type === 'text') {
      if (c.text) textParts.push(c.text);
    } else if (c.type === 'image') {
      const mime = c.mimeType ?? 'image/png';
      const data = c.data;
      if (typeof data === 'string' && data.length) {
        imageCounter++;
        const ext = mime.split('/').pop()?.split(';')[0] ?? 'png';
        images.push({
          base64: data,
          mimeType: mime,
          filename: `${toolName ?? serverId ?? 'mcp'}-${Date.now()}-${imageCounter}.${ext}`,
        });
        textParts.push(`[image rendered inline (${mime})]`);
      } else {
        textParts.push(`[image content (${mime}) — no data payload]`);
      }
    } else if (c.type === 'resource') {
      const r = c.resource ?? {};
      const uri = r.uri ?? 'unknown';
      const label = r.name ?? r.title ?? uri;
      const embeddedText = typeof r.text === 'string' && r.text.length
        ? `\n\n\`\`\`\n${r.text}\n\`\`\``
        : '';
      textParts.push(`[${label}](${uri})${embeddedText}`);
    } else if (c.type === 'resource_link') {
      textParts.push(`[${c.name ?? c.uri ?? 'resource'}](${c.uri ?? ''})`);
    } else if (c.type === 'audio') {
      const mime = c.mimeType ?? 'audio/wav';
      textParts.push(c.data ? `[audio content (${mime})]` : `[audio content (${mime}) — no data]`);
    } else {
      textParts.push(`[${c.type ?? 'unknown'} content]`);
    }
  }
  const text = textParts.filter(Boolean).join('\n\n') || '(empty content)';
  return { text, images };
}

export async function* executeSkillTool(name, args, userId, agentId, ctx) {
  if (!name?.startsWith('mcp_')) {
    yield { type: 'result', text: `MCP dispatcher called with non-mcp tool "${name}"` };
    return;
  }
  // Strip the `mcp_` prefix and split on the `__` (double-underscore)
  // namespace separator. Single `_` would collide with bare tool names
  // that contain underscores (e.g. filesystem's `read_file`).
  const rest = name.slice('mcp_'.length);
  const sepIdx = rest.indexOf('__');
  if (sepIdx <= 0) {
    yield { type: 'result', text: `Malformed MCP tool name: ${name}` };
    return;
  }
  const serverId = rest.slice(0, sepIdx);
  const bareTool = rest.slice(sepIdx + 2);
  const cfg = getServerById(userId, serverId);
  if (!cfg) {
    yield { type: 'result', text: `MCP server "${serverId}" is not registered for this user.` };
    return;
  }
  try {
    const result = await callTool(userId, cfg, bareTool, args ?? {}, {
      signal: ctx?.signal ?? null,
    });
    const { text, images } = formatToolResult(result, serverId, bareTool);
    // Push each image to the user via ctx.showImage — the WS sendToUser
    // path forwards it as a top-level `image` event which the client
    // renders inline via appendImageBubble. We don't yield it as a
    // tool event because the provider's tool loop only re-yields known
    // event types (tool_call / tool_progress / tool_result) and would
    // silently swallow an `image` event. ctx.showImage bypasses the
    // tool loop entirely. The LLM still sees `[image rendered inline]`
    // in the text result, so it knows an image was returned.
    for (const img of images) {
      try { await ctx?.showImage?.(img); }
      catch (e) { console.warn(`[mcp] showImage failed: ${e.message}`); }
    }
    yield { type: 'result', text };
  } catch (e) {
    if (ctx?.signal?.aborted || e?.name === 'AbortError') {
      throw abortError(ctx?.signal, `MCP call ${serverId}/${bareTool} cancelled`);
    }
    console.warn(`[mcp] callTool failed: server=${serverId} tool=${bareTool}:`, e.message);
    yield { type: 'result', text: `MCP call failed (${serverId}/${bareTool}): ${e.message}` };
  }
}
