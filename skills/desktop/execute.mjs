import { listDesktops, sendDesktopCommand } from '../../lib/desktop-bus.mjs';
import { saveDesktopAttachment } from '../../lib/desktop-attachments.mjs';

const DESKTOP_TOOLS = new Set([
  'desktop_list_sandboxes',
  'desktop_list_files',
  'desktop_read_file',
  'desktop_write_file',
  'desktop_save_file',
  'desktop_download_url',
  'desktop_run_command',
  'desktop_computer_status',
  'desktop_computer_observe',
  'desktop_computer_act',
]);

export async function executeSkillTool(name, args = {}, userId) {
  if (args?.__validate) return '';

  if (name === 'desktop_list_clients') {
    const clients = listDesktops(userId);
    if (!clients.length) return 'No OpenEnsemble Desktop clients are connected.';
    return JSON.stringify({ clients }, null, 2);
  }

  if (name === 'desktop_save_attachment') {
    return JSON.stringify(await saveDesktopAttachment(userId, args), null, 2);
  }

  if (!DESKTOP_TOOLS.has(name)) return null;

  const clientId = typeof args?.clientId === 'string' ? args.clientId : null;
  const forwarded = { ...(args || {}) };
  delete forwarded.clientId;
  if (name.startsWith('desktop_computer_')) {
    const clients = listDesktops(userId);
    const client = clientId ? clients.find(item => item.clientId === clientId) : clients.length === 1 ? clients[0] : null;
    if (!client && clients.length > 1) throw new Error('Choose the intended clientId before using computer control.');
    if (client && !client.capabilities?.includes(name)) throw new Error('This desktop does not provide computer control. Install the Windows desktop update and enable Computer control in its settings.');
  }

  const timeoutMs = name === 'desktop_download_url' || name === 'desktop_run_command'
    ? 300_000
    : 60_000;

  const data = await sendDesktopCommand(userId, name, forwarded, { clientId, timeoutMs });
  return formatDesktopResult(data, name.startsWith('desktop_computer_'));
}

function formatDesktopResult(data, computer = false) {
  const firstText = data?.content?.find?.(part => part?.type === 'text')?.text;
  if (computer && typeof firstText !== 'string') throw new Error('The desktop returned an invalid computer-control response. Observe again before acting.');
  if (computer && typeof firstText === 'string') {
    const images = (data.content || []).filter(part => part?.type === 'image');
    if (firstText.length > 250_000 || images.length > 1) throw new Error('Desktop observation exceeded its size limit.');
    for (const part of images) if (part.mimeType !== 'image/jpeg' || typeof part.data !== 'string' || part.data.length > 1_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) throw new Error('Desktop screenshot has an invalid format or size.');
    for (const part of images) {
      const bytes = Buffer.from(part.data, 'base64');
      if (bytes.length < 5 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('Desktop screenshot is not a JPEG image.');
    }
    // Ephemeral vision input: no screenshot file is written into the user's
    // image library and base64 never appears in the visible tool transcript.
    return images.length ? { text: firstText, _images: images.map(part => ({ mediaType: part.mimeType, base64: part.data })) } : firstText;
  }
  if (typeof firstText === 'string') return firstText;
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? null, null, 2);
}

export default executeSkillTool;
