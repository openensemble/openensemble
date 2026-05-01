# Public access (tunnel & Telegram)

Some features work better — or only work — when OpenEnsemble has a stable public URL.

| Feature | Needs the public internet? |
|---|---|
| **Telegram bot webhooks** | **Yes.** Telegram's servers need to push messages *into* your install, so it must be reachable on a public HTTPS URL. |
| **OAuth callbacks** (Gmail, Microsoft, Google Calendar) | **Usually, on a homelab box.** Google/Microsoft require HTTPS redirect URIs and only accept a few exceptions (like `http://localhost`). If you're hitting OE at `http://192.168.x.x`, the provider will reject the redirect — a public HTTPS URL is the easiest fix. (If you're on the same machine as OE and use `http://localhost:3737`, OAuth works without a tunnel.) |
| **External sharing links** | Only if you actually want them reachable outside your LAN. Intra-install sharing works without any of this. |

The built-in **Cloudflare Tunnel** integration gives you a stable public HTTPS URL without opening ports on your router, getting a static IP, or running your own reverse proxy. It's the easy path. If you already have a real domain pointed at the install (nginx/Caddy + Let's Encrypt, etc.), you don't need the tunnel — that setup serves the same purpose.

## Setting up the Cloudflare tunnel

1. **Settings → System → Public Access (Cloudflare Tunnel)**.
2. Click **Configure**. The server downloads `cloudflared` if it doesn't already have it.
3. Sign in to Cloudflare in the popup that opens — this links your account.
4. Pick or create a hostname (e.g. `oe.example.com`).
5. Save. The tunnel comes up; the public URL is now reachable.

The tunnel is **server-wide** — owner/admin only — and survives restarts. Any user on the install benefits from the same URL.

## Telegram

A Telegram bot is the easiest way to talk to your Coordinator from your phone or away from the desk.

1. Open Telegram, message **@BotFather**, run `/newbot`. Pick a name and username; it gives you a token.
2. **Settings → Profile → Telegram → Token** — paste the token.
3. Click **Register webhook**. The button registers `https://{your-tunnel-host}/api/telegram/{userId}/webhook` as the bot's webhook. (Requires the Cloudflare tunnel to be live.)
4. Open Telegram → your bot → `/start`.

From then on, anything you message the bot is routed to your Coordinator agent, and the agent's reply comes back over Telegram. Long-running tasks can also push notifications to the bot.

## Per-user Telegram bots

Each user on the install gets their own bot — they're not shared. The webhook URL embeds the user ID, so messages route correctly.

## Custom domains

You don't have to use Cloudflare. If you have a static IP and a reverse proxy (nginx, Caddy), point your domain at port 3737, and OE will work the same. The tunnel is just the easy default.

## When the tunnel is down

OAuth flows that require the public URL will fail (Gmail can't redirect to your private IP). Telegram messages queue on Telegram's side and deliver when the webhook is reachable again — the messages aren't lost, but reply latency goes up.

## Trust note

Once the tunnel is live, your install is on the public internet. Auth is still required (no anonymous access), but you should:

- Use strong passwords.
- Enable access schedules on accounts that don't need 24/7 access.
- Keep the install up to date (auto-update is on by default).
