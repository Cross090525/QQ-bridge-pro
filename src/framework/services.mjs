import crypto from 'node:crypto';
import { frameworkError, publicContentUrl } from './content.mjs';
import { ExtensionPermissions, permissionDigest } from './permissions.mjs';
import { RegisteredServiceTransport, normalizeServiceTransport } from './service-transport.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
function normalizeInputSchema(schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
      || Object.keys(schema).some(key => !['properties', 'required'].includes(key))
      || !schema.properties && schema.required?.length) throw frameworkError('服务 inputSchema 仅支持 properties 和 required');
  const properties = schema.properties ?? {};
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 16) throw frameworkError('服务 inputSchema 字段无效');
  for (const [name, field] of Object.entries(properties)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name) || ['constructor', 'prototype'].includes(name)
        || !field || Object.keys(field).some(key => !['type', 'maxLength', 'enum'].includes(key))
        || !['string', 'number', 'boolean'].includes(field.type)
        || field.maxLength !== undefined && (!Number.isSafeInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 8000)
        || field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 32
          || field.enum.some(value => typeof value !== field.type || typeof value === 'string' && value.length > 256))) throw frameworkError('服务 inputSchema 字段声明无效');
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(name => !own(properties, name))) throw frameworkError('服务 inputSchema.required 无效');
  return { properties, required };
}
function validateInput(schema, input) {
  for (const name of schema.required) if (!own(input, name)) throw frameworkError(`缺少服务参数 ${name}`);
  for (const [name, value] of Object.entries(input)) {
    const field = own(schema.properties, name) && schema.properties[name];
    if (!field || typeof value !== field.type || typeof value === 'number' && !Number.isFinite(value)
        || typeof value === 'string' && value.length > (field.maxLength ?? 2000)
        || field.enum && !field.enum.includes(value)) throw frameworkError(`服务参数 ${name} 不符合已注册 schema`);
  }
}
export function serviceDataScopes(service, source, input = {}) {
  return [...(source ? [service.inputMode === 'bytes' ? 'source-bytes' : 'source-reference'] : []), ...(Object.keys(input).length ? ['input'] : [])];
}
export function serviceManifest(service) {
  return { effect: service.effect, description: service.description,
    destination: service.transport.type === 'http' ? service.transport.url : '本机 MCP stdio 进程（其网络/文件权限由宿主管理）',
    entrypoint: service.transport.type === 'stdio' ? `${service.transport.command} ${service.transport.args.join(' ')} :: ${service.tool}` : 'HTTP POST',
    configHash: permissionDigest(service) };
}
export function normalizeServices(config = []) {
  if (!Array.isArray(config) || config.length > 24) throw frameworkError('framework.services 必须为至多 24 个服务');
  const ids = new Set();
  return config.filter(service => service?.enabled !== false).map(service => {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(service.id ?? '') || /^(bridge|memory)\./.test(service.id) || ids.has(service.id)) throw frameworkError('服务 id 无效、重复或占用保留前缀');
    ids.add(service.id);
    if (!Array.isArray(service.accepts) || !service.accepts.length
        || service.accepts.some(type => !['text', 'link', 'image', 'voice', 'video', 'file', 'sticker'].includes(type))) throw frameworkError(`服务 ${service.id} 的 accepts 无效`);
    const transport = normalizeServiceTransport(service.transport);
    if (transport.type === 'stdio' && (typeof service.tool !== 'string' || !service.tool)) throw frameworkError('stdio 服务需要 tool');
    if (service.hosts !== undefined && (!Array.isArray(service.hosts) || service.hosts.some(host => typeof host !== 'string'
        || !/^[a-z0-9.-]+$/i.test(host)))) throw frameworkError('hosts 必须为域名列表，不支持通配符');
    const timeoutMs = service.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) throw frameworkError('服务 timeoutMs 必须为 100~180000');
    if (service.effect !== undefined && !['read', 'generate', 'write', 'execute'].includes(service.effect)) throw frameworkError('服务 effect 无效');
    if (service.inputMode !== undefined && !['bytes', 'reference'].includes(service.inputMode)) throw frameworkError('服务 inputMode 无效');
    return { ...service, effect: service.effect ?? 'execute', inputSchema: normalizeInputSchema(service.inputSchema), timeoutMs,
      transport: { ...transport, ...(transport.type === 'stdio' ? { args: transport.args ?? [] } : {}) }, hosts: service.hosts?.map(host => host.toLowerCase()),
      description: String(service.description ?? '').slice(0, 240), inputHint: String(service.inputHint ?? '').slice(0, 500) };
  });
}

