import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { validateFetchUrl } from '../src/safe-fetch.js';

export function bilibiliNetworkHost(host) {
  return ['bilibili.com', 'b23.tv', 'hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'bilivideo.net']
    .some(base => host === base || host.endsWith('.' + base));
}
export function mediaRequestHeaders(url, supplied = {}) {
  const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', 'accept-encoding': 'identity' };
  for (const [name, value] of new Headers(supplied)) {
    if (['user-agent', 'referer', 'accept', 'content-type', 'cache-control'].includes(name)) headers[name] = value;
    if (name === 'cookie' && url.hostname === 'api.bilibili.com') headers.cookie = value;
  }
  headers.host = url.host;
  return headers;
}

function request(url, address, options, maxBytes) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({ hostname: address, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: options.method || 'GET', headers: mediaRequestHeaders(url, options.headers),
      servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, signal: options.signal }, res => {
      const status = res.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        resolve({ status, location: res.headers.location }); res.destroy(); return;
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        reject(Object.assign(Error('B站响应超过大小限制'), { code: 'MEDIA_DOWNLOAD_LIMIT', limitMiB: maxBytes / 1048576 })); res.destroy(); return;
      }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(Object.assign(Error('B站响应超过大小限制'), { code: 'MEDIA_DOWNLOAD_LIMIT', limitMiB: maxBytes / 1048576 })); return; }
        chunks.push(chunk);
      });
      res.on('error', reject); res.on('aborted', () => reject(Error('B站响应中断')));
      res.on('end', () => resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

// Used only inside the dedicated media MCP process, not the bridge's global fetch.
// Pin every request to a checked public IP; cookies never follow media/CDN hops.
export async function bilibiliFetch(raw, options = {}, { maxBytes = 4 * 1024 * 1024, timeoutMs = 20000, validate = validateFetchUrl, requestImpl = request } = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw Error('B站只支持读取或转写请求');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  if (options.body && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > 32768)) throw Error('B站请求体无效');
  let current = String(raw);
  for (let i = 0; i <= 3; i++) {
    const candidate = new URL(current);
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port && candidate.port !== '443'
        || !bilibiliNetworkHost(candidate.hostname)) throw Error('非允许的B站地址');
    if (method === 'POST' && (candidate.hostname !== 'member.bilibili.com' || candidate.pathname !== '/x/bcut/rubick-interface/task')) throw Error('非允许的转写接口');
    signal.throwIfAborted();
    const { url, addresses } = await validate(candidate.href);
    if (method === 'POST') {
      const resource = new URL(JSON.parse(options.body || '{}').resource);
      if (resource.protocol !== 'https:' || resource.username || resource.password || resource.port && resource.port !== '443' || !bilibiliNetworkHost(resource.hostname)) throw Error('转写音轨地址无效');
      await validate(resource.href);
    }
    let result, error;
    for (const address of addresses.slice(0, method === 'GET' ? 2 : 1)) {
      signal.throwIfAborted();
      try { result = await requestImpl(url, address, { ...options, method, signal }, maxBytes); break; }
      catch (e) { error = e; }
    }
    if (!result) throw error || Error('B站无可用网络地址');
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (method !== 'GET' || !result.location) throw Error('转写请求不允许重定向');
      current = new URL(result.location, url).href; continue;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers || {})) {
      if (['content-type', 'content-length'].includes(name) && value !== undefined) headers.set(name, String(value));
    }
    const response = new Response([204, 205, 304].includes(result.status) ? null : result.bytes, { status: result.status, headers });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }
  throw Error('B站链接重定向过多');
}
