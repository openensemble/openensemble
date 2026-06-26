import { listDesktops, sendDesktopCommand } from '../../lib/desktop-bus.mjs';

const DESKTOP_TOOLS = new Set([
  'desktop_list_sandboxes',
  'desktop_list_files',
  'desktop_read_file',
  'desktop_write_file',
  'desktop_save_file',
  'desktop_download_url',
  'desktop_run_command',
]);

export async function executeSkillTool(name, args = {}, userId) {
  if (args?.__validate) return '';

  if (name === 'desktop_list_clients') {
    const clients = listDesktops(userId);
    if (!clients.length) return 'No OpenEnsemble Desktop clients are connected.';
    return JSON.stringify({ clients }, null, 2);
  }

  if (!DESKTOP_TOOLS.has(name)) return null;

  const clientId = typeof args?.clientId === 'string' ? args.clientId : null;
  const forwarded = { ...(args || {}) };
  delete forwarded.clientId;

  const timeoutMs = name === 'desktop_download_url' || name === 'desktop_run_command'
    ? 300_000
    : 60_000;

  const data = await sendDesktopCommand(userId, name, forwarded, { clientId, timeoutMs });
  return formatDesktopResult(data);
}

function formatDesktopResult(data) {
  const firstText = data?.content?.find?.(part => part?.type === 'text')?.text;
  if (typeof firstText === 'string') return firstText;
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? null, null, 2);
}

export default executeSkillTool;
