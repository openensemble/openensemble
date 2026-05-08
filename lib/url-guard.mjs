/**
 * Outbound-URL SSRF guard. Reject URLs whose resolved host is in a private,
 * loopback, link-local, or otherwise-internal range so the LLM (or watchers
 * driven by external content) can't be coerced into hitting cloud metadata
 * endpoints, LAN admin pages, Tailnet hosts, or the OE server itself.
 *
 * Use isUrlSafe() before any fetch() whose URL is influenced by user input,
 * LLM output, or external content (emails, web pages, watcher payloads).
 */

import dns from 'dns/promises';
import net from 'net';

export function isBlockedIP(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (Tailscale)
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    if (v.startsWith('fe80:')) return true;            // link-local
    if (v.startsWith('ff')) return true;               // multicast
    // IPv4-mapped: ::ffff:a.b.c.d → check the embedded v4
    const m = v.match(/^::ffff:([\d.]+)$/);
    if (m && net.isIPv4(m[1])) return isBlockedIP(m[1]);
    return false;
  }
  return true;
}

export async function isUrlSafe(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${u.protocol} not allowed` };
  }
  if (net.isIP(u.hostname) && isBlockedIP(u.hostname)) {
    return { ok: false, reason: `blocked IP ${u.hostname}` };
  }
  try {
    const records = await dns.lookup(u.hostname, { all: true });
    for (const r of records) {
      if (isBlockedIP(r.address)) return { ok: false, reason: `${u.hostname} resolves to private IP ${r.address}` };
    }
  } catch (e) {
    return { ok: false, reason: `DNS lookup failed: ${e.message}` };
  }
  return { ok: true };
}
