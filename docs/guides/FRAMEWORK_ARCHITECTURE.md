# QQ-bridge 开放框架架构

按当前实现整理，更新于 2026-10-25。本文区分框架能力、部署配置和未实现功能；不是未来功能清单。相关代码版本：媒体分段取证 `d0e6fff`、管理员QQ审批通知 `5561b2f`。

## 1. 总体分层与主调用链

```mermaid
flowchart TB
  subgraph QQ[QQ 与网关]
    Member[群成员 / 私聊用户]
    Owner[管理员 QQ]
    Gateway[SnowLuma / OneBot\nQQ 登录与消息收发]
    Member <-->|文字 / 图片 / 动图 / 视频 / 语音 / 分享卡片| Gateway
    Owner <-->|审批通知与私聊指令| Gateway
  end

  subgraph Bridge[QQ-bridge 服务]
    Input[入站规范化\n会话 key / 消息 ID / content / sourceId]
    Scope[会话路由与准入\n白名单 / 模式 / 暂停 / 会话令牌与租约]
    Buffer[未读与近期消息缓冲\n有界留存 / 已读水位]
    Wake[唤醒调度\n提及 / 提问 / 概率 / 定时 / 限频 / 忙碌合并]
    API[工具与 API v1\nQQ MCP / QQBridgeClient / HTTP]
    Context[按需上下文\n历史 / 黑话 / 人设 / 外部记忆查询]
    Broker[扩展授权与审批\n会话 + 能力 + 数据范围\ndeny / ask / allow]
    Content[内容服务运行时\n服务发现 / 参数校验 / 缓存 / 响应预算]
    Memory[记忆提供者路由\n不透明会话命名空间 / 通用协议]
    Driver[固定入口传输\nMCP stdio / HTTP]
    Output[统一输出\ntext / link / image / sticker / voice\n媒体句柄 / 目标校验 / 有序发送]
    Notify[管理员通知与审批指令\n私聊 /approve 或 /deny + 请求编号]
    Audit[审计与持久化\n配置 / 来源索引 / 会话状态 / 扩展审计]
  end

  subgraph DSH[DSH 运行时]
    Agent[普通 QQ Agent\nqq-chat / qq-chat-v2\n受限工具面 / 模型 / 会话历史]
    Host[管理员任务 Agent\n由会话路由单独授权]
  end

  subgraph Providers[外部能力与提供者]
    Media[媒体适配器\nB站字幕 / 音轨 / 视频帧\n本机语音与动图处理]
    Haitang[Haitang 记忆适配器\n本地词法与模糊检索 / 分库文件]
    Custom[自定义 MCP / HTTP 服务]
    Runner[外部 MCP / skill runner\n由受信宿主管理生命周期]
  end

  Gateway --> Input --> Scope --> Buffer --> Wake
  Wake -->|轻量唤醒提示| Agent
  Scope -->|管理员本人任务路由| Host
  Agent <-->|qq_* 工具| API
  Host <-->|本人会话能力| API
  Runner <-->|当前会话令牌 / API v1| API
  API --> Context
  Context --> Buffer
  Context -->|memory 查询| Memory
  API --> Broker
  Broker -->|内容服务获准| Content
  Broker -->|记忆操作获准| Memory
  Content --> Driver
  Memory --> Driver
  Driver --> Media
  Driver --> Haitang
  Driver --> Custom
  Content -->|原生 text / image 证据| API
  Memory -->|有界记忆结果| API
  API --> Output --> Gateway
  Broker -->|新建待审批申请| Notify
  Notify -->|仅管理员私聊| Gateway
  Gateway -->|管理员精确审批指令| Notify
  Notify -->|批准一次 / 拒绝| Broker
  Scope -.-> Audit
  Broker -.-> Audit
```

箭头表示逻辑调用方向，不表示所有模块都在独立进程中。桥接的路由、权限、来源索引、服务运行时和输出主要位于同一 Node 进程；MCP stdio 提供者是按需启动的独立进程。

框架开放的是协议和注册接口：外部 MCP / skill runner 可以使用受限客户端调用桥接，管理员也可以注册固定 MCP / HTTP 内容服务。当前没有通用热加载插件系统，也不会自动安装或扫描任意 skills。

