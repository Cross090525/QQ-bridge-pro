# 时效记忆与未完事项

二代仿真模式支持有有效区间的事实和持久化未完事项。控制台「二代仿真模式 → 实时工作记忆」控制观察、事项接续和本地时效匹配；「未完事项与任务记忆」可搜索、分页、新建、编辑、完成、取消和删除事项。配置对后续读取/唤醒生效，新增 MCP 工具和 preset 更新需要重启 DSH。

```json
{
  "socialV2": {
    "workingMemory": {
      "enabled": true,
      "tasksEnabled": true,
      "temporalRecall": true
    }
  }
}
```

缺省三个开关均为 true；关闭观察、`getRecent` 或 `contextQuery` 会同时停用 Agent 的事项操作和自动接续。关闭 `memory` 会停止提供者访问及本地时效匹配。管理端仍可管理事项；关闭开关不会删除数据。

## 未完事项

事项按会话独立存储在 `state/task-memory/`，重启后恢复，独立于最多 500 条工作原文的保留窗口。类型为对话待续 `continuation`、机器人待办 `bot_task`、用户计划 `user_plan`。状态为 `pending / in_progress / waiting / completed / cancelled`；`overdue` 单独表示截止时间已过，不自动标为完成、取消或删除。

适合记录“等截图再看”“等测试结果继续”“比较方案还差兼容性”。随口说“回头再聊”不必建立正式事项。每会话最多 100 个未结束事项、200 个总事项，到容量后需由管理员整理；不会静默丢弃未完成事项。已结束事项不可重新开启，新要求建立新事项。

新消息的唤醒和读取/等待结果会附带 `taskMemory`，按当前会话、负责人及文字匹配选择最多 3 条、约 2400 字符的事项。`same-owner-review` 仅表示同一个负责人，仍需判断新消息是否在谈原事项。该选择是保守的候选提示，不保证自然语言指代正确；没有新证据不推进任务，不自动催办，召回不授予发言权限。

工具 `qq_task_memory`：read 的 input 支持 `query/status/offset/limit`；update 接受如下内容，修改时再带已有 `id`：

```json
{
  "revision": 0,
  "text": "等待测试结果后继续排查启动问题",
  "ownerId": "234",
  "kind": "continuation",
  "status": "waiting",
  "waitingFor": "负责人提供测试结果",
  "dueAt": null,
  "sources": ["qq:100"]
}
```

示例标识仅为合成占位值。负责人必须来自实际来信的 `userId`，不可转让；变更须引用当前会话已向模型展示的来源，并包含负责人来信。完成/取消须有未包含在原事项中的新来信依据；记录为 owner-reported，不把机器人自述当成操作成功。机器人独立执行的交付验证、定时提醒、循环任务和自动催办不在本版中，`reminderScheduled` 始终为 false。

SDK：`client.tasks({query,status,offset,limit})`、`client.updateTask(input)`；对应 `GET/POST /api/v1/tasks`。使用当前仿真会话令牌，拒绝跨会话和管理员任务身份。版本冲突返回 409，重读后合并；管理员通过控制台编辑、报告完成和删除，管理操作不会产生模型阅读回执。切换范围后必须重新加载，界面不会把旧事项写到另一会话。

## 时效事实

本机 Haitang 适配器支持 `features: ["temporal-v1"]`。新版 setup 脚本会声明该能力；已有配置需在采用新版适配器后为对应 provider 增加该字段并重启 Bridge。其他提供者未声明时拒绝时间选项和时效写入，不假装插件已经实现历史查询。原六项权限和审批保持生效，不配置长期提供者时，任务记忆可单独使用。

`qq_memory write` 使用稳定新 ID，通过 `metadata.temporal` 保存：

```json
{
  "id": "temporary-100-v1",
  "text": "本周在出差，回复可能较慢",
  "category": "temporary",
  "subject": "234",
  "metadata": {
    "temporal": {
      "validFrom": null,
      "validTo": null,
      "eventAt": null,
      "timeZone": "Asia/Shanghai",
      "precision": "unknown",
      "originalTimeText": "本周",
      "assertionType": "reported",
      "sources": ["qq:100"]
    }
  }
}
```

实际使用时按原消息的时间和明确时区解析“本周”，填入有依据的毫秒时间范围；未知时间保留 null，不以本示例的未知区间伪装已解析。`precision` 为 `instant/calendar-day/range/unknown`，`assertionType` 为 `reported/inferred`。来源必须是当前会话模型实际见过的消息，机器人自述不能独自支持时效写入。`eventAt` 如果填写，须与实际来源字段一致。

