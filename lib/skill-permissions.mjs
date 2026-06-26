const FLAG_RULES = [
  { flag: 'read',       re: /\b(read|list|get|search|fetch|scan|show|load|stats|status|inspect|recall|screenshot|observe|view|download)\b/i },
  { flag: 'write',      re: /\b(write|save|create|add|update|patch|edit|set|delete|remove|clear|forget|upload|restore|import|label|mark|move)\b/i },
  { flag: 'send',       re: /\b(send|email|reply|compose|telegram|notify|message|deliver|webhook)\b/i },
  { flag: 'control',    re: /\b(exec|run|command|shell|terminal|service|restart|stop|start|reboot|install|upgrade|flash|call_service|click|type|keypress|open_tab|focus|close_tab|ambient|tts|alarm)\b/i },
  { flag: 'admin',      re: /\b(admin|user|provider|config|backup|restore|update|tunnel|oauth|credential|permission|access|invite|role|assign|lock)\b/i },
  { flag: 'files',      re: /\b(file|document|upload|download|path|directory|zip|archive|image|video|audio|transcribe|profile_files?)\b/i },
  { flag: 'credentials', re: /\b(token|credential|secret|password|oauth|api key|auth|login|smtp|imap)\b/i },
  { flag: 'external',   re: /\b(web|url|http|browser|gmail|google|microsoft|imap|smtp|telegram|calendar|home assistant|mcp|node|proxmox|ollama|openai|anthropic|fireworks)\b/i },
  { flag: 'memory',     re: /\b(memory|remember|recall|forget|rule|preference|profile|notes?)\b/i },
];

const HIGH_RISK_FLAGS = new Set(['admin', 'control', 'credentials']);
const MUTATING_FLAGS = new Set(['write', 'send', 'control', 'admin']);

function toolText(tool) {
  const fn = tool?.function ?? tool ?? {};
  return [
    fn.name,
    fn.description,
    ...Object.values(fn.parameters?.properties ?? {}).map(p => p?.description ?? ''),
  ].filter(Boolean).join(' ');
}

export function classifyToolPermission(tool) {
  const fn = tool?.function ?? tool ?? {};
  const text = toolText(tool);
  const flags = new Set();
  for (const rule of FLAG_RULES) {
    if (rule.re.test(text)) flags.add(rule.flag);
  }
  const mutates = [...flags].some(f => MUTATING_FLAGS.has(f));
  const risk = [...flags].some(f => HIGH_RISK_FLAGS.has(f))
    ? 'high'
    : mutates
      ? 'medium'
      : 'low';
  return {
    name: fn.name ?? null,
    description: fn.description ?? '',
    flags: [...flags].sort(),
    mutates,
    risk,
  };
}

export function summarizeSkillPermissions(manifest, {
  enabled = false,
  assignment = null,
  assignedAgent = null,
  tools = null,
} = {}) {
  const classifiedTools = (tools ?? manifest.tools ?? []).map(classifyToolPermission);
  const flags = new Set();
  for (const t of classifiedTools) for (const f of t.flags) flags.add(f);
  if (manifest.voice_device === true) flags.add('voice');
  if (manifest.service === true) flags.add('service-role');
  if (manifest.custom === true) flags.add('custom');
  const mutatingTools = classifiedTools.filter(t => t.mutates).length;
  const highRiskTools = classifiedTools.filter(t => t.risk === 'high').length;
  const risk = highRiskTools > 0 ? 'high' : mutatingTools > 0 ? 'medium' : 'low';
  return {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? '',
    category: manifest.category ?? null,
    service: Boolean(manifest.service),
    custom: Boolean(manifest.custom),
    userScope: manifest.userScope ?? null,
    hidden: Boolean(manifest.hidden),
    enabled,
    assignment,
    assignedAgent,
    voiceDevice: manifest.voice_device === true,
    alwaysOn: manifest.always_on === true,
    bundledWithRole: manifest.bundled_with_role ?? null,
    defaultToolIds: manifest.defaultToolIds ?? null,
    flags: [...flags].sort(),
    risk,
    toolCount: classifiedTools.length,
    mutatingTools,
    highRiskTools,
    tools: classifiedTools,
  };
}
