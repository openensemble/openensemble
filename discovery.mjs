/**
 * LAN Discovery — advertises OpenEnsemble server presence on the LAN.
 *
 * Two independent mechanisms live in this file:
 *   1. A UDP broadcast beacon (port 3738) — node agents listen for this to
 *      auto-discover the server. No external dependencies.
 *   2. An mDNS/Bonjour advertisement (`_openensemble._tcp.local`) via the
 *      `@homebridge/ciao` responder — consumable by anything that can browse
 *      Bonjour/NSD (iOS, Android, the TV app) without needing raw multicast
 *      UDP receive rights.
 */

import dgram from 'dgram';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { BASE_DIR, readConfig } from './lib/paths.mjs';

// Load the mDNS responder lazily and defensively. This is a GUARDED dynamic
// import, not a static one, on purpose: @homebridge/ciao is an optional
// dependency for mDNS advertisement, and this file is imported by server.mjs
// and several route handlers (for getLanAddress). A static import would make a
// missing/uninstalled ciao — e.g. `git pull` without the follow-up
// `npm install` — throw at module load and take the WHOLE server down. The
// guard degrades that to "no mDNS, one warning" and lets everything else boot.
// (The top-level await resolves before startMdnsAdvertiser runs, so that stays
// synchronous; vi.mock still intercepts this dynamic import in tests.)
let _getResponder = null;
try {
  ({ getResponder: _getResponder } = await import('@homebridge/ciao'));
} catch (e) {
  console.warn(`[discovery] @homebridge/ciao unavailable — mDNS advertisement disabled (run npm install to enable): ${e.message}`);
}

const DISCOVERY_PORT = 3738;
const BROADCAST_INTERVAL = 30000; // 30s
const MAGIC = 'OPENENSEMBLE';

let _socket = null;
let _timer = null;

/**
 * Get all broadcast addresses for this machine's network interfaces.
 */
function getBroadcastAddresses() {
  const addrs = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Calculate broadcast address from address + netmask
      const parts = iface.address.split('.').map(Number);
      const mask = iface.netmask.split('.').map(Number);
      const broadcast = parts.map((p, i) => (p | (~mask[i] & 255))).join('.');
      addrs.push(broadcast);
    }
  }
  return addrs.length ? addrs : ['255.255.255.255'];
}

/**
 * Get the primary LAN IP address (first non-internal IPv4).
 */
export function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Start broadcasting the server's presence on the LAN.
 * @param {number} serverPort - The HTTP/WS port (default 3737)
 */
export function startDiscoveryBeacon(serverPort = 3737) {
  try {
    _socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    _socket.bind(() => {
      _socket.setBroadcast(true);

      const sendBeacon = () => {
        const lanIp = getLanAddress();
        const payload = JSON.stringify({
          magic: MAGIC,
          host: lanIp,
          port: serverPort,
          hostname: os.hostname(),
          version: '1.0',
          ts: Date.now(),
        });
        const buf = Buffer.from(payload);

        for (const addr of getBroadcastAddresses()) {
          try {
            _socket.send(buf, 0, buf.length, DISCOVERY_PORT, addr);
          } catch {}
        }
      };

      // Send immediately, then every 30s
      sendBeacon();
      _timer = setInterval(sendBeacon, BROADCAST_INTERVAL);
      console.log(`[discovery] Broadcasting on port ${DISCOVERY_PORT} (LAN: ${getLanAddress()})`);
    });

    _socket.on('error', (err) => {
      console.warn(`[discovery] Beacon error: ${err.message}`);
    });
  } catch (e) {
    console.warn(`[discovery] Failed to start beacon: ${e.message}`);
  }
}

/**
 * Stop the discovery beacon.
 */
export function stopDiscoveryBeacon() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_socket) { try { _socket.close(); } catch {} _socket = null; }
}

/**
 * Listen for discovery beacons (used by the node agent).
 * Returns a Promise that resolves with { host, port } when a server is found.
 * @param {number} timeoutMs - Max time to wait (default 30s)
 */
