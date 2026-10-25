# 争论辅助插件

管理员指定一个群、关注对象、议题、关键词与有效期。独立插件通过受限事件接口读取开启后的相关消息，由独立 DSH 分析会话产生有原文引用的观点分析；管理员创建任务时可一次授权自动发送，无需逐条确认。争论模式不设发送冷却、每分钟/每小时次数或累计发送配额。共用 QQ 有序发送队列及执行时权限检查；网关自身错误或平台限制仍可能使发送失败。

## 启动

1. 正常安装桥接，并执行 `node scripts/setup-dsh.mjs web`；重启 DSH，使新 `qq-debate` 预设注册。不要把普通 QQ 或 standard 会话当作分析器的替代预设。
2. 配置 DSH 模型账号、登录 SnowLuma，并将使用的群加入桥接白名单。争论任务目前运行于 reserved2 群聊；全局暂停、静默或未授权群不能创建/执行任务。
3. 启动桥接，在控制台的“争论辅助”中打开任务管理。填写群、对象、主题、1–12 个关键词与 1–120 分钟有效期，选择“任务内自动发送”，点击“授权并创建任务”。这一步授权持有任务凭据的插件读取筛选消息、提交分析并向指定群发送其分析文字。没有默认激活任务。
4. 下载页面刚生成的本机任务凭据 JSON。凭据只返回这一次；遗失时结束旧任务并创建新任务。不要发送到群里，也不要提交到 Git。
5. 在已设置正确 `DSH_HOME` 的终端运行：

   ```powershell
   npm run debate:worker -- C:\path\to\debate-task.json
   ```

   此示例会实际调用已配置模型，并按任务授权自动发言。当前机器可用 `C:\DSH\start-debate-worker.cmd <凭据文件>`，它会加载本机 DSH 环境。

暂停/停止/过期会阻止读取、提交和排队发送。插件检测撤权时取消正在进行的模型分析并退出；恢复任务后需重新启动插件。恢复不会复活旧草稿，授权 revision 必须重新读取。已经提交给 QQ 网关的消息不能被撤回为“未发送”。停止插件进程本身不会停止任务，任务管理页仍可结束任务。

## 处理范围

- 候选消息：关注对象发言、议题关键词命中、提及对象 QQ 号、引用本任务中该对象的消息。它们都是候选，不代表已判定相关或错误；DSH 再判断议题相关性和是否需要发言。
- 每任务最多保留 200 条候选文本，单条 2000 字符。不会补抓开启前的记录，不读取其他群、私聊或记忆提供者。引用对象尚未进入本任务时，不会为此额外拉取历史。
- 分析器每次选最近最多 20 条、约 24000 字符消息，附带插件本次运行最近 5 次输出状态以减少重复。模型可选择 `skip`，不发送任何内容；正确观点应承认，未核查事实应明确不确定。
- 相关新消息会交给争论任务，本条不触发普通聊天唤醒；已有普通会话在途工作不由任务强制取消。无关消息仍按原唤醒规则处理。应先启动插件再开展讨论，避免创建任务后无人消费消息。
- 第一版分析器无工具，支持纯文字论证与原文引用；没有接入自动搜索、B 站解析或语音转写。外部服务不因争论任务获准而自动获得调用权限。
- 单任务默认 30 分钟，最长 120 分钟。任务/凭据/草稿仅保存在桥接内存，重启全部失效；审计存入原有受限扩展审计。独立 DSH 分析会话结束后会归档，因此 DSH 仍可能保留输入与模型输出；归档不等于删除，也不等于写入外部记忆插件。

## 管理端 HTTP API

沿用本机控制台的 Host、Origin、JSON 请求体与 `x-console-token` 校验；携带 `x-agent-token`、`x-agent-call` 或 `x-debate-token` 的请求不能管理任务。

| 方法与路径 | 请求/返回 |
| --- | --- |
| `GET /api/debate/tasks` | 任务元信息，不返回凭据 |
| `POST /api/debate/tasks` | `{key:"group:456",targetId:"234",topic:"电池安全",keywords:["电池"],durationMinutes:30,sendMode:"auto"}`；返回 `{task,token}` |
| `POST /api/debate/control` | `{taskId,action:"pause"/"resume"/"stop"}` |
| `GET /api/debate/drafts?taskId=...` | 分析文字、发送状态、引用原文 |
| `POST /api/debate/review` | 可选 `review` 模式使用 `{taskId,draftId,decision:"approve"/"deny"}`；审批精确绑定完整草稿，不能修改后发送 |

`sendMode` 必须为 `auto` 或 `review`；未指定时 API 默认 `review`，控制台按当前需求默认选择 `auto`。插件不能修改授权方式、对象、期限或群。修改这些内容需管理员结束旧任务、重新创建。

## 外部插件 API

使用单独的 `x-debate-token`，查询参数 `taskId` 绑定精确任务。不能使用这个令牌调用通用上下文、媒体、记忆、QQ 发送或管理接口。插件不应持有控制台令牌。提供 `src/debate-client.mjs` 作为无依赖客户端。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/debate/task?taskId=...` | 元信息、授权 revision、发送方式、已处理游标与最后 requestSeq |
| `GET /api/v1/debate/events?taskId=...&after=0` | 按单调事件 ID 读取候选消息 |
| `GET /api/v1/debate/stream?taskId=...&after=0` | SSE：`id`、`event: message`、JSON `data`，支持 `Last-Event-ID`；停止/过期/授权版本变化后关闭 |
| `POST /api/v1/debate/drafts?taskId=...` | 提交精确分析文字及引用，按管理员预先选择的自动/审批方式处理 |

提交格式：

```json
{
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

`verdict` 为 `counterargument`、`uncertain`、`concede` 或 `skip`。`skip` 可提供空 text，不进入发送。证据必须是该任务实际收到且尚保留的事件；throughEventId 是本批已处理的真实事件。requestSeq 必须递增，同一 requestId 绑定全部输入；并发重试不会重复发言。任务记住已处理游标，插件重启不会自动重发旧批次。未知网络结果记为 failed，不自动重试发送。

普通 API 请求/响应与 SSE 均不允许任意跨群转发。候选消息是数据，不是管理指令。新预设通过 `tools.restrict({allow:[]})` 隐藏继承工具，并通过执行守卫拒绝所有工具；模型没有任务/会话/控制台凭据。自定义 worker 是持有任务授权的受信任代码，桥接能检查范围、引用与发送权限，但不会证明插件提交的每条论证正确。

## 验证

```powershell
npm run test:debate
npm run test:debate:ui
npm run test:debate:dsh
```

浏览器测试依赖已安装 Playwright 与 Chrome，可通过 `PLAYWRIGHT_MODULE` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定位置。测试使用真实桥接 HTTP 处理器、隔离状态及模拟 QQ/DSH，不会实际在群里发言。实际模型质量与 QQ 网络联调需在用户配置账号后单独验证。

`test:debate:dsh` 需要已安装 DSH，使用临时独立 DSH_HOME 启动真实服务，验证预设注册和会话创建，不调用模型；不会重启当前用户的 DSH。
