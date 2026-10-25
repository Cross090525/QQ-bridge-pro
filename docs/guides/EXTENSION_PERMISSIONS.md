# 扩展授权与一次性审批

本版已把权限闸门接入 framework 托管的 MCP / HTTP / skill runner 调用，以及媒体读取、上传接口。未匹配授权规则时默认拒绝；注册服务不自动开放。管理员私聊不继承其他会话的授权。

记忆模块也已整体接入：memory.<providerId>.<operation> 是独立能力，新增 memory-query / memory-write / history-export 数据范围，所有变更仍逐次审批，详见 [开放记忆提供者](MEMORY_PROVIDERS.md)。

控制台“二代仿真 → MCP / skills 授权与审批”可加载/修改规则、审阅具体请求、批准一次、拒绝/撤销与查看审计。修改策略立即生效并撤销旧审批和运行中的权限租约，不需要重启。注册服务与修改服务清单仍需重启。

## 配置与数据范围

```json
{
  "framework": {
    "permissions": {
      "rules": [
        {
          "key": "group:456",
          "capability": "bilibili.inspect",
          "decision": "ask",
          "dataScopes": ["source-reference"],
          "maxCallsPerMinute": 3,
          "maxCallsPerHour": 30,
          "maxInputChars": 2000
        }
      ]
    }
  }
}
```

以上群号与服务名必须改为真实部署值。key、capability 均要求准确值，不支持通配符。有效 decision 为 deny / ask / allow；同一会话与能力存在 deny 时拒绝，其他重复规则也拒绝，避免合并造成权限意外扩大。

| 数据范围 | 授权的内容 |
|---|---|
| source-reference | 向服务传递当前会话收到的 sourceId、消息 ID、可用时的链接/平台 |
| source-bytes | 读取当前会话来源的媒体字节并交给该服务；与 reference 独立授权 |
| input | Agent 按服务 schema 填写的任务参数或合成文字 |
| media-upload | 上传受大小/格式约束的媒体到当前会话临时库 |

例如 ASR bytes 服务需要 source-bytes；TTS 需要 input。附加非空 input 的视频调用需要 source-reference 与 input。数据范围限制传递入口，不是文字语义追踪：授权 input 的服务可能收到 Agent 放进该字段的文字。不要对不受信的服务授予 input，也不能据此声称框架能自动识别并阻止所有聊天内容外传。

服务本身应声明 effect：read / generate / write / execute。未声明按 execute 处理，write / execute 即使配置 allow 仍转为 ask。read / generate 只有明确规则才可以自动执行；“只读”不代表无成本或不外传。

服务 inputSchema 是有意收窄的平面字段协议，不是完整 JSON Schema：

```json
{
  "id": "voice.synthesize",
  "effect": "generate",
  "inputSchema": {
    "properties": {
      "text": { "type": "string", "maxLength": 1000 },
      "voice": { "type": "string", "enum": ["default", "soft"] }
    },
    "required": ["text"]
  }
}
```

省略 inputSchema 只接受空对象。最多 16 个字段，类型支持 string / number / boolean，可声明 maxLength 与 enum；拒绝未知字段、对象/数组、非有限数字和超限字符串。inputHint 仍只是说明，不授予参数权限。服务参数映射与固定命令、tool、URL 均来自管理员配置，Agent 无法改动。

## 审批流程

1. Agent 调用 qq_process_content。权限为 ask 时返回 HTTP 202 和 `status: "approval_required"`，没有启动 MCP、连接服务或下载媒体。
2. 管理员在控制台加载审批，查看会话、能力、effect、实际 input、来源链接/消息 ID、执行入口、目标与次数限制，选择“批准这一次”或“拒绝 / 撤销”。所有字段按不可信纯文本显示。
3. 批准不立即执行。Agent 用完全相同的参数，加上 `approvalId = approval.requestId` 重试一次。可以在当前会话告诉 Agent 继续；不要用群聊里的“同意”充当审批，也不要让 Agent 反复轮询。
4. 许可在执行前原子消费，失败、超时也不恢复，不能自动重放。重复原请求会被阻断；请求到期清理后才可重新申请，或者由管理员调整策略。

```js
const pending = await client.processContent('bilibili.inspect', { sourceId });
// 管理员通过独立控制台批准后，由原会话执行：
const result = await client.processContent('bilibili.inspect', {
  sourceId,
  approvalId: pending.approval.requestId
});
```