export function mapServiceArguments(template, source, input, depth = 0) {
  if (depth > 8) throw frameworkError('参数映射过深');
  if (typeof template === 'string' && template.startsWith('$')) {
    const match = /^\$(source|input)\.([A-Za-z0-9_]+)$/.exec(template);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[2])) throw frameworkError('无效的参数映射');
    const data = match[1] === 'source' ? source : input;
    if (!own(data, match[2])) throw frameworkError(`缺少映射参数 ${template}`);
    return data[match[2]];
  }
  if (Array.isArray(template)) return template.map(value => mapServiceArguments(value, source, input, depth + 1));
  if (template && typeof template === 'object') {
    const output = Object.create(null);
    for (const [name, value] of Object.entries(template)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) throw frameworkError('无效的参数名');
      output[name] = mapServiceArguments(value, source, input, depth + 1);
    }
    return output;
  }
  return template;
}

export class ContentServiceRuntime {
  constructor({ services = [], permissions = new ExtensionPermissions(), mediaStore, readSource, fetchImpl = globalThis.fetch } = {}) {
    this.services = normalizeServices(services);
    this.permissions = permissions;
    this.mediaStore = mediaStore;
    this.readSource = readSource;
    this.transport = new RegisteredServiceTransport({ fetchImpl });
    this.connections = this.transport.connections;
    this.cache = new Map();
    this.inflight = new Map();
  }
  list(source, { key } = {}) {
    return this.services.filter(service => (!source || this.matches(service, source))
      && this.permissions.inspect({ key, capability: service.id, manifest: serviceManifest(service), dataScopes: serviceDataScopes(service, source) }).decision !== 'deny').map(service => ({
      id: service.id, description: service.description, accepts: service.accepts,
      inputHint: service.inputHint, inputSchema: service.inputSchema, effect: service.effect,
      permission: this.permissions.decision(key, service.id, serviceManifest(service)).decision,
      inputMode: service.inputMode === 'bytes' ? 'bytes' : 'reference', timeoutMs: service.timeoutMs,
    }));
  }
  matches(service, source) {
    if (!service.accepts.includes(source.type)) return false;
    if (!service.hosts?.length) return true;
    if (!publicContentUrl(source.url)) return false;
    const host = new URL(source.url).hostname.toLowerCase();
    return service.hosts.some(allowed => host === allowed || host.endsWith('.' + allowed));
  }
  async connection(service) {
    return this.transport.connection(service);
  }
  async call({ key, scope, serviceId, source, input = {}, approvalId, assertLive = () => {} }) {
    const service = this.services.find(item => item.id === serviceId);
    if (!service) throw frameworkError('服务未配置或未启用', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 8000) throw frameworkError('input 必须为最多 8000 字符的对象');
    validateInput(service.inputSchema, input);
    if (source ? !this.matches(service, source) : !service.accepts.includes('text')) throw frameworkError('服务不支持此输入来源');
    if (!source && (typeof input.text !== 'string' || !input.text.trim())) throw frameworkError('文本服务需要 input.text');
    assertLive();
    const permit = this.permissions.authorize({ key, scope, capability: serviceId, manifest: serviceManifest(service), source, input, approvalId,
      dataScopes: serviceDataScopes(service, source, input), assertLive,
      currentManifest: () => serviceManifest(this.services.find(item => item.id === serviceId) ?? { effect: 'execute', description: '', transport: { type: 'http', url: '' } }) });
    if (permit.pending) return permit.pending;
    const checkPermit = () => { assertLive(); permit.check(); };
    const signature = crypto.createHash('sha256').update(JSON.stringify([scope, serviceId, source?.sourceId, input, this.permissions.revision, serviceManifest(service)])).digest('hex');
    const cached = this.cache.get(signature);
    if (cached && cached.expiresAt > Date.now()) { checkPermit(); permit.finish('cached'); return { ...cached.value, cached: true }; }
    // Never deduplicate approved side effects into a different execution.
    if (this.inflight.has(signature)) { permit.finish('busy'); throw frameworkError('相同内容服务请求正在执行', 409); }
    if (this.inflight.size >= 4) { permit.finish('busy'); throw frameworkError('识别服务繁忙，请稍后重试', 429); }
    let expired = false;
    let timer;
    const check = () => { if (expired) throw frameworkError('服务调用已超时', 504); checkPermit(); };
    const promise = Promise.race([
      this.execute(service, { scope, source, input, assertLive: check }),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(frameworkError('内容服务超时', 504)); }, service.timeoutMs); }),
    ]);
    this.inflight.set(signature, promise);
    try {
      const result = await promise;
      checkPermit();
      permit.finish('completed');
      if (['read', 'generate'].includes(service.effect) && service.cache !== false && !result.media.length && JSON.stringify(result).length <= 20000) {
        this.cache.set(signature, { value: result, expiresAt: Date.now() + 300000 });
        while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      }
      return result;
    } catch (error) {
      permit.finish(error?.statusCode === 403 ? 'revoked' : 'failed');
      if (error?.statusCode) throw error;
      if (error?.name === 'TimeoutError' || error?.code === -32001) throw frameworkError('内容服务超时', 504);
      throw frameworkError('内容服务调用失败，请检查服务配置或服务日志', 502);
    } finally { clearTimeout(timer); this.inflight.delete(signature); }
  }
  async execute(service, { scope, source, input, assertLive }) {
    assertLive();
    let serviceSource = source ? { sourceId: source.sourceId, type: source.type, messageId: source.messageId,
      ...(source.url ? { url: source.url } : {}), ...(source.platform ? { platform: source.platform } : {}) } : { type: 'text' };
    if (source && service.inputMode === 'bytes') serviceSource = { ...serviceSource, ...await this.readSource(source) };
    assertLive();
    const args = service.arguments ? mapServiceArguments(service.arguments, serviceSource, input) : { source: serviceSource, input };
    const raw = await this.transport.call(service, args, { assertLive });
    assertLive();
    if (raw?.isError) {
      // Only interpret a fixed error vocabulary. Never reflect arbitrary
      // provider error strings (which may contain signed URLs or credentials).
      let detail;
      try { detail = JSON.parse(raw.content?.find(block => block.type === 'text')?.text); } catch {}
      const reasons = { MEDIA_DOWNLOAD_LIMIT: '该视频超过下载体积上限', MEDIA_DURATION_LIMIT: '该视频时长超过支持范围',
        MEDIA_NO_VIDEO_TRACK: '该视频没有受支持的纯视频轨', MEDIA_FRAME_DECODE: '所选时间点未能解码出完整画面',
        MEDIA_PROCESSING_FAILED: '媒体处理失败，请检查网络、登录状态和解码运行时' };
      if (detail?.protocol === 'qq-bridge.media-error/v1' && Object.hasOwn(reasons, detail.code)) {
        const limit = detail.code === 'MEDIA_DOWNLOAD_LIMIT' && Number.isSafeInteger(detail.limitMiB) && detail.limitMiB >= 1 && detail.limitMiB <= 128 ? `（${detail.limitMiB} MiB）` : '';
        throw frameworkError(`内容服务处理失败 [${detail.code}]：${reasons[detail.code]}${limit}`, 502);
      }
      throw frameworkError('内容服务处理失败', 502);
    }
    const blocks = raw?.content;
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 12) throw frameworkError('服务需要返回 1~12 个 MCP content 项', 502);
    const content = []; const media = []; let textChars = 0; let mediaBytes = 0;
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = String(block.text ?? ''); textChars += text.length;
        if (textChars > 16000) throw frameworkError('服务文本超过 16000 字符', 413);
        content.push({ type: 'text', text });
      } else if (['image', 'audio'].includes(block.type)) {
        mediaBytes += Math.ceil(String(block.data ?? '').length * 3 / 4);
        if (mediaBytes > 8 * 1024 * 1024) throw frameworkError('服务媒体超过 8MB', 413);
        const handle = this.mediaStore.put(scope, block);
        media.push(handle);
        if (block.type === 'image') content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        else content.push({ type: 'text', text: `已生成语音，可用 mediaId=${handle.mediaId} 发送。` });
      } else throw frameworkError('服务只支持 text / image / audio 结果', 502);
    }
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter(item => ['metadata', 'transcript', 'frames', 'audio', 'video'].includes(item)) : [];
    return { serviceId: service.id, sourceId: source?.sourceId ?? null, content, media, evidence,
      note: evidence.length ? '按实际返回的证据评价；字幕/关键帧不代表看过整段视频。' : '服务未声明证据范围，只能依据实际返回内容作答。', cached: false };
  }
  async close() {
    await this.transport.close(); this.cache.clear();
  }
}
