# 实时工作记忆与自动观察

二代仿真模式默认持续观察获准会话，再决定是否发言。普通群消息会合批触发观察，@、名字和关键词仍用于提升唤醒优先级。原有白名单、暂停、会话串行队列和唤醒限频继续生效；限频时消息仍保存，不保证每个短句单独触发一次模型调用。

在控制台「二代仿真 → 实时工作记忆」查看状态或关闭。配置项为 `socialV2.workingMemory.enabled`，缺省为 `true`。关闭 `getRecent` 或 `contextQuery` 也会停止该功能。保存后对后续批次生效；QQ 预设与 MCP 工具更新需要重启 DSH。此功能不写入长期记忆提供者、不修改角色卡或黑话库。

## 三层上下文

1. 原文：每会话最多 500 条近期消息，保留发送者、时间、QQ 消息 ID、引用对象、媒体引用及实际发送的回复。单条最多 12000 字符，超过时明确标注；旧近期缓存只在首次启用时导入，并注明可能是节选。
2. 工作状态：最多 5 个话题，以及各最多 10 条事实、问题和不确定项。每项带来源编号、更新时间、状态（active/dormant/resolved）和确定性（reported/confirmed/inferred）。活跃话题一小时未更新，在快照中显示为 dormant；不会把未回答问题自动认定为已解决。
3. 模型快照：每次唤醒自动提供，独立于旧 `context.strategy`。默认优先带入最早尚未判断的 12 条消息和最近 8 条，去重并按原顺序排列；总预算约 10000 字符。长消息先给头尾节选，完整缓存可按编号回看。模型提交参与决策后记录已展示的判断进度，有积压时安排后续观察；预算截断不授予未展示消息的已读水位。

消息展示、模型判断、媒体理解、实际发言是不同状态。`mark_read` 和潜水不删除工作记忆；`reply` 决策不是成功发送记录。状态按会话散列文件名保存在 `state/working-memory/`，原子写入并在重启后恢复。损坏文件不会被空状态覆盖，需恢复备份。

## 自动感知

图片通过现有获准看图能力获取；视频与语音按已配置的固定只读服务准备证据。兼容 `bilibili.storyboard`、`media.storyboard`，也支持 main 现有的 frames/transcript 服务组合，不安装或改写服务配置。普通网页链接没有视频服务时不会被当作视频理解。

后台全局最多 2 个准备任务同时运行，最多 32 个排队，每批最多调度 5 个来源。文字观察最多等 2.5 秒，未完成的媒体标记 pending；完成后重新安排观察。每轮最多直接携带 5 张图片，超过预算的证据留待后续批次。抽样视频及超长识别结果的节选必须保留范围限制。

只有明确 allow 的只读服务可以自动执行，ask/deny 不自动申请审批、不绕过人工授权。权限、会话身份、暂停、模式或工具配置变化会使在途结果失效。媒体状态 prepared 只表示证据准备好；模型实际看到证据并提交摘要后才是 understood。失败或过期表示未知，不代表与机器人无关。

## 模型更新接口

工具 `qq_working_memory` 的 read 返回快照；可用 `input.query` 搜索原文，或 `input.messageId` 按工作记忆的 `messages.id` 精确回看。update 通过 `input` 提交：

```json
{
  "revision": 0,
  "topics": [{"text":"大家在讨论刚才视频里的剧情", "status":"active", "certainty":"reported", "sources":["qq:100"]}],
  "decision": {"action":"need_context", "note":"视频仍在解析，先补充信息", "sources":["qq:100"]}
}
```

更新字段仅支持 `revision`、`topics`、`facts`、`questions`、`uncertainties`、`media`、`decision`。列表字段为完整替换，无变化时省略；不要省略仍有效的条目。`decision.action` 可为 observe/need_context/reply，只保存简短依据，不保存完整思考。媒体更新使用 `media:[{sourceId,summary}]`，只能总结已经提供证据的来源。

所有来源必须属于当前会话且确实展示过，管理端预览不算模型已读。revision 冲突返回 409，模型须重新读取并合并；新消息入库与媒体准备不覆盖语义状态。没有新模型判断时，控制台保留“尚未判断”或上次决策，不能保证模型每轮都遵循协议。

外部程序可用 `QQBridgeClient.workingContext({query,messageId})` 和 `updateWorkingContext(input)`；对应 GET/POST `/api/v1/working/context`，只用当前会话令牌。该接口不开放跨群、管理员任务模式、文件路径或长期记忆写入能力。

## 验证

`npm run test:working-memory` 验证持久化、消息积压、已读水位、版本与来源约束、权限撤销及真实 HTTP 媒体服务；`npm run test:working-memory:ui` 使用隔离桥接和真实浏览器验证控制台。测试不向真实 QQ 发消息，不调用真实模型。实际是否自然接话还需部署后用群聊样例评估。