绑定范围为当前会话租约、策略修订、服务配置摘要、来源记录和规范化 input 摘要。任何参数、来源记录或服务配置变化都不能复用原许可。批准前重新核验会话；执行后重新核验权限，阻止暂停、撤权或修改策略后的晚到结果。策略修改会使缓存不能继续使用。

绑定的是来源引用和元数据，不是远程 URL 将来返回的字节内容，也不校验磁盘上的第三方程序二进制。管理员应固定服务版本并在更新后重启/重新授权。已运行服务的外部副作用无法保证撤销。

默认审批有效期为申请起 5 分钟；重启不恢复审批，过期墓碑再保留最多 5 分钟防重放。全局最多 128 个在册请求，每会话最多 8 个待审批/已批准请求。待审批 input 最多 64000 字符；大媒体上传应使用经过审阅的明确 allow，或缩小请求。审批明细仅在内存且有界保留；不会写入审计文件。

## 媒体与输出

`bridge.media.read` 是独立的 read 能力，需要 source-bytes；GET `/api/v1/media/read` 可用 approvalId 查询参数重试。服务获得 source-bytes 不意味着客户端也可以直接下载。

`bridge.media.upload` 是独立的 generate 能力，需要 media-upload；POST `/api/v1/media/upload` 可携带 approvalId。上传请求的 data/mimeType 都绑定审批；上传不等于发送。大上传需提高该规则的 maxInputChars，最多 12000000，仍受原有 8MB 单媒体和 12MB HTTP 体积上限约束。

QQ 输出继续由原有会话目标、工具开关、暂停/静默、语音开关、发送额度和审计管理；服务执行权限不会扩大 QQ 发送目标。本版没有给所有旧 QQ 工具重新增加逐次审批，不应宣称旧转发读取/搜索等已经归入本套扩展授权。

## 管理接口与审计

以下路由仅接受控制台身份（x-console-token），没有公开 v1 别名。任何携带 x-agent-token 或 x-agent-call 的请求，即使同时携带正确控制台令牌，也不能管理授权或审批：

| 方法 | 路由 | 作用 |
|---|---|---|
| GET / POST | /api/extensions/permissions | 获取 / 替换规则并保存 config.json |
| GET | /api/extensions/approvals | 审阅请求与当前状态 |
| POST | /api/extensions/approvals/resolve | `{requestId,decision:"approve"或"deny"}` |
| GET | /api/extensions/audit | 查看有界权限审计 |

审计保存于 state/extension-audit.json，最多 500 项、写入时保留最近 7 天。记录会话、能力、请求摘要、决策、启动/完成/失败/撤销/缓存等事件，不写原始 input、媒体字节或服务密钥。审计损坏或不可写时扩展执行拒绝，不静默跳过审计。

额度默认每能力每会话 6 次/分钟、60 次/小时；最多可配 60/分钟、1000/小时。缓存命中和失败执行也计数，申请审批不计执行数但受队列上限约束。计数在本进程内保存，重启会重置，不是账单级费用控制；第三方模型费用、内部调用次数仍需提供者自身设置上限。

## MCP、skills 与迁移

外部 MCP/skills 统一通过固定的 framework.services 入口调用。skill runner 必须作为受信服务接入，只能执行已配置入口；其内部动作无法被 bridge 逐项观察时，应按最高副作用声明为 execute 并逐次审批。skill 文本与模型理由均不能提供授权。

仿真预设的非空或格式错误的 allowedMcpTools 会使执行守卫拒绝全部工具调用，防止直接调用绕过审批，也避免抛出初始化错误导致守卫根本未安装；删除旧配置、把能力迁移到 framework.services 并重启 DSH 后恢复。独立外部客户端的 SDK 示例仍可用于受信宿主，但完整会话令牌不是第三方最小权限凭据，不要交给不受信 runner。

本版约束框架托管的扩展入口，不是整个 DSH 的操作系统沙箱。管理员 standard preset 自带的本地/外部工具、旧 QQ 内置工具以及第三方服务内部网络/文件访问，仍由各自宿主控制。细粒度扩展凭据、可信用户意图绑定、skill 子步骤代理和系统级隔离仍属于后续工作。

`npm run test:permissions` 验证默认拒绝、审批重试/重放、跨群隔离、管理员隔离、策略/来源/服务变化、缓存与额度、超时撤权和原始媒体入口；使用模拟 QQ/DSH 与真实本机 stdio/HTTP。
