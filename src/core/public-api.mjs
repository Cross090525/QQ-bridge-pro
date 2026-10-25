// Versioned, finite aliases. No arbitrary forwarding to console/admin endpoints.
export const BRIDGE_API_VERSION = '1';
export const PUBLIC_API_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/v1/memory/providers', target: '/api/memory/providers', flag: 'memory' },
  ...['query', 'write', 'update', 'delete', 'clear', 'ingest'].map(operation => ({ method: 'POST', path: `/api/v1/memory/${operation}`, target: `/api/memory/${operation}`, flag: 'memory' })),
  { method: 'GET', path: '/api/v1/content/services', target: '/api/socialV2/content-services', flag: 'contentServices' },
  { method: 'POST', path: '/api/v1/content/process', target: '/api/socialV2/content-process', flag: 'contentServices' },
  { method: 'POST', path: '/api/v1/content/send', target: '/api/socialV2/content-send', flag: 'contentSend' },
  { method: 'GET', path: '/api/v1/media/read', target: '/api/socialV2/content-media', flag: 'contentServices' },
  { method: 'POST', path: '/api/v1/media/upload', target: '/api/socialV2/content-upload', flag: 'contentServices' },
  { method: 'GET', path: '/api/v1/capabilities', target: '/api/bridge/capabilities', flag: null },
  { method: 'POST', path: '/api/v1/context/query', target: '/api/socialV2/context-query', flag: null },
  { method: 'GET', path: '/api/v1/messages/unread', target: '/api/socialV2/unread', flag: 'getUnread' },
  { method: 'GET', path: '/api/v1/messages/recent', target: '/api/socialV2/recent', flag: 'getRecent' },
  { method: 'POST', path: '/api/v1/messages/send', target: '/api/socialV2/send-message', flag: 'sendMessage' },
  { method: 'POST', path: '/api/v1/messages/ack', target: '/api/socialV2/mark-read', flag: 'markRead' },
  { method: 'POST', path: '/api/v1/messages/wait', target: '/api/socialV2/wait', flag: 'waitMessages' },
]);

export function resolvePublicApiRoute(method, pathname) {
  return PUBLIC_API_ROUTES.find(route => route.method === method && route.path === pathname) ?? null;
}
