# 争论辅助插件

管理员指定一个群、关注对象、议题、关键词与有效期。独立插件通过受限事件接口读取开启后的相关消息，由独立 DSH 分析会话产生有原文引用的观点分析；管理员创建任务时可一次授权自动发送，无需逐条确认。争论模式不设发送冷却、每分钟/每小时次数或累计发送配额。共用 QQ 有序发送队列及执行时权限检查；网关自身错误或平台限制仍可能使发送失败。

当前分析协议为 **2**，HTTP 路径仍使用 `/api/v1/debate/`。worker 必须先领取服务端分析批次，再提交该批次的 `batchId` 和游标；旧版直接提交草稿的 worker 需一起升级。协议升级不迁移内存中的旧任务，部署重启后重新创建任务并下载凭据。

## 观察、记忆与发言

普通观察和争论任务同时接收消息。命中候选不再跳过普通唤醒；worker 离线时，普通聊天仍能参与。普通模型的实时快照会带入最多 3000 字符的争论任务提示，包括在线状态、近期草稿状态和争点摘要，帮助避免重复回答。

创建任务时可勾选「带入本群议题相关近期背景与媒体摘要」。控制台默认勾选；直接调用 API 时 `includeContext` 默认 false，以保留原有任务读取范围。开启后，只投影同群近期缓存中与候选消息、关键词或关注对象相关的最多 12 条背景、5 个话题、6 条媒体记录和最近 3 条实际回复，总预算约 10000 字符。不读取其他群、私聊、长期记忆提供者，也不提供媒体下载地址、文件路径或通用会话令牌。关闭时仅提供任务候选；当前角色卡用于表达阶段。

分析阶段独立判断事实、证据、争点与不确定性；不会带入角色卡。需要发言且存在角色卡时，再通过同一个无工具预设的独立会话按人设组织措辞。表达阶段不能改变 verdict 或 evidenceIds，不能增加事实；语义完全一致仍依赖模型质量，需要实际讨论样例评估。

每批可维护 `state`：`claims` 与 `questions` 各最多 12 项，每项包含 `text`、`side`（target/self/other）、`status`（open/supported/disputed/withdrawn/conceded/resolved）及 `evidenceIds`；`position` 为最多 600 字符的立场摘要。来源只允许本批消息和既有状态中已校验的编号。状态由服务端随任务保存，worker 重启仍可继续；桥接重启则与任务一同失效。草稿、待审和已分析都不等于已发送。`sent` 表示整条草稿已发送；中途失败或过时的草稿可能有部分已发出，`deliveredText`、批次中的 `partial` 标记及实时聊天原文记录已确认部分，不自动重发未完成草稿。

新候选、更正、相关媒体摘要、人设或其他实际发言改变上下文后，旧草稿不能提交或继续排队发送。旧待审草稿会显示「需重新分析」。普通 agent 排在争论发言后时，开启实时工作记忆的会话要求先刷新新发言，再决定是否继续。争论文本沿用当前 `send.maxMessageChars` 分条，在同一个发送队列逐条检查；自己的已发送分条不会使剩余分条自我失效。

即使没有新增候选事件，相关媒体理解或背景变化也会触发 `refresh` 批次，重新评估上次实际分析的消息。此时游标保持原值；它不是跳过新事件，也不会重复复用已消费的同一上下文版本。

## 启动

