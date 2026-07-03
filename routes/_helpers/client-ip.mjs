// @ts-check
/**
 * routes/_helpers/client-ip.mjs
 *
 * Resolve the real client IP for rate-limiting. The naive
 * `x-forwarded-for.split(',')[0]` is client-forgeable — any caller can send an
 * X-Forwarded-For header and rotate it per request to defeat the login / invite
 * / password limiters. The rule here: only honour forwarding headers when the
 * request actually arrived from a proxy we trust; otherwise use the socket peer
 * address, which cannot be spoofed.
 *
 * Pure (no config import) so it's testable and can't create an import cycle —
 * the trusted-proxy list is passed in by the caller (getClientIp in
 * _helpers.mjs reads it from config).
 */

/** Strip the IPv4-mapped-IPv6 prefix so 127.0.0.1 matches ::ffff:127.0.0.1. */
function normalizeIp(ip) {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/i, '').trim();
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || !/^\d+$/.test(p)) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

/** Does `ip` equal `entry`, or fall inside it if `entry` is an IPv4 CIDR? */
function ipMatches(ip, entry) {
  const a = normalizeIp(ip);
  const e = normalizeIp(entry);
  if (!e) return false;
  if (!e.includes('/')) return a.toLowerCase() === e.toLowerCase(); // exact (IPv4 or IPv6)
  const [net, bitsStr] = e.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(a);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/** True if `ip` matches any exact IP or IPv4 CIDR in `list`. */
export function ipInList(ip, list) {
  return Array.isArray(list) && list.some(entry => {
    try { return ipMatches(ip, entry); } catch { return false; }
  });
}

const looksLikeIp = (ip) => /^[0-9a-fA-F:.]{3,45}$/.test(ip);

/**
 * @param {import('http').IncomingMessage} req
 * @param {string[]} trustedProxies  exact IPs and/or IPv4 CIDRs
 * @returns {string} the client IP (never a header value from an untrusted peer)
 */
export function resolveClientIp(req, trustedProxies) {
  const socketIp = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  // Direct connection (not from a trusted proxy) → the socket peer IS the
  // client, and any forwarding header is forged. Use the socket, ignore headers.
  if (!ipInList(socketIp, trustedProxies)) return socketIp;

  // Behind a trusted proxy — take the real client from a trusted header.
  const cf = normalizeIp(req.headers['cf-connecting-ip']);
  if (cf && looksLikeIp(cf)) return cf;

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    // Walk right→left: proxies append the peer they saw, so the rightmost entry
    // that isn't itself a trusted proxy is the true client. The leftmost is the
    // spoofable end the old code wrongly trusted.
    const parts = String(xff).split(',').map(normalizeIp).filter(p => p && looksLikeIp(p));
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!ipInList(parts[i], trustedProxies)) return parts[i];
    }
    if (parts.length) return parts[parts.length - 1];
  }
  return socketIp;
}
