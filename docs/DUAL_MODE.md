# 单实例双模式

此分支在 v0.2.0-r4 上增加固定的会话路由：授权群和普通授权私聊使用二代仿真，管理员本人私聊使用指定的完整工具预设。一个 SnowLuma、一个 bridge、一个 DSH 服务即可运行。

功能默认关闭；未配置 `dualMode` 的旧部署继续使用原来的全局模式。

## 配置

在现有 `config.json` 中增加以下字段，保留其他连接和鉴权配置：

```json
{
  "ownerQQ": "你的管理员QQ号",
  "dualMode": {
    "enabled": true,
    "ownerPreset": "standard",
    "ownerPrompt": "你是我的私人任务助手，使用中文，优先完成明确的任务。"
  }
}
```

这是字段示意，不能把它整体替换为完整配置。`ownerQQ` 必须是真实、有效的数字QQ号，`ownerPreset` 必须是 DSH 中实际存在的预设。群聊仍使用 `socialV2.agentPreset`（默认 `qq-chat-v2`），必须是带 QQ 工具守卫的安全预设。

- `enabled` 只接受布尔值，不接受字符串 `"true"`。
- 管理员私聊单独准入，无需再加入 `allow.private`；若在 `deny.private` 中则拒绝。
- 其他私聊和群聊仍遵循 deny/allow/allowAllWhenEmpty，不因双模式自动开放。
- 管理员在群里发言仍是群聊仿真；不会根据发送者切换完整工具。
- 管理员预设必须与仿真预设不同。双模式下两种预设都不允许悄悄回退为 DSH 默认预设。
- 双模式的管理员身份以 bridge 配置为准，不由 DSH `qq-mode` 设置覆盖。

第一次升级先确认 QQ 预设与 MCP 已安装（必要时运行 `node scripts/setup-dsh.mjs`），然后**重启 DSH 和 bridge**。本分支为三个旧只读 QQ 工具增加可选 token 参数，必须重启 DSH 刷新 MCP 工具 schema。以后只修改 `dualMode` 或 ownerPrompt，需要重启 bridge；不是热读整个 config.json。

Linux 用户服务示例（沿用部署已有的服务名）：

```sh
systemctl --user restart dsh.service
systemctl --user restart qq-bridge.service
journalctl --user -u qq-bridge.service -n 80 --no-pager
```

## 共用与隔离

共用 QQ 登录、DSH 服务、模型供应商/密钥、控制台和用量账本。每个群或私聊使用独立 DSH 会话及工作目录；默认位于 `state/agents/group-<ID>`、`state/agents/private-<ID>`。如果配置了 `sessionCwd`，它作为这些独立子目录的父目录。

群聊角色和黑话不注入管理员任务；管理员使用 `ownerPreset` 和 `ownerPrompt`。设置全局群聊角色仍然影响仿真会话，不会把该角色注入管理员任务。

管理员拥有完整工具预设并不等于运行在操作系统沙箱中：实际执行权限仍是 DSH 服务账户的权限。

## 调用身份与发送

管理员任务与仿真会话分别绑定令牌和策略。管理员的会话令牌在投递任务时注入，桥接重启后重新签发，不持久化。模型调用 `qq_send_private_message`、`qq_get_message_images` 等工具时必须携带 token。

桥接会验证令牌属于当前会话，且会话、预设、管理员、模型选择等策略没有失效；HTTP 请求体读取、排队发送和异步响应都需要保留原调用身份，不能在等待后借用新会话权限。

第一版的 QQ 发送/图片工具限制为调用方自己的会话。管理员任务结果自动回本人私聊；不能拿管理员私聊token直接调用发送工具往群里发结果。需要跨群发送时应单独设计明确授权流程。管理员旧只读工具可以使用其 token 读取原白名单允许的群资料，但不能借此修改群会话。

“暂停二代 AI”只暂停仿真，管理员任务仍可响应。需要停全部任务时停止 bridge 和 DSH 服务；已经提交到QQ网关的消息或已经发生的本机操作不能撤回。

## 控制台与持久化

- 状态接口增加 `dualMode` 和 `conversationModes`，仅管理端获得完整路由信息。
- 双模式启用后，控制台显示双模式状态，并禁用全局模式/preset切换；`/api/mode` 返回409，避免把单一全局按钮误当成按会话路由配置。
- `config.json` 是固定路由的配置来源；`state/conversation-policies.json` 是带版本的派生快照，仅供诊断，不是可手改的授权文件。即使快照被删除或修改，也按可信配置重新生成。
- 会话映射继续保存在 `state/sessions.json`。策略指纹使用摘要，避免把认证密钥或完整提示词写进策略字段。
- 首次从旧单模式启用双模式，旧映射会因策略不同而退役、停止并归档；新建各自的会话，旧聊天上下文不自动合并。工作文件原目录保留。
- 改管理员或管理员提示只更新相关任务会话；移除群白名单不影响管理员任务。共享模型配置变化会使相关会话重建。

## 验证

```sh
npm ci
npm run test:dual
npm run test:audit
```

专项测试覆盖真实桥接函数与本地HTTP端点，使用假QQ/DSH，包含并发预设/工作区、人格隔离、跨会话令牌、权限撤销、排队发送、旧指令、预设缺失等检查。完整audit包含专项测试；部分旧测试需要本机DSH安装、ffmpeg或Windows符号链接权限。

在目标 Ubuntu 上仍需完成：一个受控群聊正常仿真；管理员私聊运行一个无副作用的本机只读工具；两者并行时群工具限制不变；提问和审批正确回到管理员；重启后路由一致。离线测试不替代这些真实联调。

## 升级与回退

1. 停止现有 bridge，备份现有源码版本、`config.json`、`state/` 和必要的 DSH 配置。保管含凭据文件，不提交到Git。
2. 在原部署路径更新此分支源码，执行 `npm ci`，保留原配置，在原文件中添加 `dualMode` 字段。
3. 确认预设和MCP，按上文重启DSH/bridge，在受控会话验证后再恢复其他群。
4. 回退时先停止bridge，把 `dualMode.enabled` 改为false，再启动旧版本或本分支的旧模式。新快照不是旧版读取的模式配置；原 `state/mode.json` / DSH 全局模式设置仍决定旧模式。
5. 新旧版本策略格式不同，回退时会重建受影响会话。不要同时运行新旧bridge。

本分支不包含视频插件接入，也不自动升级依赖或更换QQ账号。