## 2. 按需上下文与消息生命周期

```mermaid
sequenceDiagram
  participant Q as QQ / SnowLuma
  participant B as Bridge
  participant A as DSH Agent
  participant C as 上下文查询
  participant M as 外部记忆提供者
  Q->>B: 消息、分享卡片或媒体
  B->>B: 准入、规范化、登记 sourceId、更新未读缓冲
  B->>B: 判断唤醒条件、限频、忙碌及合并窗口
  B->>A: 角色名与版本、身份、原因、未读数、会话绑定
  A->>B: 读取当前未读消息
  B-->>A: 有界消息、内容类型、sourceId、读取水位
  opt 话题需要历史、黑话或角色细节
    A->>C: qq_context_query / qq_get_prompt
    C-->>A: 当前允许范围内的上下文与截断标记
  end
  opt 话题需要长期记忆
    A->>B: qq_memory / kind=memory
    B->>B: 提供者选择、会话命名空间、精确授权
    B->>M: 通用记忆请求
    M-->>B: 条目、检索结果与分页
    B-->>A: 校验并限制后的结果
  end
  A->>B: 按需发言 / 继续取证 / 等待 / 确认已读
  B->>B: 发送及执行时校验；只确认实际读取水位
  B->>Q: QQ 回复
```

- `reserved2` 默认 `on-demand`，不在每次唤醒时附加人物印象、黑话和聊天快照。首次唤醒仍可带管理员编写的会话环境。
- 人设不是每轮全量重复注入：首次、版本变化或压缩后缺失时读取。普通聊天和一代仿真的角色注入仍沿用既有行为。
- 近期消息和未读是有界缓冲，不是完整聊天档案。DSH 自己的会话历史与记忆提供者的数据是不同的存储。
- 没有提供者时记忆禁用；不回退到旧内置记忆数组。自动记忆授权不等于自动保存全部群聊。

## 3. 扩展审批、管理员通知与执行时序

```mermaid
sequenceDiagram
  participant A as 原会话 Agent
  participant B as Bridge / 权限代理
  participant O as 管理员 QQ 私聊
  participant P as MCP / HTTP 提供者
  A->>B: serviceId + sourceId + input
  B->>B: 验证会话、能力、来源、参数和数据范围
  alt deny 或范围未获准
    B-->>A: 拒绝，不读字节、不启动提供者
  else allow 且符合操作授权要求
    B->>P: 获准后执行
    P-->>B: 结果
    B-->>A: 再次检查权限并返回
  else ask
    B->>B: 创建请求，绑定会话租约、服务摘要、来源及原参数
    B-->>A: approval_required + requestId，尚未执行
    B->>O: 来源会话、能力、脱敏参数摘要、编号、批准/拒绝指令
    Note over B,O: 相同待审批申请不重复通知；发送失败不放行工具
    alt 管理员本人在机器人私聊批准
      O->>B: /approve requestId
      B->>B: 检查未过期、未撤权、未消费
      B-->>O: 已批准一次；尚未执行
      Note over A,O: 管理员在原会话让 Agent 携带编号继续
      A->>B: 相同 serviceId/sourceId/input + approvalId
      B->>B: 再次校验并原子消费一次性许可
      B->>P: 执行固定入口
      P-->>B: 结果
      B->>B: 执行后校验与审计
      B-->>A: 内容证据或处理错误
    else 拒绝、过期、撤权或参数变化
      O->>B: /deny requestId 或请求失效
      B-->>A: 后续执行被拒绝
    end
  end
```

- 默认从申请起5分钟有效，重启不恢复。批准不自动启动服务、不自动唤醒原会话，也不扩大长期权限。
- 私聊审批由桥接解析，不经过语言模型；群内命令及非管理员消息不能批准。控制台审批接口仍可使用，Agent 凭据不能管理审批。
- 普通内容服务的 `write/execute` 等副作用即使规则为 allow 仍需审批；本机自动记忆是明确注册的独立例外，不能被普通服务冒用。
- 通知只带有界脱敏摘要，完整参数、来源和执行入口可在控制台审阅。通知或网络失败不会把 ask 变成 allow。

## 4. 视频、动图与语音取证

