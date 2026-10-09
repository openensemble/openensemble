import { requireAuth, getAuthToken, readBody, loadConfig } from './_helpers.mjs';
import { mobileVoicePreferences } from '../lib/mobile-voice-settings.mjs';
import { mobilePushStatus, registerMobileDevice, unregisterMobileDevice, deliverMobilePush } from '../lib/mobile-push.mjs';

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/mobile/') || url.pathname === '/api/mobile/voice') return false;
  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return true;
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && url.pathname === '/api/mobile/status') {
    reply(200, { userId, voiceResponses: true, voiceStreaming: loadConfig().ttsProvider === 'pocket-tts',
      voice: mobileVoicePreferences(userId), push: mobilePushStatus() });
    return true;
  }
  const device = url.pathname.match(/^\/api\/mobile\/devices\/([A-Za-z0-9_-]{1,128})$/);
  if (req.method === 'DELETE' && device) {
    unregisterMobileDevice(userId, device[1]);
    reply(200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && ['/api/mobile/register', '/api/mobile/test-push'].includes(url.pathname)) {
    if (!mobilePushStatus().configured) { reply(503, { error: mobilePushStatus().reason }); return true; }
    let body;
    try {
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > 8192) throw new Error('Request too large');
      body = JSON.parse(raw);
    }
    catch { reply(400, { error: 'Invalid registration request' }); return true; }
    if (url.pathname === '/api/mobile/register') {
      try { reply(200, { ok: true, ...registerMobileDevice(userId, getAuthToken(req), body) }); }
      catch (error) { reply(400, { error: error.message }); }
      return true;
    }
    if (typeof body?.deviceId !== 'string') { reply(400, { error: 'deviceId is required' }); return true; }
    const results = await deliverMobilePush(userId, {
      aps: { alert: { title: 'OpenEnsemble', body: 'Push notifications are connected.' }, sound: 'default' },
      action: 'conversation', userId,
    }, { deviceId: body.deviceId });
    const delivered = results.some(r => r.ok);
    reply(delivered ? 200 : 502, { ok: delivered, ...(delivered ? {} : { error: results[0]?.reason || 'No active registration for this phone' }) });
    return true;
  }
  reply(404, { error: 'Mobile route not found' });
  return true;
}
