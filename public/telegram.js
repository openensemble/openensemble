// Per-user Telegram wiring. Every user configures their own BotFather bot
// from Settings → Profile → Telegram. The admin's only control is the
// telegramAllowed boolean (managed in User Management), which gates whether
// this panel is interactive or shows a disabled stub.

async function loadTelegramUser() {
  const root = $('telegramSection');
  if (!root) return;
  const body = $('telegramBody');
  if (!body) return;
  body.innerHTML = '<div style="font-size:12px;color:var(--muted)">Loading…</div>';
  try {
    const r = await fetch('/api/telegram/me');
    if (!r.ok) { body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load: HTTP ${r.status}</div>`; return; }
    const s = await r.json();
    renderTelegramSection(s);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function renderTelegramSection(s) {
  const body = $('telegramBody');
  if (!body) return;

  if (!s.allowed) {
    body.innerHTML = `
      <div style="padding:12px;background:var(--bg3);border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:12px">
        Telegram is disabled for your account. Ask an admin if you need access.
      </div>`;
    return;
  }

  const host = location.origin;
  const defaultWebhook = `${host}${s.webhookPath}`;
  const webhookIsHttps = /^https:\/\//.test(defaultWebhook);

  const tokenRow = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Bot token <span style="color:var(--muted)">· from <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent)">@BotFather</a> → /newbot</span></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <input type="password" id="tgBotToken" placeholder="${s.botTokenSet ? '•••• already saved — paste a new one to replace' : '123456789:ABC-..'}" autocomplete="new-password"
        style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px">
      <button onclick="saveTelegramBotToken()"
        style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Save</button>
    </div>`;

  const webhookRow = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Webhook URL <span style="color:var(--muted)">· must be HTTPS and reachable from Telegram</span></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <input type="text" id="tgWebhookUrl" value="${escHtml(s.webhookUrl || defaultWebhook)}"
        style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;font-family:monospace">
      <button onclick="registerTelegramWebhook()"
        style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Register</button>
    </div>
    ${webhookIsHttps ? '' : `<div style="font-size:11px;color:#e0a35c;margin-bottom:8px">⚠ Your OpenEnsemble origin isn't HTTPS. Telegram rejects non-HTTPS webhooks — put OE behind a reverse proxy (nginx, Caddy, Tailscale Funnel) and paste the public HTTPS URL here.</div>`}
  `;

  // Status/summary line
  const statusBits = [];
  if (s.botUsername) statusBits.push(`Bot: <b>@${escHtml(s.botUsername)}</b>${s.botName ? ` (${escHtml(s.botName)})` : ''}`);
  if (s.tokenError)  statusBits.push(`<span style="color:var(--red,#e05c5c)">Token error: ${escHtml(s.tokenError)}</span>`);
  if (s.webhookUrl)  statusBits.push(`Webhook: <code style="font-size:11px">${escHtml(s.webhookUrl)}</code>`);
  if (s.webhookLastError) {
    const when = s.webhookLastErrorDate ? new Date(s.webhookLastErrorDate * 1000).toLocaleString() : '';
    statusBits.push(`<span style="color:var(--red,#e05c5c)">Last error: ${escHtml(s.webhookLastError)}${when ? ` · ${when}` : ''}</span>`);
  }
  if (s.webhookPendingUpdates) statusBits.push(`Pending: ${s.webhookPendingUpdates}`);
  const statusHtml = statusBits.length
    ? `<div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">${statusBits.join('<br>')}</div>`
    : '';

  // Linked-chat block
  let linkBlock = '';
  if (s.linked) {
    linkBlock = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div>
          <div style="font-weight:600;color:var(--text)">● Linked${s.botUsername ? ` to @${escHtml(s.botUsername)}` : ''}</div>
          <div style="font-size:11px;color:var(--muted)">Chat ID: <code>${escHtml(s.chatId ?? '—')}</code></div>
        </div>
        <div style="display:flex;gap:6px">
          <button onclick="generateTelegramLinkCode()" title="Generate a code to link another chat"
            style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer">+ Code</button>
          <button onclick="unlinkTelegramChat()"
            style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Unlink chat</button>
        </div>
      </div>
      <div id="tgLinkBox"></div>`;
  } else if (s.botUsername && s.webhookUrl) {
    linkBlock = `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="font-weight:600;color:var(--text);margin-bottom:4px">Next: open your bot on Telegram and send /start</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">The first chat to <code>/start</code> becomes your linked chat. It's your bot, so this is safe.</div>
        <a href="https://t.me/${escHtml(s.botUsername)}" target="_blank"
           style="display:inline-block;background:var(--accent);color:#fff;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;text-decoration:none">Open @${escHtml(s.botUsername)}</a>
      </div>`;
  }

  // Danger: remove everything
  const removeRow = s.botTokenSet ? `
    <div style="margin-top:10px;display:flex;justify-content:flex-end">
      <button onclick="removeTelegramBot()" title="Remove bot token, secret, and chat link"
        style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">Remove bot</button>
    </div>` : '';

  body.innerHTML = `
    ${linkBlock}
    ${tokenRow}
    ${s.botTokenSet ? webhookRow : ''}
    ${statusHtml}
    ${removeRow}`;
}

// ── Mutations ─────────────────────────────────────────────────────────────────
async function saveTelegramBotToken() {
  const tok = $('tgBotToken')?.value.trim();
  if (!tok) { showToast('Paste a bot token first'); return; }
  try {
    const r = await fetch('/api/telegram/me', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: tok }),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      showToast(`Save failed: ${b.error ?? r.status}`);
      return;
    }
    showToast('Bot token saved');
    await loadTelegramUser();
  } catch (e) { showToast(`Save failed: ${e.message}`); }
}

async function registerTelegramWebhook() {
  const url = $('tgWebhookUrl')?.value.trim();
  if (!url) { showToast('Webhook URL is empty'); return; }
  if (!/^https:\/\//.test(url)) {
    if (!confirm('Telegram requires HTTPS for webhooks. Register anyway?')) return;
  }
  try {
    const r = await fetch('/api/telegram/me/register-webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: url }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) {
      showToast(`Register failed: ${body.description ?? body.error ?? r.status}`, 6000);
      return;
    }
    showToast('Webhook registered');
    await loadTelegramUser();
  } catch (e) { showToast(`Register failed: ${e.message}`); }
}

async function removeTelegramBot() {
  if (!confirm('Remove your bot token, webhook secret, and linked chat? This also deregisters the webhook with Telegram.')) return;
  try {
    await fetch('/api/telegram/me', { method: 'DELETE' });
    showToast('Bot removed');
    await loadTelegramUser();
  } catch { showToast('Failed to remove'); }
}

async function unlinkTelegramChat() {
  if (!confirm('Unlink the current Telegram chat? Your bot config stays; you can re-link by sending /start from any chat once you generate a code.')) return;
  try {
    await fetch('/api/telegram/me/link', { method: 'DELETE' });
    showToast('Chat unlinked');
    await loadTelegramUser();
  } catch { showToast('Failed to unlink'); }
}

async function generateTelegramLinkCode() {
  const box = $('tgLinkBox');
  if (!box) return;
  box.innerHTML = '<div style="color:var(--muted);font-size:12px;margin-top:8px">Generating code…</div>';
  try {
    const r = await fetch('/api/telegram/me/link', { method: 'POST' });
    const data = await r.json();
    if (!data.code) { box.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed: ${escHtml(data.error ?? 'unknown')}</div>`; return; }
    const mins = Math.round((data.expiresIn ?? 600) / 60);
    box.innerHTML = `
      <div style="margin-top:8px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Send from the new chat · expires in ${mins} min</div>
        <div style="display:flex;align-items:center;gap:8px">
          <code style="flex:1;background:var(--bg2);padding:8px 12px;border-radius:6px;font-size:14px;letter-spacing:2px;font-weight:600;text-align:center">/start ${escHtml(data.code)}</code>
          <button onclick="navigator.clipboard.writeText('/start ${escHtml(data.code)}').then(() => showToast('Copied'))"
            style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 10px;font-size:12px;cursor:pointer">Copy</button>
        </div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed: ${escHtml(e.message)}</div>`;
  }
}