有效区间使用 `[validFrom, validTo)`；无端点表示该端点未知或未限定。`expiresAt` 继续表示普通查询的隐藏期限，`validTo` 表示事实停止成立，`dueAt` 表示任务截止，三者分别处理。期限结束后不能继续断言原状态仍成立，也不能反向编造新状态。没有期限的稳定偏好不强加短期过期规则。

纠正或改期使用新 ID 与 `metadata.temporal.supersedes=旧ID`，指定新值 `validFrom`，保持主体和类别一致。Haitang 在一次写入中保存新记录并关闭旧区间；保留旧事实，拒绝覆盖/普通 update 修改时效历史，重复相同写入不刷新原始时间。不要将既有时效记录降级成普通文本覆盖。需要再次纠正时引用最新版本；删除新版本不会让已关闭的旧事实恢复为当前值。

默认 query 返回当前有效值。查历史使用 `options: {temporal: {mode: "history"}}`，查过去某时刻再加 `at` 毫秒时间戳。历史模式能返回仍在存储中的过期记录，继续受相同会话权限和预算约束；不表示已经被物理清理的内容可以恢复。Haitang 在检索排名和分页之前应用时间筛选。控制台提供当前/历史切换、主体与文本查询、分页、来源和有效期展示；时效记录的纠正通过有来源的记忆工具执行，控制台不做无证据的原地覆盖。

## 本地自动匹配与时间依据

Bridge 对已经获准的提供者读写结果建立短期、只读的本地投影，按本轮来信匹配最多 3 条、约 2000 字符时效事实。投影最多保留 5 分钟，读取不续期；程序重启后从空投影开始，长期事实仍在提供者中。投影未命中时，Agent 可使用现有记忆工具主动查询核验。普通读取/等待/唤醒不会为了本地匹配额外向提供者发送聊天片段，也不增加独立模型调用。

任何已授权变更开始时先清空对应投影；超时或结果未知不继续使用旧投影。在途查询不能覆盖较新的变更代次。事实有效期、来源删除、权限撤销与工具开关仍在使用时检查。直接绕过 Bridge 修改插件存储可能使投影在最多 5 分钟内落后，必要时通过记忆工具重新查询。投影仅是提示，应核对最新来源；时间排序不等于事实正确性。

新原文保留 `eventAt`（网关事件时间，未知为 null）和 `receivedAt`（接收时间）；兼容字段 `time` 仍为接收时间。`qq_time_resolve` 用原消息 `eventAt` 解析相对日历日期；缺失时可用接收时间但必须标明估计。该工具不解析钟点或模糊的“晚上”，也不创建调度。

## 来源与删除

唤醒、unread、recent、wait、工作记忆读取统一登记实际展示来源，返回规范 `messages.id`。一次参与 decision 确认自上次 decision 以来实际交付的消息批次；来源引用集合另行保留，历史摘要来源不会仅因被引用就冒充新交付。会话退役或重启后阅读回执失效，必须重新读取。

长消息积压优先保留最早待处理来源，保证在无新消息时持续推进；`evictedPending` 统计容量淘汰的未处理原文，不能将其称作已理解。结构化条目有稳定 ID，未变化条目保留证据/更新时间。confirmed 用户事实拒绝仅由机器人自述支持；这仍不能替代模型对转述、引用、玩笑和主体的正确理解。

`discardMessageIds` 立即撤销来源和媒体回执，持久记录删除标记，清除依赖该来源的本地任务并过滤时效召回。来源自然淘汰与主动清除分别处理。来源删除后整个相关任务会被清除，当前实现采用保守策略，尚不支持按字段保留独立证据。长期插件原始文件、DSH 历史、日志和备份不会随该操作物理擦除；提供者中的时效项会被 Bridge 隐藏，物理删除仍走提供者删除操作。

## 验证

```sh
npm run test:memory:lifecycle
npm run test:memory:temporal-provider
npm run test:memory:tasks-ui
npm run test:working-memory
npm run test:memory
npm run test:participation
```

时效适配器测试需要 Haitang 源码，可用 `HAITANG_SOURCE` 指定隔离的上游目录；没有时明确 skip。界面测试使用既有 `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 环境变量。测试仅用合成数据、隔离网关和临时状态，不向真实 QQ 发消息。自然语言的事项识别、指代与接话质量仍需部署后评估。
