// Voice routines skill — author/list/delete routines by voice or chat.
// All persistence goes through lib/routines.mjs so the same validation
// logic catches malformed routines from the LLM and the web UI alike.

function summarizeAction(a) {
  switch (a.type) {
    case 'ha_scene':     return `activate ${a.scene_id}`;
    case 'ha_call':      return `${a.domain}.${a.service}${a.data?.entity_id ? ` (${a.data.entity_id})` : ''}`;
    case 'play_ambient': return `play ${a.file}${a.loop !== false ? ' on loop' : ''}`;
    case 'tts_say':      return `say "${a.text}"`;
    default:             return a.type;
  }
}

function summarizeRoutine(r) {
  const aliases = r.aliases?.length ? ` (also: ${r.aliases.join(', ')})` : '';
  const acts = r.actions.map(summarizeAction).join(' → ');
  return `- ${r.id}: "${r.trigger}"${aliases} → ${acts}`;
}

async function execCreateRoutine(args, userId) {
  const { loadRoutines, saveRoutines } = await import('../../lib/routines.mjs');
  if (!args?.id || typeof args.id !== 'string') return 'Error: id is required (short slug).';
  if (!args?.trigger || typeof args.trigger !== 'string') return 'Error: trigger phrase is required.';
  if (!Array.isArray(args.actions) || args.actions.length === 0) return 'Error: actions list is required (at least one).';

  const { routines } = loadRoutines(userId);
  const idx = routines.findIndex(r => r.id === args.id.toLowerCase().trim());
  const existing = idx >= 0 ? routines[idx] : null;
  const next = {
    // Carry forward webhook_token + device_id when updating an existing
    // routine so iPhone NFC URLs stamped on tags don't break each time
    // the LLM tweaks the actions list.
    ...(existing || {}),
    id: args.id.toLowerCase().trim(),
    trigger: args.trigger.trim(),
    aliases: Array.isArray(args.aliases) ? args.aliases.filter(a => typeof a === 'string' && a.trim()) : [],
    actions: args.actions,
    ...(typeof args.device_id === 'string' ? { device_id: args.device_id } : {}),
  };

  const action = idx >= 0 ? 'updated' : 'created';
  if (idx >= 0) routines[idx] = next;
  else routines.push(next);

  let saved;
  try {
    saved = saveRoutines(userId, routines);
  } catch (e) {
    return `Error saving routine: ${e.message}`;
  }
  const persisted = saved.routines.find(r => r.id === next.id);
  if (!persisted) {
    // cleanRoutine in lib/routines.mjs rejected the input — surface why rather
    // than silently dropping.
    return `Error: routine did not pass validation. Check action types and required fields (ha_scene needs scene_id, ha_call needs domain+service+data, play_ambient needs file, tts_say needs text).`;
  }
  return `Routine ${action}: ${summarizeRoutine(persisted)}`;
}

async function execListRoutines(userId) {
  const { loadRoutines } = await import('../../lib/routines.mjs');
  const { routines } = loadRoutines(userId);
  if (!routines.length) return 'No voice routines configured.';
  return `Configured routines:\n${routines.map(summarizeRoutine).join('\n')}`;
}

async function execDeleteRoutine(args, userId) {
  const { loadRoutines, saveRoutines } = await import('../../lib/routines.mjs');
  if (!args?.id) return 'Error: id is required.';
  const { routines } = loadRoutines(userId);
  const target = routines.find(r => r.id === args.id);
  if (!target) return `No routine found with id "${args.id}".`;
  const next = routines.filter(r => r.id !== args.id);
  saveRoutines(userId, next);
  return `Routine "${target.id}" deleted.`;
}

async function execListAmbientFiles(userId) {
  const { listAmbientFiles } = await import('../../lib/routines.mjs');
  const files = listAmbientFiles(userId);
  if (!files.length) return 'Ambient library is empty. Upload MP3s in Settings → Voice devices → Routines.';
  return `Ambient library:\n${files.map(f => `- ${f.name} (${(f.size / 1024).toFixed(1)} KB)`).join('\n')}`;
}

export default async function execute(name, args, userId, _agentId, _ctx) {
  if (!userId) return 'Error: no user context.';
  if (name === 'create_routine')     return execCreateRoutine(args || {}, userId);
  if (name === 'list_routines')      return execListRoutines(userId);
  if (name === 'delete_routine')     return execDeleteRoutine(args || {}, userId);
  if (name === 'list_ambient_files') return execListAmbientFiles(userId);
  return `Unknown tool: ${name}`;
}