1. 正常安装桥接，并执行 `node scripts/setup-dsh.mjs web`；重启 DSH，使新 `qq-debate` 预设注册。不要把普通 QQ 或 standard 会话当作分析器的替代预设。
2. 配置 DSH 模型账号、登录 SnowLuma，并将使用的群加入桥接白名单。争论任务目前运行于 reserved2 群聊；全局暂停、静默或未授权群不能创建/执行任务。
3. 启动桥接，在控制台的“争论辅助”中打开任务管理。填写群、对象、主题、1–12 个关键词与 1–120 分钟有效期，选择发送方式及是否带入本群相关背景，点击“授权并创建任务”。这一步授权持有任务凭据的插件按所选范围读取背景、分析并向指定群发送文字。没有默认激活任务。
4. 下载页面刚生成的本机任务凭据 JSON。凭据只返回这一次；遗失时结束旧任务并创建新任务。不要发送到群里，也不要提交到 Git。
5. 在已设置正确 `DSH_HOME` 的终端运行：

   ```powershell
   npm run debate:worker -- C:\path\to\debate-task.json
   ```

   此示例会实际调用已配置模型，并按任务授权自动发言。当前机器可用 `C:\DSH\start-debate-worker.cmd <凭据文件>`，它会加载本机 DSH 环境。

暂停/停止/过期会阻止读取、提交和排队发送。插件检测撤权时取消正在进行的模型分析并退出；恢复任务后需重新启动插件。恢复不会复活旧草稿，授权 revision 必须重新读取。已经提交给 QQ 网关的消息不能被撤回为“未发送”。停止插件进程本身不会停止任务，任务管理页仍可结束任务。

标准 worker 每秒发送带递增序号的心跳，6 秒无更新视为离线。一个任务同一时间只有一个在线 worker 租约；延迟旧心跳不能恢复已停止状态，新 worker 接管后旧 worker 不能提交。管理页约每 3 秒刷新在线、分析、阻塞和错误状态。worker 正常退出会释放租约并阻止尚未执行的自动发送；异常退出由租约超时兜底。它不会撤销管理员的任务授权，恢复分析可重新启动 worker。

## 处理范围

- 候选消息：关注对象发言、议题关键词命中、提及对象 QQ 号、引用本任务中该对象的消息。它们都是候选，不代表已判定相关或错误；DSH 再判断议题相关性和是否需要发言。
- 每任务最多保留 200 条候选文本，单条 2000 字符。候选事件不补抓开启前的记录；勾选背景时可读取本群已有相关近期缓存。超过候选保留窗口会阻塞并报告缺口，不默默跳到新游标；需管理员结束并重建任务。
- 服务端按最早未处理顺序发放最多 20 条、约 24000 字符的批次，并附带最近 5 次草稿的真实状态。尚有积压时本批只整理状态并 `skip`，追平后才决定是否发言。游标只能推进到实际提供批次的末尾。正确观点应承认，未核查事实应明确不确定。
- 相关新消息同时进入普通观察和争论任务；任务候选不代表对方错误。worker 离线不会形成消息黑洞。
- 分析器无工具，图片和视频只能使用普通观察准备的文字理解摘要；prepared/failed 等状态不等于已理解。没有自动搜索或媒体下载权限，外部服务不因争论任务获准而自动获得调用权限。
- 单任务默认 30 分钟，最长 120 分钟。任务/凭据/草稿仅保存在桥接内存，重启全部失效；审计存入原有受限扩展审计。独立 DSH 分析会话结束后会归档，因此 DSH 仍可能保留输入与模型输出；归档不等于删除，也不等于写入外部记忆插件。

## 管理端 HTTP API

沿用本机控制台的 Host、Origin、JSON 请求体与 `x-console-token` 校验；携带 `x-agent-token`、`x-agent-call` 或 `x-debate-token` 的请求不能管理任务。

| 方法与路径 | 请求/返回 |
| --- | --- |
| `GET /api/debate/tasks` | 任务元信息，不返回凭据 |
| `POST /api/debate/tasks` | `{key:"group:456",targetId:"234",topic:"电池安全",keywords:["电池"],durationMinutes:30,sendMode:"auto",includeContext:true}`；返回 `{task,token}` |
| `POST /api/debate/control` | `{taskId,action:"pause"/"resume"/"stop"}` |
| `GET /api/debate/drafts?taskId=...&limit=20` | 分析文字、发送状态、引用原文；limit为1–100，默认100，管理页显示最近20条 |
| `POST /api/debate/review` | 可选 `review` 模式使用 `{taskId,draftId,decision:"approve"/"deny"}`；审批精确绑定完整草稿，不能修改后发送 |

