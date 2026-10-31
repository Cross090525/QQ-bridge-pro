# 争论辅助插件

管理员指定一个群、关注对象、议题、关键词与有效期。独立插件通过受限事件接口读取开启后的相关消息，由独立 DSH 分析会话产生有原文引用的观点分析；管理员创建任务时可一次授权自动发送，无需逐条确认。争论模式本身不附加发送冷却或次数配额；启用[统一额度](USAGE_QUOTAS.md)后，分析批次和发送仍受对应规则约束。共用 QQ 有序发送队列及执行时权限检查；网关自身错误或平台限制仍可能使发送失败。

当前分析协议为 **2**，HTTP 路径仍使用 `/api/v1/debate/`。worker 必须先领取服务端分析批次，再提交该批次的 `batchId` 和游标；旧版直接提交草稿的 worker 需一起升级。协议升级不迁移内存中的旧任务，部署重启后重新创建任务并下载凭据。

## 观察、记忆与发言

普通观察和争论任务同时接收消息。命中候选不再跳过普通唤醒；worker 离线时，普通聊天仍能参与。普通模型的实时快照会带入最多 3000 字符的争论任务提示，包括在线状态、近期草稿状态和争点摘要，帮助避免重复回答。

创建任务时可勾选「带入本群议题相关近期背景与媒体摘要」。控制台默认勾选；直接调用 API 时 `includeContext` 默认 false，以保留原有任务读取范围。开启后，只投影同群近期缓存中与候选消息、关键词或关注对象相关的最多 12 条背景、5 个话题、6 条媒体记录和最近 3 条实际回复，总预算约 10000 字符。不读取其他群、私聊、长期记忆提供者，也不提供媒体下载地址、文件路径或通用会话令牌。关闭时仅提供任务候选；当前角色卡用于表达阶段。

分析阶段独立判断事实、证据、争点与不确定性；不会带入角色卡。需要发言且存在角色卡时，再通过同一个无工具预设的独立会话按人设组织措辞。表达阶段不能改变 verdict 或 evidenceIds，不能增加事实；语义完全一致仍依赖模型质量，需要实际讨论样例评估。

每批可维护 `state`：`claims` 与 `questions` 各最多 12 项，每项包含 `text`、`side`（target/self/other）、`status`（open/supported/disputed/withdrawn/conceded/resolved）及 `evidenceIds`；`position` 为最多 600 字符的立场摘要。来源只允许本批消息和既有状态中已校验的编号。状态由服务端随任务保存，worker 重启仍可继续；桥接重启则与任务一同失效。草稿、待审和已分析都不等于已发送。`sent` 表示整条草稿已发送；中途失败或过时的草稿可能有部分已发出，`deliveredText`、批次中的 `partial` 标记及实时聊天原文记录已确认部分，不自动重发未完成草稿。

新候选、更正、相关媒体摘要、人设或其他实际发言改变上下文后，旧草稿不能提交或继续排队发送。旧待审草稿会显示「需重新分析」。普通 agent 排在争论发言后时，开启实时工作记忆的会话要求先刷新新发言，再决定是否继续。争论文本沿用当前 `send.maxMessageChars` 分条，在同一个发送队列逐条检查；自己的已发送分条不会使剩余分条自我失效。

即使没有新增候选事件，相关媒体理解或背景变化也会触发 `refresh` 批次，重新评估上次实际分析的消息。此时游标保持原值；它不是跳过新事件，也不会重复复用已消费的同一上下文版本。

## 启动

### 群聊申请，管理员批准后自动启动

在控制台“争论辅助 → 群聊唤起与启动审核”启用群聊申请，设置自定义语句（每行一条，最多10条）、任务有效期、发送方式和上下文范围。默认关闭；默认发送方式为 `review`，管理员批准启动后，每条发言仍需审核。选择 `auto` 则批准启动同时授权任务有效期内自动发言，不再逐条审批。修改设置会取消尚未审核的申请，已经批准的任务仍由任务区单独暂停或结束。

群友发送，例如：

```text
开启辩论 @某人 电池安全 | 电池,事故
开启辩论 123456789 电池安全 | 电池,事故
```

只匹配当前消息开头的完整语句，语句后需空格或真实 @ 段；不是正则，也不解析引用原文、转发、卡片和媒体摘要。必须指定一个真实 @对象或 QQ 号，不能选机器人或全体成员。`|` 后可指定1–12个关键词；省略时用议题作为关键词，长议题需单独指定短关键词。群友不能通过消息调整发送权、有效期或上下文范围。

桥接只生成5分钟有效的申请并通知管理员私聊，**审核前不创建争论任务、不启动分析器，也不调用争论模型**。管理员在控制台查看群、申请人、对象、议题、关键词及权限范围后批准或拒绝；也可以由 `ownerQQ` 本人在机器人私聊中操作：

```text
/debate-approve 申请编号
/debate-deny 申请编号
```

管理员本人在群里唤起也必须走这一步审核；群聊中的审批口令不生效。未设置 ownerQQ 或通知失败时，仍可在管理员控制台审核。审批按具体申请编号绑定，重复批准不会重复创建任务；拒绝、到期、重启、配置变更后不能批准，群授权、模式、暂停和静默也会重新检查。同一群同一申请人最多一条待审申请，30秒内不重复申请；最多保留100条记录。这些是申请去重/存储限制，不是争论发言的次数配额。

