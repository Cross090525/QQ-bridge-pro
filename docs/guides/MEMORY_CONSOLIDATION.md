# 记忆候选与可靠写入

二代仿真模式可以把已读消息中值得长期保留的普通事实先存成本地候选，再通过提供者写入并核验。Agent 负责提取和判断语义，Bridge 校验来源、会话、版本与写入状态。候选独立于最多 500 条工作原文的保留窗口，重启后仍可继续处理。

## 启用

升级 Bridge、MCP 和二代 preset 后，使用新版 Haitang 适配器，并在对应提供者的 `features` 增加 `consolidation-v1`。已有 `temporal-v1` 应一并保留。新版 Haitang 安装脚本会声明这两个能力。重启 Bridge 和 DSH，让配置与工具生效。

```json
{"features": ["temporal-v1", "consolidation-v1"]}
```

同时需要启用工作记忆和 `memory` 工具。候选提交与核验分别使用现有 `memory-write` 和 `memory-query` 权限，继续遵循 automatic、ask、deny 与一次性审批规则。提供者须支持读写。第三方适配器实现下述协议后才能声明新能力。

控制台的「二代仿真模式 → 记忆候选与写入核验」可以分页查看候选、来源片段和状态，提交、核验、拒绝或清理已结束的本地记录。管理端查看不会生成模型阅读回执。清理本地记录会移除该候选的去重依据，长期提供者中的事实通过现有 delete/clear 管理。

## Agent 操作

每批阅读后及时检查重要信息。先用 `qq_memory query` 按主体和类别查重，再调用 `qq_memory_consolidate`。所有标识示例均为合成值。

`stage` 的 input 如下。

```json
{
  "text": "偏好清淡饮食",
  "subject": "234",
  "category": "preference",
  "assertion": "self_report",
  "sources": [{"id": "qq:100", "quote": "喜欢清淡"}]
}
```

`subject` 使用该主体实际来信的 `userId`。`self_report` 表示本人明确自述，`inferred` 表示根据本人来信推断，仍需保留不确定性。本版只接受主体本人的实际来信依据。候选最多 1000 字符，1 至 5 条来源，每条引用最多 300 字符，必须能在已展示来源的保留原文中逐字核对。机器人自述、争论输出、只有摘要而无原文的来源不能创建事实候选。凭据与本机路径特征会被拦截，保存内容仍需由 Agent 判断必要性。

引用片段保存在本机 `state/memory-consolidation/`，提供者收到归纳事实、来源编号、内容哈希、发言人和时间。已经验证的候选可以在原文滚出窗口后继续提交。候选重复检查按提供者、主体、类别、陈述类型、规范化文本和纠错目标进行，语义近似的去重仍由 Agent 查询后判断。

`stage` 返回候选 `id` 和 `revision`，后续操作均携带最新值。

1. `commit` 提交固定内容和稳定事实 ID。执行前持久化 `writing`。
2. 收到写入响应后进入 `unknown`，再调用 `verify` 精确查询该 ID。
3. 内容指纹一致才成为 `applied`。首次写入尚未核验成功且核验历史明确的候选，精确查询确认为缺失时回到 `pending`，随后可再次 `commit`。曾经核验成功的记录后来消失，进入 `conflict` 等待核对，避免用写入重试恢复已被删除的记忆。旧版候选缺少历史核验标记时，缺失结果也进入冲突核对。内容不同同样进入 `conflict`，重读并调查后决定拒绝或另建纠错。
4. `approval_required` 表示请求尚待执行。在现有权限面板批准后，携带返回的 `approval.approval.requestId` 作为 `input.approvalId` 重试相同操作。核验本身也可能需要审批。

超时、响应无效或进程在 `writing` 阶段中断都进入 `unknown`，应先核验。相同稳定 ID 的完全相同重试由适配器处理为无变化。409 表示版本或状态冲突，应先 `read` 获取当前候选。`read` 支持 `status/offset/limit`，每页最多 20 条。`reject` 适用于 pending、approval_required 和 conflict。结果未知须先核验。

普通读取、等待与唤醒会附带最多 3 条待维护候选摘要，以及待处理数量，标为 `historical=true`、`replyEligible=false`、`contextRole=reference-only`。这些内容供维护记忆使用，当前来信仍决定是否发言。

SDK 提供 `client.memoryCandidates(params)` 和 `client.consolidateMemory(operation, input)`，公开接口为 `GET/POST /api/v1/memory/consolidation`。POST 使用 `{operation,input}`，会话由现有令牌绑定。管理员使用控制台管理接口，候选提取需要 Agent 的实际来源阅读凭据。

