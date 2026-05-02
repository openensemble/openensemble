import { sendTelegramToUser } from '../../routes/telegram.mjs';

export default async function execute(name, args, userId) {
  if (name === 'send_telegram_message') {
    if (!userId) return 'Error: no user context.';
    const text = (args?.text ?? '').toString().trim();
    if (!text) return 'Error: text is required.';
    const ok = await sendTelegramToUser(userId, text);
    return ok ? 'Sent.' : 'Error: Telegram not configured or chat not linked. Open Settings → Telegram to set up the bot.';
  }
  return `Unknown tool: ${name}`;
}