批准后桥接通过固定本机入口自动启动 worker，无需手动下载凭据。worker 使用桥接进程继承的环境（含 DSH_HOME）和仓库 config.json；需先完成下节的 DSH 预设安装。只把任务专用令牌暂存至 `state/debate-workers/<taskId>.json`（Linux目录700、文件600），命令行不含令牌，审批响应和群聊通知也不含令牌。worker退出时删除文件；暂停、停止、过期及桥接正常退出会终止进程，恢复由桥接重启该任务的 worker。worker异常退出会在任务区显示离线/异常，可暂停后恢复；不会无限重启或自动重发。桥接非正常崩溃可能遗留凭据文件，旧令牌随桥接重启失效；它们不应备份到外部或提交 Git。

### 管理员直接创建与外部 worker

1. 正常安装桥接，并执行 `node scripts/setup-dsh.mjs web`；重启 DSH，使新 `qq-debate` 预设注册。不要把普通 QQ 或 standard 会话当作分析器的替代预设。
2. 配置 DSH 模型账号、登录 SnowLuma，并将使用的群加入桥接白名单。争论任务目前运行于 reserved2 群聊；全局暂停、静默或未授权群不能创建/执行任务。
3. 启动桥接，在控制台的“争论辅助”中打开任务管理。填写群、对象、主题、1–12 个关键词与 1–120 分钟有效期，选择发送方式及是否带入本群相关背景，点击“授权并创建任务”。这一步授权持有任务凭据的插件按所选范围读取背景、分析并向指定群发送文字。没有默认激活任务。
4. 下载页面刚生成的本机任务凭据 JSON。凭据只返回这一次；遗失时结束旧任务并创建新任务。不要发送到群里，也不要提交到 Git。
5. 在已设置正确 `DSH_HOME` 的终端运行：

   ```powershell
   npm run debate:worker -- C:\path\to\debate-task.json
   ```

   此示例会实际调用已配置模型，并按任务授权自动发言。当前机器可用 `C:\DSH\start-debate-worker.cmd <凭据文件>`，它会加载本机 DSH 环境。

暂停/停止/过期会阻止读取、提交和排队发送。插件检测撤权时取消正在进行的模型分析并退出；直接创建任务使用的外部插件需在恢复后手动重启，群聊审批创建的托管 worker 则由桥接重启。恢复不会复活旧草稿，授权 revision 必须重新读取。已经提交给 QQ 网关的消息不能被撤回为“未发送”。停止插件进程本身不会停止任务，任务管理页仍可结束任务。

标准 worker 每秒发送带递增序号的心跳，6 秒无更新视为离线。一个任务同一时间只有一个在线 worker 租约；延迟旧心跳不能恢复已停止状态，新 worker 接管后旧 worker 不能提交。管理页约每 3 秒刷新在线、分析、阻塞和错误状态。worker 正常退出会释放租约并阻止尚未执行的自动发送；异常退出由租约超时兜底。它不会撤销管理员的任务授权，恢复分析可重新启动 worker。

## 处理范围

- 候选消息：关注对象发言、议题关键词命中、提及对象 QQ 号、引用本任务中该对象的消息。它们都是候选，不代表已判定相关或错误；DSH 再判断议题相关性和是否需要发言。
- 每任务最多保留 200 条候选文本，单条 2000 字符。候选事件不补抓开启前的记录；勾选背景时可读取本群已有相关近期缓存。超过候选保留窗口会阻塞并报告缺口，不默默跳到新游标；需管理员结束并重建任务。
- 服务端按最早未处理顺序发放最多 20 条、约 24000 字符的批次，并附带最近 5 次草稿的真实状态。尚有积压时本批只整理状态并 `skip`，追平后才决定是否发言。游标只能推进到实际提供批次的末尾。正确观点应承认，未核查事实应明确不确定。
- 相关新消息同时进入普通观察和争论任务；任务候选不代表对方错误。worker 离线不会形成消息黑洞。
- 分析器无工具，图片和视频只能使用普通观察准备的文字理解摘要；prepared/failed 等状态不等于已理解。没有自动搜索或媒体下载权限，外部服务不因争论任务获准而自动获得调用权限。
- 单任务默认 30 分钟，最长 120 分钟。任务/申请/草稿保存在桥接内存，重启全部失效；托管 worker 凭据有上述临时本机文件，自行下载的凭据由管理员保管。审计存入原有受限扩展审计。独立 DSH 分析会话结束后会归档，因此 DSH 仍可能保留输入与模型输出；归档不等于删除，也不等于写入外部记忆插件。

## 管理端 HTTP API

沿用本机控制台的 Host、Origin、JSON 请求体与 `x-console-token` 校验；携带 `x-agent-token`、`x-agent-call` 或 `x-debate-token` 的请求不能管理任务。

| 方法与路径 | 请求/返回 |
| --- | --- |
| `GET /api/debate/wake` | 群聊唤起配置 |
| `POST /api/debate/wake` | `{enabled,phrases:["开启辩论"],durationMinutes:30,sendMode:"review",includeContext:false}`；保存 config.json 并取消待审申请 |
| `GET /api/debate/requests` | 有界申请清单及状态，不含任务令牌 |
| `POST /api/debate/requests/review` | `{requestId,decision:"approve"/"deny"}`；批准后自动启动本机 worker，不返回任务令牌 |
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
