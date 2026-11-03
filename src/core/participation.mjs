// Conversation relationships come from gateway segments, never from quoted text.
const userId = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) ? String(value) : null;
export function normalizeAddressing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    mentionedUserIds: [...new Set((Array.isArray(value.mentionedUserIds) ? value.mentionedUserIds : []).map(userId).filter(Boolean))].slice(0, 20),
    mentionsSelf: value.mentionsSelf === true, mentionsAll: value.mentionsAll === true,
    replyTarget: ['none', 'self', 'other', 'unknown'].includes(value.replyTarget) ? value.replyTarget : 'unknown',
    replyToUserId: userId(value.replyToUserId),
  };
}

export function messageAddressing(segments, selfId, replyInfo = null, quoteTargetIsSelf = false) {
  const list = Array.isArray(segments) ? segments : [];
  const ids = list.filter(s => s?.type === 'at').map(s => String(s.data?.qq ?? ''));
  const reply = list.find(s => s?.type === 'reply' && s.data?.id != null);
  const target = userId(replyInfo?.userId), self = userId(selfId);
  return normalizeAddressing({ mentionedUserIds: ids, mentionsSelf: !!self && ids.includes(self), mentionsAll: ids.includes('all'),
    replyTarget: !reply ? 'none' : target && self ? (target === self ? 'self' : 'other') : quoteTargetIsSelf ? 'self' : 'unknown',
    replyToUserId: target });
}

const GROUP_GUIDANCE = '【群聊参与边界】观察到消息只表示可以理解，不表示有人在对你说话。先看实际@对象、引用对象和前后对话：addressing.mentionedUserIds/mentionsSelf/replyTarget是网关提供的指向，replyTarget=unknown表示未能确认，不可猜成自己。问号、“你”、出现你的名字、你感兴趣、你刚说过话，都不足以单独认定在叫你；第三人称评价也不是邀请。明确@或引用他人的消息默认observe，不代替对方回答，不把别人的“你”认成自己，不抢两人之间的对话。明确叫你、确实接着与你交流，或者开放话题中你有具体新信息且不会打断别人时，才考虑回复。关系不明先观察；自然插话应少而有价值，不能只为接梗、重复或证明自己在场。普通图片、视频或链接分享也不要求你报告解析状态或点评。选择观察时安静确认已读或继续等待，不发送“与我无关”“我潜水了”等说明。被唤醒、随机触发、普通提问、媒体准备完成都不是发言命令；人设决定怎么说，不能替代要不要说的判断。';
const PRIVATE_GUIDANCE = '【私聊参与边界】对方当前发给你的话通常可以直接回应，结合语境保持自然节奏；引用、转发或提及第三人时仍须区分原话的对象，不能把引用内容里的“你”自动认成自己。';

export function participationContext(key) {
  const group = String(key).startsWith('group:');
  return { conversationType: group ? 'group' : 'private', defaultAction: group ? 'observe' : 'consider_reply',
    guidance: group ? GROUP_GUIDANCE : PRIVATE_GUIDANCE };
}
