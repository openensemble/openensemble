/**
 * Voice-device UDP diagnostic log sink.
 *
 * Voice devices (fw >= 0.2.52) forward their [boot] / [hb] / [ambient-stats]
 * heartbeat lines to this host over connectionless UDP (see the firmware's
 * oe_udplog.c). UDP is used precisely because the datagrams keep arriving while
 * the device's control WebSocket is dropping/reconnecting — the moment we most
 * need visibility on a Wi-Fi-only device that has no serial attached.
 *
 * Each datagram is appended, timestamped + tagged with the sender's LAN IP and
 * (when resolvable) the paired device name, to LOG_PATH. Tail that file to
 * watch a device live:  tail -f /tmp/oe-voice-udplog.log
 *
 * Best-effort and self-contained: a bind failure (port in use) logs a warning
 * and disables the sink rather than taking down the server.
 */
import dgram from 'node:dgram';
import fs from 'node:fs';

// Must match OE_UDPLOG_PORT in components/oe_client/include/oe_client.h.
const UDP_PORT = 47269;
const LOG_PATH = '/tmp/oe-voice-udplog.log';

let _sock = null;
let _stream = null;
// Optional IP -> device-name resolver, injected by the caller so this module
// stays decoupled from the voice-device registry / WS connection tables.
let _nameForIp = null;
// Optional per-line hook (same decoupling): the health loop consumes
// [hb]/[boot] telemetry from here instead of tailing the log file.
let _onLine = null;

/**
 * Start the UDP log sink.
 * @param {object} [opts]
 * @param {(ip: string) => (string|null)} [opts.nameForIp] resolve a sender IP
 *        to a human device label (e.g. "Master Bedroom"); return null if unknown.
 * @param {(ip: string, text: string) => void} [opts.onLine] called with every
 *        datagram's sender IP + raw text (no timestamp prefix). Must not throw;
 *        guarded here anyway so a consumer bug can't kill the sink.
 */
export function startVoiceUdpLog({ nameForIp = null, onLine = null } = {}) {
  if (_sock) return; // idempotent
  _nameForIp = nameForIp;
  _onLine = onLine;

  try {
    _stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  } catch (e) {
    console.warn(`[vdev-udplog] cannot open ${LOG_PATH}: ${e.message} — sink disabled`);
    return;
  }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    // One datagram = one already-formatted log line. Strip trailing newlines
    // the firmware may or may not include, re-add exactly one.
    const text = msg.toString('utf8').replace(/[\r\n]+$/, '');
    const label = _nameForIp?.(rinfo.address);
    const who = label ? `${rinfo.address} ${label}` : rinfo.address;
    const line = `${new Date().toISOString()} ${who} ${text}\n`;
    try { _stream.write(line); } catch { /* best-effort */ }
    try { _onLine?.(rinfo.address, text); } catch { /* consumer bug ≠ sink down */ }
  });

  sock.on('error', (e) => {
    console.warn(`[vdev-udplog] socket error: ${e.message}`);
    // EADDRINUSE on bind lands here before 'listening' — give up cleanly.
    try { sock.close(); } catch {}
    if (_sock === sock) _sock = null;
  });

  sock.on('listening', () => {
    const a = sock.address();
    console.log(`[vdev-udplog] listening on ${a.address}:${a.port} → ${LOG_PATH}`);
  });

  try {
    sock.bind(UDP_PORT); // 0.0.0.0:UDP_PORT — receive from any device on the LAN
    _sock = sock;
  } catch (e) {
    console.warn(`[vdev-udplog] bind failed: ${e.message} — sink disabled`);
  }
}

export function stopVoiceUdpLog() {
  try { _sock?.close(); } catch {}
  try { _stream?.end(); } catch {}
  _sock = null;
  _stream = null;
}
