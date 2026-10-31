import crypto from 'node:crypto';

const LINK_RE = /https?:\/\/[^\s<>"'\u3000]+/giu;
const TYPES = new Set(['text', 'link', 'image', 'voice', 'video', 'file', 'sticker']);
export class ContentSourceStore {
  constructor(records = [], { onChange = () => {}, ttlMs = 86400000 } = {}) {
    this.items = new Map(); this.onChange = onChange; this.ttlMs = ttlMs;
    if (!Array.isArray(records)) throw frameworkError('内容资源索引必须是数组');
    for (const record of records.slice(-1000)) {
      if (/^(group|private):[1-9]\d*$/.test(record?.key ?? '') && /^[a-f0-9]{32}$/.test(record?.sourceId ?? '')
          && TYPES.has(record.type) && Number(record.expiresAt) > Date.now()) this.items.set(record.sourceId, record);
    }
  }
  register(key, packet) {
    for (const source of packet.sources) this.items.set(source.sourceId, { ...source, key, expiresAt: Date.now() + this.ttlMs });
    for (const [id, source] of this.items) if (source.expiresAt <= Date.now()) this.items.delete(id);
    while (this.items.size > 1000) this.items.delete(this.items.keys().next().value);
    this.onChange([...this.items.values()]);
  }
  get(key, sourceId) {
    const source = this.items.get(sourceId);
    if (!source || source.key !== key || source.expiresAt <= Date.now()) throw frameworkError('内容引用不存在、已过期或不属于当前会话', 403);
    return source;
  }
}
export function frameworkError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function publicContentUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function platformOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com') ? 'bilibili' : null;
}

// Only classify here. No downloads, recognition, services or model calls on receipt.
export function normalizeIncomingContent(key, messageId, segments) {
  const content = [];
  const sources = [];
  const seenLinks = new Set();
  const raw = typeof segments === 'string' ? [{ type: 'text', data: { text: segments } }] : segments;
  const addSource = (type, data, label = '') => {
    const sourceId = crypto.createHash('sha256').update(JSON.stringify([key, String(messageId), sources.length, type, data])).digest('hex').slice(0, 32);
    const source = { sourceId, type, messageId: String(messageId ?? ''), ...data };
    const view = { type, sourceId, ...(label ? { label: String(label).slice(0, 160) } : {}) };
    if (data.url && (type === 'link' || data.platform === 'bilibili')) view.url = data.url;
    if (data.platform) view.platform = data.platform;
    content.push(view);
    sources.push(source);
  };
  const addLinks = text => {
    for (const match of String(text ?? '').matchAll(LINK_RE)) {
      const url = publicContentUrl(match[0].replace(/[，。！？；、）)\]}]+$/u, ''));
      if (!url || seenLinks.has(url)) continue;
      seenLinks.add(url);
      addSource('link', { url, platform: platformOf(url) }, '链接');
    }
  };
  const scanCard = (value, depth = 0) => {
    if (depth > 5) return;
    if (typeof value === 'string') { addLinks(value.slice(0, 8000)); return; }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value).slice(0, 40)) scanCard(item, depth + 1);
    }
  };
  for (const segment of (Array.isArray(raw) ? raw : []).slice(0, 80)) {
    const data = segment?.data ?? {};
    if (segment?.type === 'text') {
      const text = String(data.text ?? '');
      if (text) content.push({ type: 'text', text: text.slice(0, 1000) });
      addLinks(text);
    } else if (segment?.type === 'json') {
      try { scanCard(JSON.parse(String(data.data ?? '').slice(0, 32000))); } catch {}
    } else if (segment?.type === 'xml') {
      addLinks(String(data.data ?? '').slice(0, 32000));
    } else {
      const type = ({ record: 'voice', image: data.emoji_id || data.sub_type === 1 ? 'sticker' : 'image',
        mface: 'sticker', face: 'sticker', video: 'video', file: 'file' })[segment?.type];
      if (!type) continue;
      addSource(type, {
        url: publicContentUrl(data.url), file: typeof data.file === 'string' ? data.file.slice(0, 2000) : '',
        faceId: segment.type === 'face' ? String(data.id ?? '') : '',
        ...(type === 'image' || type === 'sticker' ? {
          emojiId: String(data.emoji_id ?? '').slice(0, 128), subType: String(data.sub_type ?? '').slice(0, 16),
          summary: String(data.summary ?? '').slice(0, 160),
        } : {}),
        duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : null,
      }, data.summary || data.name || type);
    }
    if (sources.length >= 24) break;
  }
  return { content, sources };
}

// One explicit output per operation; multi-bubble scheduling stays in bridge.
export function normalizeOutgoingContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !TYPES.has(input.type)) throw frameworkError('无效的消息类型');
  if (input.type === 'text') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw frameworkError('text 必须为 1~8000 字符');
    return { type: 'text', messages: input.text };
  }
  if (input.type === 'link') {
    const url = publicContentUrl(input.url);
    if (!url || url.length > 2000) throw frameworkError('无效的链接 URL');
    const title = typeof input.title === 'string' ? input.title.slice(0, 200) : '';
    return { type: 'link', messages: title ? `${title}\n${url}` : url };
  }
  if (input.type === 'sticker' && typeof input.stickerId === 'string' && input.stickerId.trim()) {
    return { type: 'sticker', stickerId: input.stickerId.trim() };
  }
  if (input.type === 'voice' && typeof input.voice === 'string' && input.voice.trim()) {
    return { type: 'voice', voice: input.voice.trim() };
  }
  if (['voice', 'image', 'sticker'].includes(input.type) && /^[a-f0-9]{32}$/.test(input.mediaId ?? '')) {
    return { type: input.type, mediaId: input.mediaId };
  }
  throw frameworkError('该消息需要有效的 mediaId、语音库文件名或 stickerId；不接受任意本机路径');
}
