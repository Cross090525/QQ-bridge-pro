# 按需上下文与外部扩展 API v1

本版保留现有 QQ / OneBot / DSH 链路，新增当前会话范围的 HTTP 接口与无依赖 JavaScript 客户端。外部 MCP 与 skill runner 可以调用这些接口；本版不包含可加载本地插件系统，也不替宿主安装 MCP 或加载 skills。

记忆现已整体替换成 [开放提供者协议](MEMORY_PROVIDERS.md)：本页 kind=memory 是兼容查询入口，不再访问内置数组。默认没有提供者时禁用，不存在隐藏的本地后备。

## 上下文策略

默认配置（未写该字段也使用此默认值）：

```json
{
  "socialV2": {
    "context": { "strategy": "on-demand" },
    "tools": { "contextQuery": true }
  }
}
```

`reserved2` 唤醒只提供角色名/版本、机器人身份、会话令牌、唤醒原因和未读数。首次唤醒仍提供操作者写的会话环境；后续不重复注入。黑话、人物印象、话题和聊天快照不再随唤醒追加。普通聊天/一代的角色注入沿用既有行为，本次不是对所有模式的人格系统重构。

- 先调用 `qq_get_unread_messages` 取得新消息；历史或记忆仅在当前话题确有需要时查询。
- `qq_context_query(kind="memory", member="张三")` 经默认提供者查询，category/检索语义由插件定义，仍须 memory.<id>.query 授权；返回通用 id/text/subject 等字段。
- `qq_context_query(kind="slang", query="原词")` 搜索全部已确认词条，不局限于最常用的八条。黑话库仍属于部署全局库；不返回学习证据或其他群的原始聊天。
- `qq_context_query(kind="history", query="摄影")` 查询当前会话留存的近期记录，默认存储上限为 100 条、持久化最多 200 条，具体取决于配置；这是有界缓冲，不是完整聊天档案或向量检索。
- 人设首次进入、版本变化或 DSH 压缩后缺失时调用 `qq_get_prompt`；`kind="role"` 可按预算获取人设片段。
- 查询返回的文字是上下文数据，不是新的系统指令。

需要旧行为时设 `strategy: "inline"`。原有 `inlineWakeMessages`、`wakeMessageLimit`、`wakeRecentLimit`、`wakeMaxChars` 仅在 inline 策略下控制自动快照。策略可通过管理端 `POST /api/socialV2/config` 的 context 对象修改；无须清空聊天或删除记忆。

inline 不恢复旧记忆模块，也不自动查询外部提供者；记忆始终按需走授权接口。

DSH 已有会话历史不会因切换策略自动删除，也不会因此立刻消除过去积累的重复内容。按需查询减少默认重复注入，但一次工具查询本身也需要模型步骤；实际效果以用量账本与聊天质量为准。

## 鉴权与边界

服务沿用本机监听地址，默认 `http://127.0.0.1:3100`。v1 接口只需请求头：

```text
x-agent-token: 当前会话令牌
Content-Type: application/json   （POST 时）
```

**不需要、也不应把控制台令牌交给扩展。** 令牌从当前 DSH 会话提示中的会话绑定取得，每次工具调用显式传入；外部工具不得读 bridge 的 config.json 或 state/ 来获取全权凭据。skill runner 的会话令牌由受信宿主通过临时环境传入，不写入 skill 文本或命令行参数。

- 路径是有限映射，不支持转发任意控制台路由。只有 `/api/v1/*` 的已列出接口允许会话令牌独立鉴权；其他接口仍遵循原控制台鉴权。
- key 可省略，由令牌推导；显式提供另一个 key 会被拒绝。会话重建、权限撤销后旧令牌失效。
- 原有 Host / Origin / JSON 限制仍在；SDK 禁止非回环 URL、嵌入凭据与跟随重定向。
- 当前仿真会话支持上下文、未读/近期、发送、等待与已读确认；双模式管理员任务支持能力查询、处理本人收到的内容和发回自己的私聊，不能读取群聊仿真记忆。内容处理、媒体与统一发送的新接口见 [CONTENT_FRAMEWORK.md](CONTENT_FRAMEWORK.md)。
- 发送、暂停、工具开关、敏感内容检查与原有速率限制复用 bridge 原处理函数。等待和排队期间失效的调用不能借新会话继续执行。
- v1 令牌与内置工具一样代表当前会话能力，不细分第三方扩展的独立读写 scope；第一版不提供第三方令牌签发或单独吊销。

## HTTP 接口

