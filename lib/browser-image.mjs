// @ts-check
/** DNS-pinned, cookie-free selected-image fetch for one-shot browser asks. */

import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { isBlockedIP } from './url-guard.mjs';

const MAX_IMAGE_BYTES = 1_200_000;
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 15_000;

function isUnsafeAddress(address) {
  if (isBlockedIP(address)) return true;
  if (!net.isIPv6(address)) return false;
  const value = address.toLowerCase();
  // Cover compressed IPv4-mapped literals and the full fe80::/10 range.
  if (value.startsWith('::')) return true;
  const firstHextet = Number.parseInt(value.split(':', 1)[0] || '0', 16);
  return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}

function pinnedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!addresses?.length || addresses.some(row => isUnsafeAddress(row.address))) {
      callback(new Error('selected image host resolves to a private or unsafe address'));
      return;
    }
    const chosen = addresses[0];
    if (options?.all) callback(null, [chosen]);
    else callback(null, chosen.address, chosen.family);
  });
}

function validateUrl(value, { requireHttps = false } = {}) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('selected image URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('selected image URL is not allowed');
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error('selected image URL must use HTTPS');
  }
  // Node may bypass a custom lookup callback for literal IPs, so validate the
  // literal before request construction as well as checking every DNS answer.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && isUnsafeAddress(hostname)) {
    throw new Error('selected image URL points to a private or unsafe address');
  }
  return url;
}

/** @param {URL} url @param {any} [deps] */
function requestOnce(url, {
  requestHttp = http.request,
  requestHttps = https.request,
  accept = '*/*',
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: accept,
        'User-Agent': 'OpenEnsemble-Bridge/1.0',
      },
      lookup: pinnedLookup,
      timeout: TIMEOUT_MS,
      signal: requestSignal,
    }, response => resolve(response));
    request.on('timeout', () => request.destroy(new Error('selected image request timed out')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * @param {unknown} rawUrl
 * @param {{maxBytes:number,mimePattern:RegExp,label:string,accept?:string,requireHttps?:boolean,signal?:AbortSignal|null}} policy
 * @param {any} [deps]
 */
export async function fetchBrowserPublicResource(rawUrl, policy, deps = {}) {
  const maxBytes = Math.max(1, Number(policy?.maxBytes) || 0);
  const label = String(policy?.label || 'resource');
  if (!(policy?.mimePattern instanceof RegExp)) throw new Error('resource MIME policy is required');
  const urlPolicy = { requireHttps: policy?.requireHttps === true };
  let url = validateUrl(rawUrl, urlPolicy);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await requestOnce(url, {
      ...deps,
      accept: policy.accept || '*/*',
      signal: policy.signal ?? deps.signal ?? null,
    });
    const status = Number(response.statusCode || 0);
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirect === MAX_REDIRECTS) throw new Error(`${label} redirected too many times`);
      url = validateUrl(new URL(response.headers.location, url).href, urlPolicy);
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new Error(`${label} fetch failed (${status || 'unknown status'})`);
    }
    const mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!policy.mimePattern.test(mimeType)) {
      response.resume();
      throw new Error(`selected URL did not return a supported ${label}`);
    }
    const declared = Number(response.headers['content-length'] || 0);
    if (declared > maxBytes) {
      response.resume();
      throw new Error(`${label} is too large`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        throw new Error(`${label} is too large`);
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) throw new Error(`${label} was empty`);
    return {
      name: url.pathname.split('/').filter(Boolean).at(-1)?.slice(0, 100) || `selected-${label}`,
      mimeType,
      bytes,
      sourceUrl: `${url.origin}${url.pathname}`,
    };
  }
  throw new Error(`${label} fetch failed`);
}

export async function fetchBrowserSelectedImage(rawUrl, deps = {}) {
  const result = await fetchBrowserPublicResource(rawUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    mimePattern: /^image\/(?:png|jpe?g|webp|gif)$/,
    label: 'selected image',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
  }, deps);
  return { ...result, base64: result.bytes.toString('base64'), bytes: undefined };
}

export const BROWSER_IMAGE_LIMITS = Object.freeze({ maxBytes: MAX_IMAGE_BYTES, maxRedirects: MAX_REDIRECTS });
export const __test = Object.freeze({ validateUrl, pinnedLookup, isUnsafeAddress });
