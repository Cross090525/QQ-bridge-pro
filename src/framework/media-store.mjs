import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { looksLikeImageBuffer } from '../safe-fetch.js';
import { frameworkError } from './content.mjs';

const MIMES = {
  'audio/wav': ['voice', 'wav'], 'audio/x-wav': ['voice', 'wav'], 'audio/mpeg': ['voice', 'mp3'],
  'audio/ogg': ['voice', 'ogg'], 'audio/flac': ['voice', 'flac'],
  'image/png': ['image', 'png'], 'image/jpeg': ['image', 'jpg'], 'image/gif': ['image', 'gif'], 'image/webp': ['image', 'webp'],
};
export function decodeMedia(data, mimeType, maxBytes = 8 * 1024 * 1024) {
  const spec = MIMES[mimeType];
  if (!spec || typeof data !== 'string' || data.length > Math.ceil(maxBytes / 3) * 4 + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw frameworkError('媒体类型、base64 或体积无效');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.length > maxBytes) throw frameworkError('媒体为空或超过体积上限', 413);
  const head = buffer.toString('ascii', 0, 12);
  const valid = spec[0] === 'image' ? looksLikeImageBuffer(buffer) && ({
    png: buffer.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])),
    jpg: buffer[0] === 0xff && buffer[1] === 0xd8,
    gif: head.startsWith('GIF87a') || head.startsWith('GIF89a'),
    webp: head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP',
  })[spec[1]]
    : spec[1] === 'wav' ? head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE'
      : spec[1] === 'ogg' ? head.startsWith('OggS')
        : spec[1] === 'flac' ? head.startsWith('fLaC')
          : head.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (!valid) throw frameworkError('媒体内容与声明类型不符');
  return { buffer, type: spec[0], extension: spec[1], mimeType };
}

// Uploads have opaque IDs bound to the current session lease. No caller paths.
export class FrameworkMediaStore {
  constructor({ directory, ttlMs = 3600000, maxBytes = 64 * 1024 * 1024, validateImage = () => {} } = {}) {
    this.directory = path.resolve(directory);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.items = new Map();
    this.validateImage = validateImage;
  }
  prune(now = Date.now()) {
    if (fs.existsSync(this.directory)) {
      if (fs.lstatSync(this.directory).isSymbolicLink()) throw frameworkError('媒体目录不能是符号链接', 403);
      // Only exact generated filenames in this owned directory are eligible.
      // Also reclaim expired files left by an earlier bridge process.
      for (const name of fs.readdirSync(this.directory)) {
        if (!/^[a-f0-9]{32}\.(wav|mp3|ogg|flac|png|jpg|gif|webp)$/.test(name)) continue;
        const file = path.join(this.directory, name);
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs + this.ttlMs <= now) {
          try { fs.unlinkSync(file); } catch {}
          this.items.delete(name.split('.')[0]);
        }
      }
    }
    for (const [id, item] of this.items) if (item.expiresAt <= now) {
      try { fs.unlinkSync(item.path); } catch {}
      this.items.delete(id);
    }
  }
  put(scope, media) {
    this.prune();
    const decoded = decodeMedia(media.data, media.mimeType);
    if (decoded.type === 'image' && this.validateImage(decoded.buffer) === null) throw frameworkError('图片像素或格式超出限制');
    const total = fs.existsSync(this.directory) ? fs.readdirSync(this.directory).reduce((sum, name) => {
      const stat = fs.lstatSync(path.join(this.directory, name));
      return sum + (stat.isFile() ? stat.size : 0);
    }, 0) : 0;
    if (total + decoded.buffer.length > this.maxBytes || this.items.size >= 128) throw frameworkError('临时媒体容量已满', 429);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(16).toString('hex');
    const file = path.join(this.directory, `${id}.${decoded.extension}`);
    fs.writeFileSync(file, decoded.buffer, { flag: 'wx', mode: 0o600 });
    const item = { mediaId: id, type: decoded.type, mimeType: decoded.mimeType, bytes: decoded.buffer.length,
      scope, path: file, expiresAt: Date.now() + this.ttlMs };
    this.items.set(id, item);
    return this.public(item);
  }
  get(scope, id) {
    this.prune();
    const item = this.items.get(id);
    if (!item || item.scope !== scope) throw frameworkError('媒体不存在、已过期或不属于当前会话', 403);
    const stat = fs.lstatSync(item.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || path.dirname(fs.realpathSync(item.path)) !== fs.realpathSync(this.directory)) throw frameworkError('媒体文件已变化', 403);
    return item;
  }
  public(item) { return { mediaId: item.mediaId, type: item.type, mimeType: item.mimeType, bytes: item.bytes, expiresAt: item.expiresAt }; }
}