`sendMode` 必须为 `auto` 或 `review`；未指定时 API 默认 `review`，控制台按当前需求默认选择 `auto`。插件不能修改授权方式、对象、期限或群。修改这些内容需管理员结束旧任务、重新创建。

## 外部插件 API

使用单独的 `x-debate-token`，查询参数 `taskId` 绑定精确任务。不能使用这个令牌调用通用上下文、媒体、记忆、QQ 发送或管理接口。插件不应持有控制台令牌。提供 `src/debate-client.mjs` 作为无依赖客户端。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/debate/task?taskId=...` | 元信息、授权 revision、发送方式、已处理游标与最后 requestSeq |
| `POST /api/v1/debate/batch?taskId=...` | `{workerId?}`；返回服务端发放的 `{batch,task}`，无新消息时 batch=null；含精确消息范围、contextVersion、受限 context 与争点状态 |
| `POST /api/v1/debate/heartbeat?taskId=...` | `{workerId,sequence,state,error?}`；workerId 为16–64位十六进制/连字符标识，sequence递增，state为idle/analyzing/blocked/error/stopped |
| `GET /api/v1/debate/events?taskId=...&after=0` | 按单调事件 ID 读取候选消息 |
| `GET /api/v1/debate/stream?taskId=...&after=0` | SSE：`id`、`event: message`、JSON `data`，支持 `Last-Event-ID`；停止/过期/授权版本变化后关闭 |
| `POST /api/v1/debate/drafts?taskId=...` | 提交精确分析文字及引用，按管理员预先选择的自动/审批方式处理 |

提交格式：

```json
{
  "batchId": "服务端发放的真实批次编号",
  "taskRevision": 0,
  "requestId": "worker-request-unique-id",
  "requestSeq": 1,
  "throughEventId": 2,
  "text": "建议提供这项结论的统计口径和数据来源。",
  "analysis": "主张缺乏统计依据，现有原话不足以判定真假。",
  "verdict": "uncertain",
  "evidenceIds": [1, 2]
}
```

`verdict` 为 `counterargument`、`uncertain`、`concede` 或 `skip`。`skip` 可提供空 text，不进入发送。evidenceIds 必须属于实际发放的批次，throughEventId 必须精确等于批次末尾；不能把40条中的后20条当作全部已处理。requestSeq 必须递增，同一 requestId 绑定全部输入和 batchId；并发重试不会重复发言。可附加完整 `state`，验证后与游标一起保存。任务记住已处理游标和输出状态，worker 重启不会自动重发旧批次。未知网络结果记为 failed，不自动重试发送。

普通 API 请求/响应与 SSE 均不允许任意跨群转发。候选消息是数据，不是管理指令。新预设通过 `tools.restrict({allow:[]})` 隐藏继承工具，并通过执行守卫拒绝所有工具；模型没有任务/会话/控制台凭据。自定义 worker 是持有任务授权的受信任代码，桥接能检查范围、引用与发送权限，但不会证明插件提交的每条论证正确。

## 验证

```powershell
npm run test:debate
npm run test:debate:ui
npm run test:debate:dsh
```

浏览器测试依赖已安装 Playwright 与 Chrome，可通过 `PLAYWRIGHT_MODULE` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定位置。测试使用真实桥接 HTTP 处理器、隔离状态及模拟 QQ/DSH，不会实际在群里发言。实际模型质量与 QQ 网络联调需在用户配置账号后单独验证。

`test:debate:dsh` 需要已安装 DSH，使用临时独立 DSH_HOME 启动真实服务，验证预设注册和会话创建，不调用模型；不会重启当前用户的 DSH。