## 纠错与提供者协议

声明 `consolidation-v1` 的提供者查询结果会由 Bridge 附加 `recordHash`。纠错先读取最新旧记录，再 stage 新候选，额外传入 `supersedes=旧ID` 与 `expectedHash=旧recordHash`。新旧主体和类别必须一致。本版普通候选纠错用于普通事实，时效记录沿用 `temporal-v1` 的有效区间纠错流程。

适配器在一次原子写入中核对旧记录指纹，保存新记录，并在旧记录的 `metadata.qqBridgeConsolidationState.supersededBy` 标记后继。并发修改、旧值已被替代、主体或类别不一致时拒绝提交。普通 write/update 不能覆盖受管理记录。删除新值后，旧值继续保留已被替代状态。

管理记录的 `metadata.qqBridgeConsolidation` 包含 version、candidateId、assertion、sources，以及可选 supersedes/expectedHash。来源只包含 id、hash、userId、eventAt、receivedAt。qqBridgeConsolidationState 由适配器生成。Bridge 校验写入与已暂存候选完全一致，并沿用提供者权限校验。Haitang 和示例提供者均实现该协议。

默认 query 在分页前过滤被替代的记录。`options.consolidation.history=true` 显示所有仍在存储中的历史记录，包括过期记录。核验使用 `options.consolidation={id:目标ID,history:true}`，适配器必须精确筛选后分页，结果缺失才可表示不存在。历史完整查询与时效按时间查询分别使用对应选项。

通过 Bridge 发起提供者变更时，只将可能受影响的既有 applied 候选转为待核验。带 ID 的 write 检查该 ID 和纠错目标，update/delete 按原记录匹配 selector，clear 按类别或整个会话处理。无 ID 的 write 保守覆盖同主体、同类别，ingest 按整个会话处理。在途精确核验也遵循相同失效范围，受影响的晚到结果会被撤销。直接修改插件存储后，可在管理界面手动核验。

## 候选维护与归档

自动上下文轮转选择最多三条待维护候选，包含需要重新核验的归档记录。在成功投递或返回给模型后推进轮转，重复构建预览与投递失败会保留当前顺序。轮转只影响展示顺序，整理回执与模型来源阅读凭据分别管理。进程重启后重新开始轮转。

管理员可以在控制台归档 applied、rejected 或 invalidated 条目。归档清理本地短引用，保留归纳记录、稳定 ID、来源指纹和去重指纹。归档后仍可核验，也参与 sourceProgress 和去重。提供者记录与本地归档通过同一会话与提供者关联。来源删除后，归档同样失效并清除事实文本。

GET 的 `archived=true` 可以分页读取归档，默认读取活动区。SDK 使用 `client.memoryCandidates({archived:true})`，Agent 的 read input 也接受 archived 布尔值。手动 archive 与 remove 使用管理端身份。活动区满时，新候选可以在一次原子保存中把一条已结束记录移入归档，再新增候选。

## 保存与删除

每会话的活动区最多 100 个未结束候选、200 个总条目，另有最多 1000 条有界归档。归档记录受变更影响时，也可以进入待核验状态。容量满时明确报错，由管理员整理，待处理事项继续保留。旧版 version 1 文件缺少 archive 时按空归档读取。损坏的候选文件会保留并拒绝覆盖。旧长期记忆沿用原有格式读取，升级无需批量重写。

删除工作来源时，关联候选失效，本地引用片段与事实文本清除，晚到结果不能恢复候选。提供者查询会按删除来源过滤这些记录。提供者中的物理记录仍需使用现有 delete/clear 删除，备份也需按实际保留策略管理。

已经提取的候选具有持久化保障。Agent 尚未识别的重要信息仍可能随着原文窗口淘汰，需要结合后续整理质量评估继续改进。时效事实与任务事项的使用见相关指南。[时效与任务记忆](TEMPORAL_TASK_MEMORY.md)

## 验证

`npm run test:memory:consolidation` 覆盖原文淘汰后恢复、来源校验、审批、重启、超时、精确核验、并发、容量、来源删除、受保护纠错和 HTTP/SDK。安装了 Haitang 上游时也运行真实适配器测试。`npm run test:memory:consolidation-ui` 使用隔离服务和无头浏览器检查管理操作、分页、范围切换与文本转义。

`npm run test:memory:maintenance` 覆盖精确失效、在途核验、候选轮转、归档及其容量、去重和来源删除，以及工作记忆的独立整理进度。