export function discoverServer(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('Discovery timed out — no server found on LAN'));
    }, timeoutMs);

    sock.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.magic === MAGIC && data.host && data.port) {
          clearTimeout(timer);
          sock.close();
          resolve({
            host: data.host,
            port: data.port,
            hostname: data.hostname,
            url: `ws://${data.host}:${data.port}/ws/nodes`,
          });
        }
      } catch {}
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(new Error(`Discovery error: ${err.message}`));
    });

    sock.bind(DISCOVERY_PORT, () => {
      console.log(`[discovery] Listening for server on port ${DISCOVERY_PORT}...`);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// mDNS advertisement (`_openensemble._tcp.local`)
// ─────────────────────────────────────────────────────────────────────────
//
// Generic-name-only, no personal hostnames, no secrets — this record is
// LAN-visible to anything running a Bonjour/NSD browser.

const MDNS_SERVICE_TYPE = 'openensemble'; // ciao renders this as `_openensemble._tcp`
const DEFAULT_INSTANCE_NAME = 'OpenEnsemble';
const SID_FILE = path.join(BASE_DIR, 'mdns-instance.json');

let _mdnsResponder = null;
let _mdnsService = null;

/**
 * Read this install's own package.json version — deliberately resolved next
 * to this file (not via BASE_DIR, which tests redirect to an isolated tmp
 * dir with no package.json) so it works the same in prod and under vitest.
 */
function getPackageVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Load (or create+persist) a random per-install instance id. This lets a
 * browsing client tell "same server on a new IP" apart from "two different
 * servers" — it's an opaque tag, not a secret, safe to be LAN-visible.
 */
export function getOrCreateInstanceId() {
  try {
    const raw = JSON.parse(fs.readFileSync(SID_FILE, 'utf8'));
    if (raw && typeof raw.sid === 'string' && raw.sid) return raw.sid;
  } catch {}

  const sid = crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SID_FILE), { recursive: true });
    fs.writeFileSync(SID_FILE, JSON.stringify({ sid }, null, 2));
  } catch (e) {
    console.warn(`[discovery] Failed to persist mDNS instance id: ${e.message}`);
  }
  return sid;
}

/**
 * True unless config.json explicitly sets discovery.mdns to false — default
 * on when the key is absent.
 */
export function isMdnsEnabled(cfg = readConfig()) {
  return cfg?.discovery?.mdns !== false;
}

/**
 * Build the TXT record advertised over mDNS.
 * NEVER put secrets/tokens/user data in here — it's plaintext on the LAN.
 */
export function buildMdnsTxt(cfg = readConfig()) {
  const name = (cfg?.discovery?.name && String(cfg.discovery.name).trim()) || DEFAULT_INSTANCE_NAME;
  return {
    name,
    ver: getPackageVersion(),
    sid: getOrCreateInstanceId(),
    api: '/api',
  };
}

/**
 * Start advertising the server over mDNS as `_openensemble._tcp.local`.
 * Safe to call even when discovery.mdns is off (no-op) or when mDNS can't
 * bind (port 5353 is often held by avahi-daemon on Linux) — any failure is
 * logged as a single warning and never throws or blocks the caller.
 * @param {number} serverPort - The HTTP/WS port (default 3737)
 */
export function startMdnsAdvertiser(serverPort = 3737) {
  if (_mdnsService) return; // already started

  let cfg;
  try { cfg = readConfig(); } catch { cfg = {}; }

  if (!isMdnsEnabled(cfg)) {
    console.log('[discovery] mDNS advertisement disabled (config discovery.mdns=false)');
    return;
  }

  if (!_getResponder) {
    console.warn('[discovery] mDNS unavailable (@homebridge/ciao not loaded) — skipping advertisement');
    return;
  }

  try {
    _mdnsResponder = _getResponder();
    const name = (cfg?.discovery?.name && String(cfg.discovery.name).trim()) || DEFAULT_INSTANCE_NAME;
    _mdnsService = _mdnsResponder.createService({
      name,
      type: MDNS_SERVICE_TYPE,
      port: serverPort,
      txt: buildMdnsTxt(cfg),
    });

    _mdnsService.on('name-change', (newName) => {
      console.log(`[discovery] mDNS service name changed to "${newName}" (conflict resolution)`);
    });

    _mdnsService.advertise()
      .then(() => {
        console.log(`[discovery] mDNS advertising _${MDNS_SERVICE_TYPE}._tcp on port ${serverPort}`);
      })
      .catch((e) => {
        console.warn(`[discovery] mDNS advertise failed (continuing without it): ${e.message}`);
      });
  } catch (e) {
    console.warn(`[discovery] Failed to start mDNS advertiser (continuing without it): ${e.message}`);
    _mdnsResponder = null;
    _mdnsService = null;
  }
}

/**
 * Stop mDNS advertisement — unpublishes the service (goodbye packets) and
 * frees the responder. Safe to call even if never started.
 */
export async function stopMdnsAdvertiser() {
  const service = _mdnsService;
  const responder = _mdnsResponder;
  _mdnsService = null;
  _mdnsResponder = null;
  try {
    if (service) await service.destroy();
  } catch (e) {
    console.warn(`[discovery] mDNS service shutdown warning: ${e.message}`);
  }
  try {
    if (responder) await responder.shutdown();
  } catch (e) {
    console.warn(`[discovery] mDNS responder shutdown warning: ${e.message}`);
  }
}
