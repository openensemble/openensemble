/**
 * LAN Discovery Beacon — broadcasts OpenEnsemble server presence via UDP.
 * Node agents listen for these broadcasts to auto-discover the server.
 * Uses UDP broadcast on port 3738 — no external dependencies needed.
 */

import dgram from 'dgram';
import os from 'os';

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