```mermaid
flowchart TB
  Source[当前会话实际收到的 sourceId] --> Discover[qq_content_services\n发现服务、参数与权限]
  Discover --> Decide{Agent 判断任务需要}
  Decide -->|B站文字与声音| BT[bilibili.transcript]
  Decide -->|B站画面| BF[bilibili.frames]
  Decide -->|QQ视频 / 动图画面| MF[media.frames]
  Decide -->|QQ语音 / 视频音轨| MT[media.transcript]
  BT --> Subtitle{所需区间有可用字幕?}
  Subtitle -->|有| Text[按时间筛选字幕\n保留实际边界与覆盖信息]
  Subtitle -->|没有且 asr=true| Audio[下载最低码率官方音轨\n本机分段 SenseVoice]
  BF --> Video[有界下载\n小型混合轨或最低码率 H.264 纯视频轨]
  MF --> Bytes[框架授权后读取媒体字节\n来源、大小与缓存路径校验]
  MT --> Voice{是否 QQ 语音?}
  Voice -->|是| WAV[OneBot get_record WAV\n优先传回 base64，跨 Docker]
  Voice -->|视频等| BytesAudio[框架读取受限媒体字节]
  WAV --> ASR[FFmpeg 转换音频\nSenseVoice 分段识别]
  BytesAudio --> ASR
  Audio --> ASR
  Video --> Frames[本地 FFmpeg 抽帧\nuniform / scene / 绝对 timestamps]
  Bytes --> Frames
  Text --> Evidence[结构化文字与时间索引\n覆盖区间 / 截断 / 状态 / nextInput]
  ASR --> Evidence
  Frames --> Pictures[原生 PNG 图像证据\nsampledTimes / sceneTimes / nextInput]
  Evidence --> Agent[Agent 综合证据分析]
  Pictures --> Agent
  Agent --> More{证据是否足够?}
  More -->|需要下一段或重点时间| Decide
  More -->|足够| Reply[按已验证范围回复\n明确缺失与不确定信息]
```

分段转写默认0–120秒、每段30秒，单次区间最多180秒。场景检测使用每秒2帧、64×36画面的颜色直方图变化候选，按时间分箱选帧并均匀补齐；不是语义镜头识别。绝对时间点可检查动作或争议片段前后。

转写时间戳是片段边界，不是逐字对齐。部分失败保留成功片段，以 `partial` 与 `nextInput` 继续；截断需缩小时间区间重查。抽样帧不能代表完整观看，纯视频轨没有音频不能推断原视频静音。

下载先经过主机、DNS/IP、端口、重定向、体积和超时检查，FFmpeg 只读取已下载本地文件。B站Cookie不发送给CDN。当前后续调用可能重新下载视频，尚无跨调用原始媒体缓存。

## 5. 记忆与业务扩展边界

```mermaid
flowchart LR
  Agent[Agent / 受信调用方] --> MA[统一记忆 API\nquery / write / update / delete / clear / ingest]
  MA --> Namespace[桥接生成不透明命名空间\n调用方不能指定其他群]
  Namespace --> Permission[记忆能力与数据范围授权]
  Permission --> Route[已注册提供者路由]
  Route --> Haitang[当前：Haitang 适配器]
  Route -.-> Other[可替换：HTTP / MCP 记忆插件]
  Haitang --> Store[插件分库与生命周期\n本地文件 / 词法与模糊检索]
  Other --> CustomStore[插件自有存储、检索、整理与遗忘]
  History[当前会话指定近期消息] -->|ingest 仅导出明确选择记录| MA
  Admin[管理员限时业务授权] --> Debate[争论辅助任务\n独立任务凭据与相关消息流]
  Debate --> Worker[独立 DSH 分析器]
  Worker --> Draft[提交带原文引用的分析]
  Draft --> TaskCheck[任务、期限、修订及发送方式检查]
  TaskCheck --> Send[指定群的共用发送队列]
```

当前 Haitang 的查询、增删改、清空与指定记录导入使用 automatic 授权；显式 deny/ask、会话准入、额度和审计仍有效。没有启用宿主全量采集、云端向量检索或自动摘要钩子。

争论辅助是独立业务扩展示例，不是所有普通聊天都进入该流程。只有管理员创建并授权的有效任务生效；自动发送不受争论专属冷却或条数限制，但不绕过任务检查或QQ平台限制。其凭据不能调用通用媒体、记忆和管理接口。