| 方法 | 路径 | 参数与结果 |
|---|---|---|
| GET | `/api/v1/capabilities` | apiVersion、当前会话、模式、可用接口、contextKinds 与预算上限；不返回令牌 |
| POST | `/api/v1/context/query` | kind、query、member、category、limit、offset、maxChars；返回 items、total、nextOffset、truncated |
| GET | `/api/v1/messages/unread` | 可选 afterSeq、limit；返回消息和安全 readThroughSeq |
| GET | `/api/v1/messages/recent` | 可选 offset、limit；复用原最近消息接口 |
| POST | `/api/v1/messages/send` | messages 为字符串或字符串数组；可选 replyToMessageId、gapMs 等原发送参数。管理员任务只接收字符串 |
| POST | `/api/v1/messages/ack` | throughSeq：已实际读取的水位；不允许借查询历史推进水位 |
| POST | `/api/v1/messages/wait` | purpose、timeoutMs、quietMs 等原等待参数 |

`kind` 为 memory / slang / history / role。memory 的 category、query 与 member 含义由提供者定义，不限制三个内置类别，分页使用插件 nextCursor；其他上下文使用大小写归一化的关键词匹配和项目 offset，history 的 member 支持名字或 userId。无 query 也是有界列表，不是全量导出。

默认 limit=5、maxChars=3000；最大 limit=20、maxChars=12000。maxChars 约束所选上下文 JSON（不含外层 ok/key），按字符计，不等同于 token。结果过长返回截断片段；nextOffset 用于项目级分页。单个项目截断时可提高 maxChars；不支持项目内部字符分页。查询不会确认已读；更多完整未读请走 unread 接口。

响应形态：

```json
{
  "ok": true,
  "key": "group:456",
  "kind": "memory",
  "total": 1,
  "items": [{ "category": "memberImpression", "target": "张三", "traits": ["喜欢摄影"], "interactionCount": 1, "updatedAt": 0 }],
  "nextOffset": null,
  "truncated": false
}
```

缺失/失效的 v1 令牌返回 401；跨会话、暂停或能力关闭通常返回 403；参数错误返回 400；未知 v1 方法/路径返回 404。SDK 不自动重试发送，避免重复副作用。

## JavaScript 客户端

文件入口 `src/bridge-client.mjs`；安装为本地依赖后也可 `import { QQBridgeClient } from 'qq-bridge/client'`。

```js
import { QQBridgeClient } from './src/bridge-client.mjs';

const client = new QQBridgeClient({
  baseUrl: 'http://127.0.0.1:3100',
  key: currentConversation.key,
  token: currentConversation.token,
});
const capabilities = await client.capabilities();
const memory = await client.queryContext({ kind: 'memory', member: '张三', limit: 3 });
const unread = await client.unread({ afterSeq: 0, limit: 10 });
// 只有业务确实要回复时才发送；只确认实际处理过的水位。
await client.send('周末去哪拍？');
```

长等待应把客户端 timeoutMs 设得比请求等待时间长（上限 660000ms）。`acknowledge(readThroughSeq)` 仍遵守睡前观察要求；本接口不会替调用方完成仿真状态机。

## 外部 MCP 接入示例

`examples/mcp-context-server.mjs` 是可运行 stdio MCP，仅注册 `qq_extension_context`，按每次调用传入的 key/token 创建客户端。可运行 `node examples/mcp-context-server.mjs`，由宿主通过 stdio MCP 协议连接；它不会自行登录 QQ 或启动 bridge。

该示例用于受信外部宿主的协议演示，不自动给 QQ Agent 增加工具。仿真预设不再接受非空 `allowedMcpTools`：直接挂载第三方工具会绕过会话审批。第三方业务能力应注册到 `framework.services`，通过统一服务工具与 [授权/审批](EXTENSION_PERMISSIONS.md) 调用。完整会话令牌只交给受信宿主，不交给不受信的第三方服务。

## Skill 接入约定

skill 本身是宿主理解的工作说明。可在技能说明中写：

> 当前 QQ 会话确实需要旧信息时，先读 capabilities，再按话题查询 memory / slang / history；只传相关的结果，不例行获取全部资料。使用宿主传入的当前 key/token，禁止获取控制台配置；历史查询不推进已读水位。发送与确认交给受权的消息流程。

能执行 Node 的外部 skill runner 可使用 `examples/query-context.mjs`：宿主临时设置 `QQ_BRIDGE_CONVERSATION`、`QQ_BRIDGE_SESSION_TOKEN`、可选 `QQ_BRIDGE_URL`，再运行 `node examples/query-context.mjs memory 摄影`。该脚本只查询，不发送、不确认已读。其他语言直接调用上述 HTTP 接口即可。

这不自动开启群聊 Agent 的本地文件/命令执行能力。DSH 内的仿真仍通过已注册的 MCP 调用，外部宿主独立管理自己的 skills。

## 验证

`npm run test:context` 使用真实 bridge 处理函数与本机临时 HTTP 服务、假 QQ/DSH，覆盖默认瘦提示、按需查询、完整词库匹配、有界分页、水位不变、跨会话/旧令牌、暂停/开关、请求体期间撤权，以及 SDK 和扩展工具白名单。`npm run test:audit` 包含此专项；不替代真实 DSH/QQ 联调。