## 6. 当前 Linux 部署

```mermaid
flowchart TB
  QQ[QQ 网络] <--> Container
  subgraph Linux[同一 Linux 主机]
    subgraph Docker[Docker]
      Container[SnowLuma 容器\nOneBot HTTP / WebSocket]
    end
    subgraph UserServices[systemd user 服务]
      Bridge[qq-bridge.service\n控制台与 API：127.0.0.1:3100]
      DSH[dsh.service\nDSH：127.0.0.1:3080]
    end
    Media[按需 MCP 媒体提供者\nFFmpeg / ffprobe / SenseVoice]
    Memory[按需 MCP Haitang 提供者]
    State[本机配置与状态目录\n令牌不进入文档或版本库]
    Data[独立外部记忆分库]
    Bridge <-->|回环 OneBot HTTP 3000 / WS 3001| Container
    Bridge <-->|DSH API / 事件流| DSH
    Bridge <-->|stdio| Media
    Bridge <-->|stdio| Memory
    Bridge --> State
    Memory --> Data
  end
  Media -->|受限 HTTPS| Bili[B站官方接口与CDN]
```

Docker 内的 QQ 语音优先通过网关转成 WAV 字节传给桥接，不依赖暴露账号目录。只返回容器路径的旧网关仍需明确共享缓存与路径映射。外部访问回环控制台需要受信隧道等部署方式，不能假定3100端口已对局域网开放。

2026-10-25 当前部署快照：唤醒额度已改为每分钟2次、每小时120次；其余额度未随此次修改。测试群 `bilibili.frames` 的临时 ask 已恢复为测试前 allow。这里记录的是部署状态，不修改仓库代码里的默认值，也不发布私人会话号、令牌或运行配置。

## 7. 代码与接口索引

| 责任 | 主要入口 |
| --- | --- |
| QQ 入站、唤醒、工具接口、发送、管理员私聊审批 | `src/bridge.js` |
| 双模式与会话路由 | `src/core/dual-mode.mjs`、`src/core/session-router.mjs` |
| 按需上下文与 API 映射 | `src/core/context-query.mjs`、`src/core/public-api.mjs` |
| 来源引用与媒体句柄 | `src/framework/content.mjs`、`src/framework/media-store.mjs` |
| 精确授权、一次性审批与通知事件 | `src/framework/permissions.mjs` |
| 内容服务发现、执行与响应预算 | `src/framework/services.mjs` |
| 固定 MCP / HTTP 传输 | `src/framework/service-transport.mjs` |
| 开放记忆协议及旧入口兼容 | `src/framework/memory-providers.mjs`、`src/framework/memory-compat.mjs` |
| Haitang 适配器 | `integrations/haitang-memory.mjs` |
| 媒体服务声明与B站适配 | `integrations/media-services.mjs`、`integrations/media-provider.mjs` |
| 抽帧、音频转换与识别 | `integrations/media-engine.mjs`、`integrations/media-asr-worker.mjs` |
| 外部 MCP / skill runner 客户端 | `src/bridge-client.mjs`、`examples/` |
| QQ Agent 约束与模型指引 | `dsh/agent-presets/`、`plugins/qq-agent-presets/` |
| 争论任务与插件客户端 | `src/framework/debate.mjs`、`src/debate-client.mjs` |

详细协议见 [扩展API](EXTENSION_API.md)、[内容框架](CONTENT_FRAMEWORK.md)、[权限审批](EXTENSION_PERMISSIONS.md)、[视频服务](VIDEO_SERVICES.md)、[记忆提供者](MEMORY_PROVIDERS.md) 和 [争论辅助](DEBATE_PLUGIN.md)。

## 8. 尚未实现的部分

- 没有接入夸克视频理解；试验已停止。
- 没有语音生成/TTS提供者。统一输出支持语音句柄，已有本地语音发送能力，不等于已实现生成语音。
- 没有连续视频多模态理解：当前是字幕/分段ASR与抽样画面组合。
- 批准不会自动恢复 Agent 回合；需要原会话用原参数携带审批编号继续。
- 外部进程的系统权限由部署宿主管理。MCP协议和桥接会话隔离不是操作系统沙箱。
